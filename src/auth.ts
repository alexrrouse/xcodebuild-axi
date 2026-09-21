import { AxiError } from "./errors.js";
import { getFlag } from "./args.js";

/**
 * App Store Connect authentication, shared by `archive` and `export`.
 *
 * xcodebuild wants three separate flags and fails late — after a full archive
 * — if only some are present. Validating the trio up front turns a wasted
 * ten-minute build into an immediate usage error.
 */

export const AUTH_FLAGS = [
  "--auth-key-path",
  "--auth-key-id",
  "--auth-key-issuer",
  "--allow-device-registration",
] as const;

export const AUTH_VALUE_FLAGS = [
  "--auth-key-path",
  "--auth-key-id",
  "--auth-key-issuer",
] as const;

export const AUTH_FLAG_HELP = `  --auth-key-path <path>  App Store Connect API key (.p8); requires the two flags below
  --auth-key-id <id>      key identifier for that key
  --auth-key-issuer <id>  issuer identifier for that key
  --allow-device-registration  let xcodebuild register the destination device on the portal`;

export function authArgs(args: string[], command: string): string[] {
  const path = getFlag(args, "--auth-key-path");
  const id = getFlag(args, "--auth-key-id");
  const issuer = getFlag(args, "--auth-key-issuer");

  const given = [path, id, issuer].filter(
    (value) => value !== undefined,
  ).length;
  if (given > 0 && given < 3) {
    throw new AxiError(
      "App Store Connect auth needs all three of --auth-key-path, --auth-key-id, and --auth-key-issuer",
      "VALIDATION_ERROR",
      [
        `xcodebuild-axi ${command} --auth-key-path <path> --auth-key-id <id> --auth-key-issuer <id>`,
      ],
    );
  }

  return [
    ...(path && id && issuer
      ? [
          "-authenticationKeyPath",
          path,
          "-authenticationKeyID",
          id,
          "-authenticationKeyIssuerID",
          issuer,
        ]
      : []),
    ...(args.includes("--allow-device-registration")
      ? ["-allowProvisioningDeviceRegistration"]
      : []),
  ];
}
