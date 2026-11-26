import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";

// Chloe's feedback on the dashboard visit card (26 Nov 2026), proved on the REAL components through react-dom/server
// (the repo has no @testing-library), one block per point. The browser runs prove layout; this proves the markup.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, prefetch: () => undefined }),
  usePathname: () => "/dashboard",
}));
vi.mock("@/app/(app)/appointment-mark-complete-actions", () => ({ markAppointmentCompleteAction: async () => ({ ok: true }) }));
vi.mock("@/app/(app)/clients/[id]/pinned-notes-actions", () => ({
  addClientPinnedNoteAction: async () => undefined,
  editClientPinnedNoteAction: async () => undefined,
}));
vi.mock("@/app/(app)/dashboard/prep-memory-actions", () => ({ loadAppointmentPrepMemory: async () => ({ status: "none" }) }));

const { renderToStaticMarkup } = await import("react-dom/server");
const { NextSessionReminder, VISIT_ACTION_CLASS, VisitActionRow } = await import("@/app/(app)/dashboard/visit-actions");
const { DashboardQuickPin } = await import("@/app/(app)/dashboard/dashboard-quick-pin");
const { DashboardTreatmentMemory } = await import("@/app/(app)/dashboard/dashboard-treatment-memory");
const { CheckoutButton } = await import("@/components/checkout-button");
const { MarkAppointmentCompleteControl } = await import("@/components/appointment/mark-complete-control");

const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
const tags = (html: string, re: RegExp) => html.match(re) ?? [];

function actionRow(checkout: ReturnType<typeof createElement> | null, over: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(VisitActionRow, {
      checkout,
      rebookHref: "/calendar?rebook=1",
      chartHref: "/clients/c1/sessions/s1",
      nextAction: { href: "/clients/c1", label: "Open client" },
      consultation: { href: "/clients/c1?tab=treatment", label: "Consultation notes" },
      intake: { href: "/clients/c1/intake/i1", label: "Review intake" },
      ...over,
    }),
  );
}

describe("1. ONE action row, one size", () => {
  const checkoutControl = createElement(MarkAppointmentCompleteControl, {
    appointmentId: "a1",
    startsAt: "2020-01-01T10:00:00Z",
    buttonClassName: VISIT_ACTION_CLASS,
    checkout: { visitLabel: "x", onCompleted: () => undefined, onOpen: () => undefined },
  });

  it("Checkout, Rebook, Chart, Open client, Consultation notes and Review intake are all in ONE group", () => {
    const html = actionRow(checkoutControl);
    expect(html.match(/data-testid="today-row-actions"/g)).toHaveLength(1);
    for (const id of ["today-rebook", "today-chart", "today-next-action", "today-consultation-notes", "today-review-intake"]) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain("Checkout");
    // The group wraps inside itself on a phone instead of scattering.
    expect(attr(html.slice(0, html.indexOf(">") + 1), "class")).toMatch(/\bflex\b.*\bflex-wrap\b/);
  });

  it("every action, Checkout included, wears the SAME class (same size, no oversized primary)", () => {
    const html = actionRow(checkoutControl);
    const buttons = tags(html, /<(a|button)\b[^>]*>/g).filter(t => /today-|mark-appointment-complete/.test(t));
    expect(buttons).toHaveLength(6);
    // PendingLink only prepends `relative` (the pending overlay's positioning context); the look itself is identical.
    for (const tag of buttons) expect(attr(tag, "class").replace(/^relative /, ""), tag).toBe(VISIT_ACTION_CLASS);
    // The shared compact size: 12px type, 32px box on a precise pointer, 44px on touch. No dark primary fill, no 14px type.
    expect(VISIT_ACTION_CLASS).toMatch(/text-xs/);
    expect(VISIT_ACTION_CLASS).toMatch(/pointer-fine:min-h-8/);
    expect(VISIT_ACTION_CLASS).not.toMatch(/bg-neutral-900|text-sm/);
  });

  it("a completed visit's Checkout button (CheckoutButton) matches the other actions too", () => {
    const html = actionRow(createElement(CheckoutButton, { appointmentId: "a1", status: "completed", className: VISIT_ACTION_CLASS }));
    const checkout = tags(html, /<button\b[^>]*data-testid="checkout-button"[^>]*>/g)[0];
    expect(attr(checkout!, "class")).toBe(VISIT_ACTION_CLASS);
  });

  it("only the actions that are available render, in the same group", () => {
    const html = actionRow(null, { chartHref: null, nextAction: null, intake: null });
    expect(html).toContain("today-rebook");
    expect(html).toContain("today-consultation-notes");
    for (const id of ["today-chart", "today-next-action", "today-review-intake", "checkout"]) expect(html).not.toContain(id);
    expect(html.match(/data-testid="today-row-actions"/g)).toHaveLength(1);
  });
});

describe("2. Pinned notes stay YELLOW, editable, with Add pinned note", () => {
  const html = renderToStaticMarkup(
    createElement(DashboardQuickPin, {
      clientId: "c1",
      clientName: "Ada Synthetic",
      pinnedNotes: [{ id: "p1", text: "Allergic to latex", created_by_practitioner_id: "me" }],
      viewer: { isOwner: true, practitionerId: "me" },
    }),
  );
  it("keeps the amber box and never turns blue", () => {
    expect(html).toContain("bg-amber-50");
    expect(html).toContain("border-amber-300");
    expect(html).toContain("Allergic to latex");
    expect(html).not.toMatch(/bg-blue-50|border-blue-200/);
  });
  it("keeps inline editing and the Add pinned note control", () => {
    expect(html).toContain('aria-label="Add pinned note for Ada Synthetic"');
    expect(html).toContain("+ Add pinned note");
    expect(html).toContain('aria-label="Edit pinned note for Ada Synthetic: Allergic to latex"');
  });
});

describe("3. From last visit, for today: its own BLUE box", () => {
  const html = renderToStaticMarkup(createElement(NextSessionReminder, { note: "Start on the left side\nAsk about the cream" }));
  it("is blue, titled, and carries the private note in full", () => {
    expect(html).toContain("From last visit, for today");
    expect(html).toContain("border-blue-200 bg-blue-50");
    expect(html).toContain("Start on the left side\nAsk about the cream");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).not.toMatch(/amber/);
  });
  it("is a separate box from the pinned notes", () => {
    const pins = renderToStaticMarkup(
      createElement(DashboardQuickPin, {
        clientId: "c1", clientName: "Ada", pinnedNotes: [{ id: "p1", text: "P", created_by_practitioner_id: "me" }],
        viewer: { isOwner: true, practitionerId: "me" },
      }),
    );
    expect(pins).not.toContain("From last visit");
    expect(html).not.toContain("Pinned");
  });
});

describe("4. Last visit details are ON the card by default", () => {
  const html = renderToStaticMarkup(
    createElement(DashboardTreatmentMemory, {
      appointmentId: "a1",
      clientId: "c1",
      clientName: "Ada Synthetic",
      timeZone: "America/Toronto",
      summary: { hasTreatment: true, unavailable: false, compactSummary: "x" } as never,
    }),
  );
  it("renders OPEN with no click: expanded, region visible, content mounted", () => {
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-testid="dashboard-memory-full"');
    expect(html).not.toMatch(/id="[^"]*"[^>]*\bhidden\b/);
  });
  it("keeps the open / close control as a secondary Hide button", () => {
    expect(html).toContain("Hide last visit details");
    // The accessible name stays constant; aria-expanded carries the state.
    expect(html).toContain('aria-label="Last visit details for Ada Synthetic"');
  });
});
