import { describe, expect, it } from "vitest";
import {
  fakeResendModeForRecipient,
  fakeResendModeFromEnv,
  isE2eFakeResendEnabled,
  assertFakeResendNotRequestedInDeployment,
} from "@/lib/email/e2e-fake-resend";

// Defect 4 — per-recipient fake-Resend mode control. A single E2E server run
// exercises every send outcome by seeding studios whose owner_email local-part
// is mode-prefixed. These unit tests pin the parsing + the fail-closed guards
// (the deployment refusal + the enable gate are the same posture as fake-Stripe).

// The functions take a NodeJS.ProcessEnv; build partial envs without NODE_ENV.
const env = (o: Record<string, string>): NodeJS.ProcessEnv =>
  o as unknown as NodeJS.ProcessEnv;

describe("fakeResendModeForRecipient — prefix parsing", () => {
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

describe("the HOST default, and the precedence around it", () => {
  // RESCHEDULE-E2E-01. Arming the fake for a whole lane changes what every
  // recipient that asks for nothing gets. The browser lane therefore sets a
  // DEFAULT of `reject`, reproducing what the dummy Resend key used to produce
  // for every send; three specs had silently lost their degraded-path scenario
  // when the fallback was `success`, and none of them went red, because each
  // asserts what is absent on a refusal -- also absent on success.

  it("applies the host default when the recipient asks for nothing", () => {
    expect(
      fakeResendModeForRecipient(
        "e2e-client-1@harness.local",
        env({ HONE_E2E_FAKE_RESEND_DEFAULT_MODE: "reject" }),
      ),
    ).toBe("reject");
  });

  it("a recipient PREFIX still wins over the host default", () => {
    // The property the lane depends on: a spec that needs acceptance can opt in
    // while every other recipient keeps the host default. If the default won
    // here, per-recipient control would be dead and B1 could not exist.
    expect(
      fakeResendModeForRecipient(
        "success+abc@harness.local",
        env({ HONE_E2E_FAKE_RESEND_DEFAULT_MODE: "reject" }),
      ),
    ).toBe("success");
  });

  it("the global FORCE still wins over both", () => {
    expect(
      fakeResendModeForRecipient(
        "success+abc@harness.local",
        env({
          HONE_E2E_FAKE_RESEND_MODE: "throw",
          HONE_E2E_FAKE_RESEND_DEFAULT_MODE: "reject",
        }),
      ),
    ).toBe("throw");
  });

  it("an invalid host default is ignored, falling back to success", () => {
    expect(
      fakeResendModeForRecipient(
        "e2e-client-1@harness.local",
        env({ HONE_E2E_FAKE_RESEND_DEFAULT_MODE: "nonsense" }),
      ),
    ).toBe("success");
  });

  it("the LIBRARY default is unchanged, so non-lane consumers are unaffected", () => {
    expect(fakeResendModeForRecipient("e2e-client-1@harness.local", env({}))).toBe(
      "success",
    );
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
