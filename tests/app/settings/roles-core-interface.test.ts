import { readFileSync } from "node:fs";
import { validateEdits } from "@/lib/settings/roles/validate";
import { CATALOG } from "@/lib/permissions/catalog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRowError,
  reasonAcceptable,
  reasonRequired,
  roleErrorMessage,
  ROLE_ERROR_CODES,
} from "@/lib/settings/roles/api";

// The page's side of the R1 interface agreed with Team (3 Nov): codes not text, a version bound to a preview, a reason that can be
// required per operation, only changed keys sent, the draft kept on every refusal, previews from the core and never recomputed here.

const owner = vi.hoisted(() => ({ role: "owner" }));
vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: vi.fn(async () => ({ practitioner: { role: owner.role }, studio: { id: "studio-1" } })),
}));
vi.mock("@/lib/settings/roles/policy-store", () => ({
  loadStudioPolicyState: vi.fn(async () => ({
    policy: { basis: "existing_snapshot", values: {}, gates: {} },
    reviewed: false,
    version: 0,
    writable: false,
    notWritableReason: "x",
  })),
}));

const actions = await import("@/app/(app)/settings/roles/actions");

beforeEach(() => {
  owner.role = "owner";
});

describe("reason rule (Sam, batch 4)", () => {
  it("is required for adopt, reset and a sensitive raise; optional otherwise", () => {
    expect(reasonRequired("adopt", false)).toBe(true);
    expect(reasonRequired("reset", false)).toBe(true);
    expect(reasonRequired("save", true)).toBe(true);
    expect(reasonRequired("save", false)).toBe(false);
  });
  it("rejects blank and placeholder-only text, and sets no character minimum", () => {
    for (const bad of ["", "   ", "...", "n/a", "N/A.", "none", "test", "asdf"]) expect(reasonAcceptable("adopt", false, bad), bad).toBe(false);
    expect(reasonAcceptable("adopt", false, "ok to go")).toBe(true);
    expect(reasonAcceptable("reset", false, "Hi")).toBe(true);
  });
  it("lets an optional reason be empty but still refuses a placeholder", () => {
    expect(reasonAcceptable("save", false, "")).toBe(true);
    expect(reasonAcceptable("save", false, "none")).toBe(false);
  });
  it("the editor asks why instead of enforcing a count", () => {
    const src = readFileSync("app/(app)/settings/roles/roles-editor.tsx", "utf8");
    expect(src).toContain("Why are you making this change?");
    expect(src).not.toMatch(/characters/);
  });
});

describe("error codes", () => {
  it("has a message for every code and points a per-key code at its row", () => {
    for (const code of ROLE_ERROR_CODES) expect(roleErrorMessage({ code }).length).toBeGreaterThan(5);
    expect(isRowError({ code: "prerequisite_unmet", key: "pay.refund", role: "practitioner" })).toBe(true);
    expect(isRowError({ code: "stale_version", currentVersion: 4 })).toBe(false);
    expect(isRowError({ code: "prerequisite_unmet" })).toBe(false);
  });
});

describe("actions answer with codes and never claim success before the core is on", () => {
  it("refuse a non-owner everywhere", async () => {
    owner.role = "practitioner";
    for (const r of [
      await actions.previewRoleChangesAction({}),
      await actions.previewResetAction("practitioner"),
      await actions.previewAdoptAction(),
      await actions.saveRolePolicyAction({}, 0, false, "a reason"),
      await actions.resetRolePolicyAction("practitioner", 0, "a reason"),
      await actions.adoptNewDefaultsAction(0, "a reason"),
    ])
      expect(r).toEqual({ ok: false, error: { code: "refused" } });
  });
  it("answer stale_version with the current version before anything else", async () => {
    expect(await actions.saveRolePolicyAction({ practitioner: {} }, 7, false, "")).toEqual({ ok: false, error: { code: "stale_version", currentVersion: 0 } });
    expect(await actions.adoptNewDefaultsAction(7, "")).toEqual({ ok: false, error: { code: "stale_version", currentVersion: 0 } });
  });
  it("require a reason for adopt and reset, and for a sensitive save", async () => {
    expect(await actions.adoptNewDefaultsAction(0, "n/a")).toEqual({ ok: false, error: { code: "reason_required" } });
    expect(await actions.resetRolePolicyAction("receptionist", 0, "")).toEqual({ ok: false, error: { code: "reason_required" } });
    expect(await actions.saveRolePolicyAction({ practitioner: {} }, 0, true, "")).toEqual({ ok: false, error: { code: "reason_required" } });
  });
  it("answer unavailable (not ok) for previews and valid writes while the core is off", async () => {
    expect(await actions.previewAdoptAction()).toEqual({ ok: false, error: { code: "unavailable" } });
    expect(await actions.previewResetAction("practitioner")).toEqual({ ok: false, error: { code: "unavailable" } });
    expect(await actions.adoptNewDefaultsAction(0, "a good reason")).toEqual({ ok: false, error: { code: "unavailable" } });
    const snapshot = { basis: "existing_snapshot" as const, values: {}, gates: {} };
    const real = CATALOG.map((d) => ({ practitioner: { [d.key]: "off" } })).find(
      (e) => validateEdits(e, { practitioner: snapshot, receptionist: snapshot }).ok,
    );
    expect(real, "some key must be editable").toBeDefined();
    expect(await actions.saveRolePolicyAction(real, 0, false, "")).toEqual({ ok: false, error: { code: "unavailable" } });
  });
  it("answer nothing_changed for an empty edit set", async () => {
    expect(await actions.saveRolePolicyAction({ practitioner: {} }, 0, false, "")).toEqual({ ok: false, error: { code: "nothing_changed" } });
  });
  it("refuse an unknown role", async () => {
    expect((await actions.resetRolePolicyAction("owner", 0, "a good reason")).ok).toBe(false);
  });
});

describe("history", () => {
  it("is owner-only and honest about the core being off", async () => {
    expect(await actions.listPermissionAuditAction(null)).toEqual({ ok: false, error: { code: "unavailable" } });
    owner.role = "practitioner";
    expect(await actions.listPermissionAuditAction(null)).toEqual({ ok: false, error: { code: "refused" } });
  });
  it("renders rows from the core with resolved names, and a removed member as a former member", () => {
    const src = readFileSync("app/(app)/settings/roles/roles-editor.tsx", "utf8");
    expect(src).toContain("props.loadHistory");
    expect(src).toContain('r.personState === "removed" ? "former member"');
    expect(src).not.toMatch(/\.email/);
  });
});

describe("the editor", () => {
  const src = readFileSync("app/(app)/settings/roles/roles-editor.tsx", "utf8");
  it("never recomputes a diff on the client", () => {
    expect(src).not.toMatch(/diffPolicies|defaultsPolicy/);
  });
  it("runs every preview through the core's preview calls", () => {
    expect(src).toContain("props.previewSave(changedEdits())");
    expect(src).toContain("props.previewAdopt()");
    expect(src).toContain("props.previewReset(role)");
  });
  it("saves only changed keys at the version the preview returned", () => {
    expect(src).toMatch(/props\.save\(changedEdits\(\), reviewData\.version, confirmed, reason\.trim\(\)\)/);
    expect(src).toContain("if (saved[r].values[k] !== v) e[k] = v");
  });
  it("keeps the draft on every refusal", () => {
    const handler = src.slice(src.indexOf("function handleError"), src.indexOf("async function onReview"));
    expect(handler).not.toMatch(/setDrafts|setSaved/);
  });
});
