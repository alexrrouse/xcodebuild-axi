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
 * Build a minimal export options plist.
 *
 * `-exportArchive` requires one, and authoring XML by hand is exactly the kind
 * of unguessable side quest an agent fails at. Given a method (and optionally
 * a team), the plist is derivable, so derive it.
 */
export function exportOptionsPlist(options: {
  method: string;
  teamID?: string;
  signingStyle?: string;
  uploadSymbols?: boolean;
}): string {
  const entries: string[] = [
    `  <key>method</key>\n  <string>${options.method}</string>`,
  ];
  if (options.teamID) {
    entries.push(`  <key>teamID</key>\n  <string>${options.teamID}</string>`);
  }
  if (options.signingStyle) {
    entries.push(
      `  <key>signingStyle</key>\n  <string>${options.signingStyle}</string>`,
    );
  }
  if (options.uploadSymbols !== undefined) {
    entries.push(`  <key>uploadSymbols</key>\n  <${options.uploadSymbols}/>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries.join("\n")}
</dict>
</plist>
`;
}
