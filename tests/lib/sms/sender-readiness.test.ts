import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  destinationReadiness,
  READINESS_LABELS,
  studioSenderReadiness,
  type UsRegistrationEvidence,
} from "@/lib/sms/sender-readiness";
import type { SenderRead, StudioSmsSenderState } from "@/lib/sms/sender-status";
import { SmsSenderReadinessPanel } from "@/app/(app)/settings/integrations/SmsSenderReadinessPanel";

// SMS-SENDER-READY-01: per-destination readiness of a studio's OWN sender.

const NOT_RECORDED: UsRegistrationEvidence = { state: "not_recorded" };

function row(over: Partial<StudioSmsSenderState>): SenderRead {
  return {
    ok: true,
    sender: {
      id: "s1",
      studio_id: "studio-1",
      provider: "twilio",
      status: "active",
      country: null,
      requested_area_code: null,
      phone_number: "+14165550123",
      provisioned_at: "2026-10-01T00:00:00Z",
      last_test_ok_at: null,
      last_error_code: null,
      last_error_at: null,
      released_at: null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
      ...over,
    },
  };
}

const states = (read: SenderRead, reg: UsRegistrationEvidence = NOT_RECORDED) =>
  studioSenderReadiness(read, reg).map((r) => `${r.destination}:${r.state}`);

describe("before there is a studio sender", () => {
  it("a read that did not answer is Unavailable, never Not configured", () => {
    expect(states({ ok: false })).toEqual(["CA:unavailable", "US:unavailable"]);
  });

  it("no row, off, or released: Not configured, with support as the next step", () => {
    for (const read of [{ ok: true, sender: null } as SenderRead, row({ status: "off" }), row({ status: "released" })]) {
      const [ca, us] = studioSenderReadiness(read, NOT_RECORDED);
      expect([ca.state, us.state]).toEqual(["not_configured", "not_configured"]);
      expect(ca.actor).toBe("support");
    }
  });

  it("setup in progress is Pending; suspended is Suspended; a failed setup is Failed", () => {
    expect(states(row({ status: "selecting" }))).toEqual(["CA:pending", "US:pending"]);
    expect(states(row({ status: "provisioning" }))).toEqual(["CA:pending", "US:pending"]);
    expect(states(row({ status: "releasing" }))).toEqual(["CA:pending", "US:pending"]);
    expect(states(row({ status: "suspended" }))).toEqual(["CA:suspended", "US:suspended"]);
    expect(states(row({ status: "error", last_error_code: "provider_timeout" }))).toEqual(["CA:failed", "US:failed"]);
    expect(destinationReadiness("CA", row({ status: "error", last_error_code: "provider_timeout" }), NOT_RECORDED).nextAction).toMatch(/Retry/);
    expect(destinationReadiness("CA", row({ status: "error", last_error_code: "provider_rejected" }), NOT_RECORDED).nextAction).not.toMatch(/Retry/);
  });
});

describe("an ACTIVE Canadian number", () => {
  it("serves Canadian recipients; US recipients need a US-registered sender, which a Canadian number never is", () => {
    for (const reg of [NOT_RECORDED, { state: "approved" } as UsRegistrationEvidence]) {
      const [ca, us] = studioSenderReadiness(row({ phone_number: "+16045550123" }), reg);
      expect(ca).toMatchObject({ state: "active", senderCountry: "CA" });
      expect(us).toMatchObject({ state: "requires_information", senderCountry: "CA" });
      expect(us.detail).toMatch(/10DLC|toll-free/);
    }
  });
});

describe("an ACTIVE US number", () => {
  const us = row({ phone_number: "+12125550123" });

  it("with NO recorded registration (every studio today): Requires information for both destinations", () => {
    const [caR, usR] = studioSenderReadiness(us, NOT_RECORDED);
    expect([caR.state, usR.state]).toEqual(["requires_information", "requires_information"]);
    expect(usR.detail).toMatch(/not registered by itself/);
  });

  it("follows the registration evidence, and only APPROVED is Active", () => {
    const expected: Array<[UsRegistrationEvidence, string]> = [
      [{ state: "pending" }, "pending"],
      [{ state: "requires_information", missing: "a campaign description" }, "requires_information"],
      [{ state: "approved" }, "active"],
      [{ state: "rejected" }, "failed"],
      [{ state: "suspended" }, "suspended"],
    ];
    for (const [reg, state] of expected) {
      expect(destinationReadiness("US", us, reg).state, reg.state).toBe(state);
    }
    expect(destinationReadiness("US", us, { state: "requires_information", missing: "a campaign description" }).detail).toContain("a campaign description");
  });

  it("a toll-free number is held to toll-free verification", () => {
    const tf = destinationReadiness("US", row({ phone_number: "+18885550123" }), NOT_RECORDED);
    expect(tf).toMatchObject({ state: "requires_information", senderCountry: "toll_free" });
    expect(tf.detail).toMatch(/toll-free verification/);
  });
});

describe("an ACTIVE sender whose number cannot be trusted", () => {
  it("a missing or malformed number is Failed, never Active", () => {
    expect(states(row({ phone_number: null }))).toEqual(["CA:failed", "US:failed"]);
    expect(states(row({ phone_number: "4165550123" }))).toEqual(["CA:failed", "US:failed"]);
  });

  it("a non-Canadian, non-US +1 number is not a supported sender", () => {
    expect(states(row({ phone_number: "+18765550123" }), { state: "approved" })).toEqual([
      "CA:requires_information",
      "US:requires_information",
    ]);
  });
});

describe("the panel", () => {
  it("states each destination in words, with the next action and who takes it", () => {
    const html = renderToStaticMarkup(
      createElement(SmsSenderReadinessPanel, { rows: studioSenderReadiness(row({ phone_number: "+16045550123" }), NOT_RECORDED) }),
    );
    expect(html).toContain('data-testid="sms-readiness-CA"');
    expect(html).toContain('data-readiness-state="active"');
    expect(html).toContain('data-testid="sms-readiness-US"');
    expect(html).toContain('data-readiness-state="requires_information"');
    expect(html).toContain("Canadian recipients");
    expect(html).toContain("US recipients");
    expect(html).toContain(READINESS_LABELS.requires_information);
    expect(html).toContain("(Hone support)");
    expect(html).not.toMatch(/<form|<button|action=/);
  });
});
