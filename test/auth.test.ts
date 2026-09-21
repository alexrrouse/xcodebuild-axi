import { describe, expect, it } from "vitest";
import { authArgs } from "../src/auth.js";
import { AxiError } from "../src/errors.js";

describe("authArgs", () => {
  it("passes nothing through when no auth flags are given", () => {
    expect(authArgs(["--scheme", "Tides"], "archive")).toEqual([]);
  });

  it("maps the full trio", () => {
    expect(
      authArgs(
        [
          "--auth-key-path",
          "/k.p8",
          "--auth-key-id",
          "ABC",
          "--auth-key-issuer",
          "XYZ",
        ],
        "archive",
      ),
    ).toEqual([
      "-authenticationKeyPath",
      "/k.p8",
      "-authenticationKeyID",
      "ABC",
      "-authenticationKeyIssuerID",
      "XYZ",
    ]);
  });

  it("rejects a partial trio before the archive runs", () => {
    expect(() => authArgs(["--auth-key-path", "/k.p8"], "archive")).toThrow(
      AxiError,
    );
    try {
      authArgs(["--auth-key-id", "ABC"], "export");
    } catch (error) {
      expect((error as AxiError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("allows device registration on its own", () => {
    expect(authArgs(["--allow-device-registration"], "archive")).toEqual([
      "-allowProvisioningDeviceRegistration",
    ]);
  });
});
