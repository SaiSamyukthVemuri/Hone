import { describe, expect, it } from "vitest";
import {
  fakeResendModeForRecipient,
  fakeResendModeFromEnv,
  isE2eFakeResendEnabled,
  assertFakeResendNotRequestedInDeployment,
} from "@/lib/email/e2e-fake-resend";

// Defect 4: per-recipient fake-Resend mode control. A single E2E server run
// exercises every send outcome by seeding studios whose owner_email local-part
// is mode-prefixed. These unit tests pin the parsing + the fail-closed guards
// (the deployment refusal + the enable gate are the same posture as fake-Stripe).

// The functions take a NodeJS.ProcessEnv; build partial envs without NODE_ENV.
const env = (o: Record<string, string>): NodeJS.ProcessEnv =>
  o as unknown as NodeJS.ProcessEnv;

describe("fakeResendModeForRecipient: prefix parsing", () => {
  const NO_ENV = env({});

  it("defaults to success for an ordinary address", () => {
    expect(fakeResendModeForRecipient("owner-123@harness.local", NO_ENV)).toBe(
      "success",
    );
  });

  it("maps the mode prefix before + to the mode", () => {
    expect(fakeResendModeForRecipient("reject+abc@harness.local", NO_ENV)).toBe(
      "reject",
    );
    expect(fakeResendModeForRecipient("throw+abc@harness.local", NO_ENV)).toBe(
      "throw",
    );
    expect(
      fakeResendModeForRecipient("failonce+abc@harness.local", NO_ENV),
    ).toBe("failonce");
    expect(fakeResendModeForRecipient("success+abc@harness.local", NO_ENV)).toBe(
      "success",
    );
  });

  it("is case-insensitive and ignores unknown prefixes", () => {
    expect(fakeResendModeForRecipient("REJECT+x@harness.local", NO_ENV)).toBe(
      "reject",
    );
    expect(fakeResendModeForRecipient("hello+x@harness.local", NO_ENV)).toBe(
      "success",
    );
  });

  it("a forcing env mode OVERRIDES the recipient prefix (unit-test posture)", () => {
    const forced = env({ HONE_E2E_FAKE_RESEND_MODE: "throw" });
    expect(fakeResendModeForRecipient("reject+x@harness.local", forced)).toBe(
      "throw",
    );
  });

  it("an invalid env mode is ignored (falls back to the prefix)", () => {
    const bad = env({ HONE_E2E_FAKE_RESEND_MODE: "nonsense" });
    expect(fakeResendModeForRecipient("reject+x@harness.local", bad)).toBe(
      "reject",
    );
    expect(fakeResendModeFromEnv(bad)).toBe("success");
  });
});

describe("fake-Resend fail-closed guards", () => {
  it("is disabled unless the explicit marker is set", () => {
    expect(isE2eFakeResendEnabled(env({}))).toBe(false);
    expect(isE2eFakeResendEnabled(env({ HONE_E2E_FAKE_RESEND: "1" }))).toBe(true);
  });

  it("REFUSES in a deployed runtime even if the marker is set", () => {
    const deployed = env({ HONE_E2E_FAKE_RESEND: "1", VERCEL: "1" });
    expect(() => assertFakeResendNotRequestedInDeployment(deployed)).toThrow(
      /never be set in a deployed environment/i,
    );
    // Disabled outright in a deployed runtime regardless.
    expect(isE2eFakeResendEnabled(deployed)).toBe(false);
  });
});
