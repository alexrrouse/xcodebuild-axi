import { execFile } from "node:child_process";
import { join } from "node:path";

/**
 * Read the summary Xcode writes into an .xcarchive's Info.plist.
 *
 * The interesting part is `ApplicationProperties` — the bundle identifier,
 * marketing version, and build number of the thing that was archived. An
 * agent that just produced an archive almost always wants those next, and
 * getting them otherwise means a second command against a plist inside a
 * bundle (AXI principle 4).
 */
export interface ArchiveInfo {
  bundleIdentifier?: string;
  marketingVersion?: string;
  buildNumber?: string;
  applicationPath?: string;
  name?: string;
  createdAt?: string;
}

interface RawArchivePlist {
  Name?: string;
  CreationDate?: string;
  ApplicationProperties?: {
    CFBundleIdentifier?: string;
    CFBundleShortVersionString?: string;
    CFBundleVersion?: string;
    ApplicationPath?: string;
  };
}

export function readArchiveInfo(
  archivePath: string,
): Promise<ArchiveInfo | undefined> {
  return new Promise((resolvePromise) => {
    execFile(
      "plutil",
      ["-convert", "json", "-o", "-", join(archivePath, "Info.plist")],
      { encoding: "utf-8" },
      (error, stdout) => {
        if (error) {
          resolvePromise(undefined);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as RawArchivePlist;
          const app = parsed.ApplicationProperties ?? {};
          resolvePromise({
            ...(parsed.Name !== undefined ? { name: parsed.Name } : {}),
            ...(parsed.CreationDate !== undefined
              ? { createdAt: parsed.CreationDate }
              : {}),
            ...(app.CFBundleIdentifier !== undefined
              ? { bundleIdentifier: app.CFBundleIdentifier }
              : {}),
            ...(app.CFBundleShortVersionString !== undefined
              ? { marketingVersion: app.CFBundleShortVersionString }
              : {}),
            ...(app.CFBundleVersion !== undefined
              ? { buildNumber: app.CFBundleVersion }
              : {}),
            ...(app.ApplicationPath !== undefined
              ? { applicationPath: app.ApplicationPath }
              : {}),
          });
        } catch {
          resolvePromise(undefined);
        }
      },
    );
  });
}

/** The `method` values Xcode 27 accepts in an export options plist. */
export const EXPORT_METHODS = [
  "app-store-connect",
  "release-testing",
  "enterprise",
  "debugging",
  "developer-id",
  "mac-application",
  "validation",
] as const;

/**
 * The names Xcode 26 and earlier used, which every existing pipeline and every
 * answer written before Xcode 27 still says. xcodebuild itself still accepts
 * them, so refusing them here would be this tool being stricter than the thing
 * it wraps.
 */
export const EXPORT_METHOD_ALIASES: Record<string, string> = {
  "app-store": "app-store-connect",
  "ad-hoc": "release-testing",
  development: "debugging",
};

/**
 * Every key `-exportOptionsPlist` accepts, and what it is for.
 *
 * The plist is the whole configuration surface of `-exportArchive`. A key with
 * no flag in front of it is a key that sends the agent back to authoring XML,
 * which is the side quest this file exists to remove.
 */
export interface ExportOptions {
  method: string;
  destination?: string;
  teamID?: string;
  signingStyle?: string;
  signingCertificate?: string;
  installerSigningCertificate?: string;
  /** Bundle identifier -> profile name or UUID, for manual signing. */
  provisioningProfiles?: Record<string, string>;
  distributionBundleIdentifier?: string;
  uploadSymbols?: boolean;
  stripSwiftSymbols?: boolean;
  manageAppVersionAndBuildNumber?: boolean;
  testFlightInternalTestingOnly?: boolean;
  generateAppStoreInformation?: boolean;
  iCloudContainerEnvironment?: string;
  thinning?: string;
  /** appURL, displayImageURL and fullSizeImageURL, for web distribution. */
  manifest?: Record<string, string>;
  embedOnDemandResourcesAssetPacksInBundle?: boolean;
  onDemandResourcesAssetPacksBaseURL?: string;
}

/**
 * The order keys are written in. Xcode does not care, but a generated file a
 * human may end up reading should group signing with signing.
 */
const EXPORT_OPTION_ORDER: Array<keyof ExportOptions> = [
  "method",
  "destination",
  "teamID",
  "signingStyle",
  "signingCertificate",
  "installerSigningCertificate",
  "provisioningProfiles",
  "distributionBundleIdentifier",
  "uploadSymbols",
  "stripSwiftSymbols",
  "manageAppVersionAndBuildNumber",
  "testFlightInternalTestingOnly",
  "generateAppStoreInformation",
  "iCloudContainerEnvironment",
  "thinning",
  "manifest",
  "embedOnDemandResourcesAssetPacksInBundle",
  "onDemandResourcesAssetPacksBaseURL",
];

/**
 * Build an export options plist.
 *
 * `-exportArchive` requires one, and authoring XML by hand is exactly the kind
 * of unguessable side quest an agent fails at. Given a method (and whatever
 * else was asked for), the plist is derivable, so derive it.
 */
export function exportOptionsPlist(options: ExportOptions): string {
  const entries = EXPORT_OPTION_ORDER.flatMap((key) => {
    const value = options[key];
    return value === undefined ? [] : [`  <key>${key}</key>\n${render(value)}`];
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries.join("\n")}
</dict>
</plist>
`;
}

function render(value: string | boolean | Record<string, string>): string {
  if (typeof value === "boolean") return `  <${value}/>`;
  if (typeof value === "string")
    return `  <string>${escapeXml(value)}</string>`;
  const inner = Object.entries(value)
    .map(
      ([key, entry]) =>
        `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(entry)}</string>`,
    )
    .join("\n");
  return `  <dict>\n${inner}\n  </dict>`;
}

/**
 * A manifest URL with a query string carries `&`, and an unescaped one makes
 * the plist unparseable -- which xcodebuild reports as a failed export rather
 * than as a bad file.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
