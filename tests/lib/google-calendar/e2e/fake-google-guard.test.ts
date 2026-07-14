import { describe, expect, it } from "vitest";
import {
  assertE2eFakeGoogleAllowed,
  assertFakeGoogleNotRequestedInDeployment,
  isE2eFakeGoogleEnabled,
  isValidE2eRunId,
} from "@/lib/google-calendar/e2e/fake-google-guard";

// Security guard for the fake Google provider: FAIL-CLOSED activation. The fake
// can activate ONLY with the explicit server-only markers AND no deployed-runtime
// signal — a combination impossible in any hosted environment.

const OK: NodeJS.ProcessEnv = {
  HONE_E2E_FAKE_GOOGLE: "1",
  HONE_E2E_RUN_ID: "run-abcdef123456",
} as unknown as NodeJS.ProcessEnv;

describe("isValidE2eRunId", () => {
  it("accepts a well-formed run id, rejects malformed/empty", () => {
    expect(isValidE2eRunId("run-abcdef123456")).toBe(true);
    expect(isValidE2eRunId("run-0")).toBe(false); // too short
    expect(isValidE2eRunId("bad id with spaces")).toBe(false);
    expect(isValidE2eRunId("")).toBe(false);
    expect(isValidE2eRunId(undefined)).toBe(false);
    expect(isValidE2eRunId(null)).toBe(false);
  });
});

describe("assertE2eFakeGoogleAllowed / isE2eFakeGoogleEnabled — fail-closed", () => {
  it("enabled ONLY with the flag + a valid run id + no deployed signal", () => {
    expect(isE2eFakeGoogleEnabled(OK)).toBe(true);
    expect(() => assertE2eFakeGoogleAllowed(OK)).not.toThrow();
  });

  it("NOT enabled when the explicit flag is absent (even with a valid run id)", () => {
    const env = { HONE_E2E_RUN_ID: "run-abcdef123456" } as unknown as NodeJS.ProcessEnv;
    expect(isE2eFakeGoogleEnabled(env)).toBe(false);
    expect(() => assertE2eFakeGoogleAllowed(env)).toThrow(/not enabled/i);
  });

  it("NOT enabled when the flag is not exactly '1'", () => {
    expect(isE2eFakeGoogleEnabled({ ...OK, HONE_E2E_FAKE_GOOGLE: "true" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isE2eFakeGoogleEnabled({ ...OK, HONE_E2E_FAKE_GOOGLE: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("NOT enabled when the run id is absent or invalid", () => {
    expect(isE2eFakeGoogleEnabled({ HONE_E2E_FAKE_GOOGLE: "1" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isE2eFakeGoogleEnabled({ HONE_E2E_FAKE_GOOGLE: "1", HONE_E2E_RUN_ID: "x" } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("NOT enabled in ANY deployed runtime, even with the flag + run id", () => {
    for (const signal of [
      { VERCEL: "1" },
      { VERCEL_ENV: "production" },
      { VERCEL_ENV: "preview" },
      { AWS_REGION: "us-east-1" },
      { AWS_EXECUTION_ENV: "AWS_ECS_FARGATE" },
      { KUBERNETES_SERVICE_HOST: "10.0.0.1" },
    ]) {
      const env = { ...OK, ...signal } as unknown as NodeJS.ProcessEnv;
      expect(isE2eFakeGoogleEnabled(env)).toBe(false);
      expect(() => assertE2eFakeGoogleAllowed(env)).toThrow(/deployed environment/i);
    }
  });

  it("NODE_ENV=production alone does NOT enable it (markers are the gate, not NODE_ENV)", () => {
    // The E2E server runs next start (NODE_ENV=production); NODE_ENV must neither
    // enable nor (by itself) block. Without the flag it stays OFF.
    expect(isE2eFakeGoogleEnabled({ NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    // With the markers + no deployed signal it is ON regardless of NODE_ENV.
    expect(isE2eFakeGoogleEnabled({ ...OK, NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("assertFakeGoogleNotRequestedInDeployment — fail-loud", () => {
  it("throws if the flag is set in a deployed environment", () => {
    expect(() =>
      assertFakeGoogleNotRequestedInDeployment({ HONE_E2E_FAKE_GOOGLE: "1", VERCEL: "1" } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/never be set in a deployed environment/i);
  });
  it("is a no-op when the flag is absent (i.e. always, in production)", () => {
    expect(() => assertFakeGoogleNotRequestedInDeployment({ VERCEL: "1" } as unknown as NodeJS.ProcessEnv)).not.toThrow();
  });
});
