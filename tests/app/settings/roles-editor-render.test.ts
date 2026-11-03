import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StudioPolicy } from "@/lib/permissions/catalog";

vi.mock("next/navigation", async (orig) => ({ ...(await orig<Record<string, unknown>>()), useRouter: () => ({ push: vi.fn() }) }));

const { RolesEditor } = await import("@/app/(app)/settings/roles/roles-editor");

const policy: StudioPolicy = { basis: "existing_snapshot", values: {}, gates: {} };
const people = [
  { id: "p1", name: "Chloe Owner", email: "owner@example.test", role: "owner" as const, state: "active" as const },
  { id: "p2", name: "Alex Practitioner", email: "alex@example.test", role: "practitioner" as const, state: "active" as const },
  { id: "i1", name: "Taylor Invitee", email: "taylor@example.test", role: "receptionist" as const, state: "invited" as const },
  { id: "d1", name: "Sam Former", email: "former@example.test", role: "practitioner" as const, state: "deactivated" as const },
];
const noop = async () => ({ ok: false as const, error: { code: "unavailable" as const } });
const render = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(RolesEditor, {
      policies: { practitioner: policy, receptionist: policy },
      reviewed: false,
      writable: false,
      notWritableReason: "Saving turns on with the permission core.",
      people,
      previewSave: noop,
      previewReset: noop,
      previewAdopt: noop,
      save: noop,
      reset: noop,
      adopt: noop,
      loadHistory: noop,
      ...over,
    }),
  );

describe("the Roles control center opens on People", () => {
  const html = render();
  it("lists real members under Active, Invitation pending and Deactivated", () => {
    for (const label of ["Active (2)", "Invitation pending (1)", "Deactivated (1)"]) expect(html).toContain(label);
    expect(html).toContain("Chloe Owner");
    expect(html).toContain("Taylor Invitee");
    expect(html).toContain("Sam Former");
    expect(html).toMatch(/data-people-state="invited"/);
  });
  it("starts on the People tab, with Permissions and History alongside", () => {
    expect(html).toMatch(/data-roles-view="people"[^>]*data-state="selected"|data-state="selected"[^>]*data-roles-view="people"/);
    expect(html).toContain('data-roles-view="permissions"');
    expect(html).toContain('data-roles-view="history"');
  });
  it("is read-only when saving is not available, and says so", () => {
    expect(html).toContain('data-testid="roles-read-only"');
  });
  it("shows the existing-studio banner and the release-time owner-only notice until reviewed, not after", () => {
    expect(html).toContain('data-testid="roles-review-banner"');
    expect(html).toContain('data-testid="release-narrowings-notice"');
    const after = render({ reviewed: true });
    expect(after).not.toContain('data-testid="roles-review-banner"');
    expect(after).not.toContain('data-testid="release-narrowings-notice"');
  });
  it("never renders a feed token, hash or sample person", () => {
    expect(html).not.toMatch(/token|hash/i);
    expect(html).not.toContain("Example");
  });
});

describe("batch 3 owner-only copy", () => {
  const html = render({ initialView: "permissions" });
  it("says recording an erasure request deletes nothing and erasure is not available yet", () => {
    expect(html).toContain("Recording a request deletes nothing; erasure is not available yet");
  });
  it("lists every workflow the portal-OFF confirmation affects and says intake and consent forms continue", () => {
    for (const w of ["Messaging clients", "Rebooking", "Saving a card", "Existing portal links and sessions"]) expect(html).toContain(w);
    expect(html).toContain("Intake and consent forms continue to work");
  });
  it("describes the booking-rules key as windows plus new-client rules, linking to studio details and service settings", () => {
    expect(html).toContain('data-testid="booking-rules-scope"');
    expect(html).toContain("booking window and the public new-client booking rules only");
    expect(html).toContain('href="/settings/studio/details"');
    expect(html).toContain('href="/settings/services"');
  });
});

describe("batch 4 page items", () => {
  const html = render({ initialView: "permissions" });
  it("explains the specific effect beside every studio-business setting the catalog labels so", async () => {
    const { CATALOG } = await import("@/lib/permissions/catalog");
    const { FUTURE_EFFECTS } = await import("@/lib/settings/roles/effects");
    for (const d of (CATALOG as readonly { key: string; affectsFutureStudioBusiness?: boolean }[]).filter((x) => x.affectsFutureStudioBusiness)) expect(FUTURE_EFFECTS[d.key], d.key).toBeTruthy();
    expect(html).toContain('data-testid="future-effect"');
  });
  it("shows the client directory as a fixed baseline, not a switch", () => {
    expect(html).toContain('data-testid="baseline-note"');
    expect(html).toContain("A fixed baseline, not a switch");
  });
  it("shows view-aftercare as its own row beside send", () => {
    expect(html).toMatch(/data-permission-row="clin\.view_aftercare"/);
    expect(html).toMatch(/data-permission-row="appt\.aftercare_send"/);
  });
});
