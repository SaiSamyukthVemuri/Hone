import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// HON-45 G1. An owner can record a payment received after "Still owes". Output-level
// proof through react-dom/server (the repo has no jsdom, so a click-through cannot run here;
// the command's own rules are covered by tests/db/appointment-settlement.db.test.ts).
// Synthetic ids only.

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/app/(app)/appointment-settlement-actions", () => ({
  recordAppointmentSettlementAction: async () => ({ ok: true }),
  waiveAppointmentFeeAction: async () => ({ ok: true }),
  supersedeAppointmentSettlementAction: async () => ({ ok: true }),
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { AppointmentSettlementControls } = await import("@/components/appointment-settlement-controls");
const { createElement } = await import("react");

const APPT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(AppointmentSettlementControls, { appointmentId: APPT, isOwner: false, ...props } as never) as ReactNode,
  );
}
const OWES = { settledMethod: "still_owes", settledId: SET, settledAmountCents: 15000 };

describe("who sees the control", () => {
  it("the owner sees it on a live 'Still owes' record, with the record still shown as Still owes", () => {
    const html = render({ ...OWES, isOwner: true });
    expect(html).toContain("settlement-received-open");
    expect(html).toContain("Record payment received");
    expect(html).toContain("Still owes");
    expect(html).toContain("Recorded by the studio, not verified by Hone.");
    expect(html).not.toMatch(/>Paid/);
  });
  it("a practitioner does not see it and is told to ask the owner", () => {
    const html = render({ ...OWES, isOwner: false });
    expect(html).not.toContain('data-testid="settlement-received"');
    expect(html).toContain("Ask the studio owner if this needs correcting.");
  });
  it("it is absent without the live record id (a failed read never targets a guess)", () => {
    expect(render({ ...OWES, settledId: null, isOwner: true })).not.toContain('data-testid="settlement-received"');
  });
  it("it is absent for every other recorded method (this is not a general edit)", () => {
    for (const m of ["paid_cash", "paid_e_transfer", "paid_other_external", "waived"]) {
      const html = render({ settledMethod: m, settledId: SET, settledAmountCents: 15000, isOwner: true });
      expect(html, m).not.toContain('data-testid="settlement-received"');
    }
  });
  it("an unsettled visit is unchanged: no correction control, the usual outcome buttons", () => {
    const html = render({ settledMethod: null, isOwner: true });
    expect(html).not.toContain('data-testid="settlement-received"');
    expect(html).toContain("settlement-open-still_owes");
  });
});

describe("wiring and source", () => {
  const read = (p: string) => readFileSync(path.join(__dirname, "../..", p), "utf8");
  it("the live record id reaches the controls from both sources", () => {
    expect(read("lib/billing/quick-checkout.ts")).toContain("settledId: live?.id ?? null");
    expect(read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx")).toContain("settledId={liveSettlement?.id ?? null}");
    expect(read("components/quick-checkout-modal.tsx").match(/settledId=\{ctx\.settlement\.settledId\}/g)?.length).toBe(2);
    expect(read("components/session-payment-prepare-card.tsx")).toContain("settledId={settledId}");
  });
  it("the form calls the existing supersede command with a required reason and only received methods", () => {
    const src = read("components/appointment-settlement-controls.tsx");
    expect(src).toContain("supersedeAppointmentSettlementAction(fd)");
    expect(src).toContain('fd.set("settlement_id", settledId)');
    expect(src).toContain('fd.set("reason", reason.trim())');
    expect(src).toContain('["paid_cash", "paid_e_transfer", "paid_other_external"]');
    const body = src.slice(src.indexOf("function ReceivedPaymentCorrection"), src.indexOf("function parseAmountToCents") > src.indexOf("function ReceivedPaymentCorrection") ? src.indexOf("function parseAmountToCents") : undefined);
    expect(body).not.toContain("waived");
    expect(body).not.toContain("still_owes");
  });
});
