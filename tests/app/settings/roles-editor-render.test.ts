import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CATALOG, type StudioPolicy } from "@/lib/permissions/catalog";

vi.mock("next/navigation", async (orig) => ({ ...(await orig<Record<string, unknown>>()), useRouter: () => ({ push: vi.fn() }) }));

const { RolesEditor } = await import("@/app/(app)/settings/roles/roles-editor");

const policy: StudioPolicy = { basis: "existing_snapshot", values: {}, gates: {} };
const people = [
  { id: "p1", name: "Chloe Owner", email: "owner@example.test", role: "owner" as const, state: "active" as const },
  { id: "p2", name: "Alex Practitioner", email: "alex@example.test", role: "practitioner" as const, state: "active" as const },
  { id: "i1", name: "Taylor Invitee", email: "taylor@example.test", role: "receptionist" as const, state: "invited" as const },
  { id: "d1", name: "Sam Former", email: "former@example.test", role: "practitioner" as const, state: "deactivated" as const },
];
// Enforcement is catalog truth (#1341's TypeScript catalog), so these tests set it on the entry for the duration of one render and put it back.
const withEnforcement = <T,>(map: Record<string, unknown>, fn: () => T): T => {
  const saved = new Map<string, unknown>();
  for (const [k, v] of Object.entries(map)) {
    const d = CATALOG.find((x) => x.key === k) as { enforcement?: unknown } | undefined;
    if (!d) throw new Error(`no catalog key ${k}`);
    saved.set(k, d.enforcement);
    d.enforcement = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) (CATALOG.find((x) => x.key === k) as { enforcement?: unknown }).enforcement = v;
  }
};
const noop = async () => ({ ok: false as const, error: { code: "unavailable" as const } });
const render = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(RolesEditor, {
      policies: { practitioner: policy, receptionist: policy },
      reviewed: false,
      writable: false,
      notWritableReason: "Saving turns on with the permission core.",
      staffRoleChange: false,
      people,
      timezone: "America/Toronto",
      previewSave: noop,
      previewReset: noop,
      previewAdopt: noop,
      save: noop,
      reset: noop,
      adopt: noop,
      previewActivation: noop,
      activate: noop,
      loadHistory: noop,
      loadAccess: noop,
      changeRole: noop,
      reload: noop,
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

describe("only enforced keys are editable (OPS decision 3 Nov)", () => {
  const row = (html: string, key: string) => html.split(`data-permission-row="${key}"`)[1]?.split("data-permission-row=")[0] ?? "";
  it("says at the top of Permissions what this release enforces", () => {
    const html = render({ initialView: "permissions" });
    expect(html).toContain('data-testid="enforcement-scope"');
    expect(html).toContain("Enforced in the app once you activate them: appointments, clinical viewing, photos, availability; other areas are shown for planning.");
  });
  it("fails SAFE: a key with no enforcement in the catalog reads Not enforced yet", () => {
    const r = row(withEnforcement({ "appt.move": undefined }, () => render({ initialView: "permissions" })), "appt.move");
    expect(r).toContain("Not enforced yet. This setting does nothing today, and it will not switch on by itself when that area is wired.");
    expect(r).toMatch(/<fieldset[^>]*disabled/);
  });
  it("an enforced key has no such line and its fieldset is not disabled by it; observe and not_yet say Not enforced yet", () => {
    const html = withEnforcement({ "appt.move": "enforced", "appt.book": "observe", "appt.cancel": "not_yet" }, () =>
      render({ initialView: "permissions", writable: true, notWritableReason: null }),
    );
    expect(row(html, "appt.move")).not.toContain("Not enforced yet");
    expect(row(html, "appt.move")).not.toMatch(/<fieldset[^>]*disabled/);
    for (const k of ["appt.book", "appt.cancel"]) {
      expect(row(html, k)).toContain("Not enforced yet");
      expect(row(html, k)).toMatch(/<fieldset[^>]*disabled/);
    }
  });
  it("an unrecognised value is treated as not enforced", () => {
    const html = withEnforcement({ "appt.move": "yes" }, () => render({ initialView: "permissions", writable: true, notWritableReason: null }));
    expect(row(html, "appt.move")).toContain("Not enforced yet");
  });
});

describe("change_staff_role stays unavailable while its gate is off", () => {
  it("shows 'Change role: not available yet' on active non-owner people, with no control", () => {
    const html = render();
    expect(html).toContain("Change role: not available yet.");
    expect(html).toContain('data-testid="change-role-unavailable"');
    expect(html.split('data-person="p1"')[1].split("data-person=")[0]).not.toContain("change-role-unavailable");
  });
  it("hides the line once the gate is satisfied", () => {
    expect(render({ staffRoleChange: true })).not.toContain("change-role-unavailable");
  });
});

describe("deny_only keys can be turned down now and not widened", () => {
  const row = (html: string, key: string) => html.split(`data-permission-row="${key}"`)[1]?.split("data-permission-row=")[0] ?? "";
  const html = withEnforcement({ "appt.book": "deny_only", "appt.move": "enforced" }, () => render({ initialView: "permissions", writable: true, notWritableReason: null }));
  it("keeps the fieldset live, says widening is later, and disables only the options above the baseline", () => {
    const r = row(html, "appt.book");
    expect(r).not.toMatch(/<fieldset[^>]*disabled/);
    expect(r).toContain('data-testid="deny-only-note"');
    expect(r).toContain("Widening arrives in a later release.");
  });
  it("an enforced key has no deny-only note", () => {
    expect(row(html, "appt.move")).not.toContain("deny-only-note");
  });
});

describe("NQ-10: an inactive-by-prerequisite row says so on the page", () => {
  const row = (html: string, key: string) => html.split(`data-permission-row="${key}"`)[1]?.split("data-permission-row=")[0] ?? "";
  it("shows 'Inactive: needs ...' on the edit row and keeps the chosen scope selected", () => {
    const off: StudioPolicy = { basis: "existing_snapshot", values: { "clin.view_records": "off", "clin.edit_records": "studio" }, gates: {} };
    const html = withEnforcement({ "clin.edit_records": "enforced", "clin.view_records": "enforced" }, () =>
      render({ initialView: "permissions", writable: true, notWritableReason: null, policies: { practitioner: off, receptionist: off } }),
    );
    const r = row(html, "clin.edit_records");
    expect(r).toContain('data-testid="inactive-because"');
    expect(r).toContain("Inactive: needs View clinical records.");
    expect(r).toContain("Your choice is kept");
    expect(r).not.toContain("Chosen but not in force");
  });
});

describe("Codex P1 (r4468128665): a saved Off the core is not enforcing yet says so on the page", () => {
  const row = (html: string, key: string) => html.split(`data-permission-row="${key}"`)[1]?.split("data-permission-row=")[0] ?? "";
  const VIEW = "clin.view_records";
  const withServer = (source: string, effective: "off" | "own" | "studio") => {
    const p = {
      basis: "existing_snapshot" as const,
      values: { [VIEW]: "off" as const },
      gates: {},
      server: { stored: { [VIEW]: "off" as const }, effective: { [VIEW]: effective }, source: { [VIEW]: source } },
    };
    return withEnforcement({ [VIEW]: "enforced" }, () =>
      render({ initialView: "permissions", writable: true, notWritableReason: null, policies: { practitioner: p, receptionist: p } }),
    );
  };
  it("a key not released yet: Off is saved, practitioners still have access, and the row says so", () => {
    const r = row(withServer("unreleased", "studio"), VIEW);
    expect(r).toContain('data-testid="inactive-because"');
    expect(r).toMatch(/Saved, but not in force yet\. Until this setting is released and you activate it, practitioners keep: /);
  });
  it("a released key awaiting the owner's activation says the same", () => {
    const r = row(withServer("inactive_until_activated", "studio"), VIEW);
    expect(r).toContain('data-testid="inactive-because"');
    expect(r).toContain("practitioners keep: ");
  });
  it("control: an Off that IS in force (stored, effective off) shows no such line", () => {
    const r = row(withServer("stored", "off"), VIEW);
    expect(r).not.toContain('data-testid="inactive-because"');
    expect(r).not.toContain("not in force yet");
  });
});
