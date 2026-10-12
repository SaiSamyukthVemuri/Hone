import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  DESTINATION_RULES,
  destinationReadiness,
  NOT_HIPAA_COVERAGE,
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

// THE MATRIX, cell by cell (Twilio documentation, checked 2026-10-12):
// A2P 10DLC is for long-code traffic TO THE US, Canadian and US long codes
// alike; toll-free verification is for the US and Canada.
describe("the destination matrix (Codex P2 4244008035, 4244008038)", () => {
  const SENDERS = { CA: "+16045550123", US: "+12125550123", toll_free: "+18885550123" } as const;
  const EXPECTED = {
    CA: { CA: "none", US: "a2p_10dlc" },
    US: { CA: "none", US: "a2p_10dlc" },
    toll_free: { CA: "toll_free_verification", US: "toll_free_verification" },
  } as const;
  const STATES: Array<[UsRegistrationEvidence, string]> = [
    [NOT_RECORDED, "requires_information"],
    [{ state: "pending" }, "pending"],
    [{ state: "requires_information", missing: "a sample message" }, "requires_information"],
    [{ state: "approved" }, "active"],
    [{ state: "rejected" }, "failed"],
    [{ state: "suspended" }, "suspended"],
    [{ state: "unreadable" } as unknown as UsRegistrationEvidence, "unavailable"],
  ];

  it("is exactly the documented table", () => {
    expect(DESTINATION_RULES).toEqual(EXPECTED);
  });

  for (const [kind, phone] of Object.entries(SENDERS) as Array<[keyof typeof SENDERS, string]>) {
    for (const destination of ["CA", "US"] as const) {
      const rule = EXPECTED[kind][destination];
      it(`${kind} sender -> ${destination} recipients: ${rule}`, () => {
        for (const [evidence, ifRequired] of STATES) {
          if ((evidence as { state: string }).state === "unreadable") continue;
          const r = destinationReadiness(destination, row({ phone_number: phone }), evidence);
          expect(r.senderCountry).toBe(kind);
          // No registration needed: Active whatever the evidence says.
          expect(r.state, `${evidence.state}`).toBe(rule === "none" ? "active" : ifRequired);
        }
      });
    }
  }

  it("a registered Canadian long code serves US recipients; unregistered, it does not", () => {
    expect(destinationReadiness("US", row({ phone_number: SENDERS.CA }), { state: "approved" }).state).toBe("active");
    const unregistered = destinationReadiness("US", row({ phone_number: SENDERS.CA }), NOT_RECORDED);
    expect(unregistered.state).toBe("requires_information");
    expect(unregistered.detail).toMatch(/A2P 10DLC/);
    expect(unregistered.detail).toMatch(/not registered by itself/);
  });

  it("a US long code needs no 10DLC for Canadian recipients", () => {
    expect(destinationReadiness("CA", row({ phone_number: SENDERS.US }), NOT_RECORDED)).toMatchObject({ state: "active", senderCountry: "US" });
  });

  it("a toll-free number needs verification for BOTH destinations", () => {
    for (const d of ["CA", "US"] as const) {
      const r = destinationReadiness(d, row({ phone_number: SENDERS.toll_free }), NOT_RECORDED);
      expect(r.state).toBe("requires_information");
      expect(r.detail).toMatch(/toll-free verification/);
    }
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
    // Never a HIPAA statement (#828).
    expect(html).toContain(NOT_HIPAA_COVERAGE);
  });
});
