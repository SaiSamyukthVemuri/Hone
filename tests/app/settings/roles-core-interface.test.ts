import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRowError,
  reasonAcceptable,
  reasonRequired,
  roleErrorMessage,
  ROLE_ERROR_CODES,
} from "@/lib/settings/roles/api";
import { parseAccess, parseCommand, parseError, parseHistory, parsePreview, parseState } from "@/lib/settings/roles/core-parse";

// The page's side of the R1 interface (0287, agreed with Team 3 Nov): codes not text, a version bound to a preview, a reason required per
// operation, only changed keys sent, the draft kept on every refusal, previews from the core and never recomputed here.

const owner = vi.hoisted(() => ({ role: "owner" }));
const core = vi.hoisted(() => ({
  coreSave: vi.fn(async () => ({ ok: true, newVersion: 5 })),
  coreReset: vi.fn(async () => ({ ok: true, newVersion: 5 })),
  coreAdopt: vi.fn(async () => ({ ok: true, newVersion: 5 })),
  corePreviewChanges: vi.fn(async () => ({ ok: false, error: { code: "nothing_changed" } })),
  corePreviewReset: vi.fn(async () => ({ ok: false, error: { code: "nothing_changed" } })),
  corePreviewAdopt: vi.fn(async () => ({ ok: false, error: { code: "nothing_changed" } })),
  coreHistory: vi.fn(async () => ({ ok: true, rows: [], next: null })),
  coreAccess: vi.fn(async () => ({ ok: false, error: { code: "not_found" } })),
}));
vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: vi.fn(async () => ({ practitioner: { role: owner.role }, studio: { id: "studio-1" } })),
}));
vi.mock("@/lib/settings/roles/core", () => core);

const actions = await import("@/app/(app)/settings/roles/actions");

beforeEach(() => {
  owner.role = "owner";
  for (const f of Object.values(core)) f.mockClear();
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
  });
  it("every code the migration can return is a code the page knows", () => {
    const sql = readFileSync("supabase/migrations/0287_roles_permission_engine.sql", "utf8");
    const used = new Set([...sql.matchAll(/perm_fail\('([a-z_]+)'/g)].map((m) => m[1]));
    for (const code of used) expect(ROLE_ERROR_CODES as readonly string[], code).toContain(code);
  });
});

describe("the actions hand the core only what the owner changed, after re-checking the owner", () => {
  it("refuse a non-owner everywhere without calling the core", async () => {
    owner.role = "practitioner";
    for (const r of [
      await actions.previewRoleChangesAction({}),
      await actions.previewResetAction("practitioner"),
      await actions.previewAdoptAction(),
      await actions.saveRolePolicyAction({ practitioner: { "appt.move": "studio" } }, 0, false, ""),
      await actions.resetRolePolicyAction("practitioner", 0, "a reason"),
      await actions.adoptNewDefaultsAction(0, "a reason"),
      await actions.listPermissionAuditAction(null),
      await actions.effectiveAccessAction("m1"),
    ])
      expect(r).toEqual({ ok: false, error: { code: "refused" } });
    for (const f of Object.values(core)) expect(f).not.toHaveBeenCalled();
  });
  it("send the version, the changed keys, the confirmation and the trimmed reason to the core", async () => {
    const edits = { practitioner: { "appt.move": "studio" } };
    expect(await actions.saveRolePolicyAction(edits, 3, true, "  needed for cover  ")).toEqual({ ok: true, newVersion: 5 });
    expect(core.coreSave).toHaveBeenCalledWith("studio-1", 3, edits, "needed for cover", true);
  });
  it("refuse a malformed body, a missing version or a placeholder reason before the core", async () => {
    expect((await actions.saveRolePolicyAction({ owner: { x: "studio" } }, 0, false, "")).ok).toBe(false);
    expect(await actions.saveRolePolicyAction({ practitioner: { a: 1 } }, 0, false, "")).toEqual({ ok: false, error: { code: "invalid_changes" } });
    expect(await actions.saveRolePolicyAction({ practitioner: { a: "off" } }, "3", false, "")).toEqual({ ok: false, error: { code: "version_required" } });
    expect(await actions.saveRolePolicyAction({ practitioner: { a: "off" } }, 3, false, "n/a")).toEqual({ ok: false, error: { code: "reason_invalid" } });
    expect(core.coreSave).not.toHaveBeenCalled();
  });
  it("require a meaningful reason for adopt and reset", async () => {
    expect(await actions.adoptNewDefaultsAction(0, "n/a")).toEqual({ ok: false, error: { code: "reason_required" } });
    expect(await actions.resetRolePolicyAction("receptionist", 0, "")).toEqual({ ok: false, error: { code: "reason_required" } });
    expect(core.coreAdopt).not.toHaveBeenCalled();
    expect(core.coreReset).not.toHaveBeenCalled();
    await actions.adoptNewDefaultsAction(2, "moving to the new defaults");
    expect(core.coreAdopt).toHaveBeenCalledWith("studio-1", 2, "moving to the new defaults");
  });
  it("refuse an unknown role", async () => {
    expect((await actions.resetRolePolicyAction("owner", 0, "a good reason")).ok).toBe(false);
    expect(core.coreReset).not.toHaveBeenCalled();
  });
});

describe("the migration's functions and parameter names are the ones the page calls", () => {
  const sql = readFileSync("supabase/migrations/0287_roles_permission_engine.sql", "utf8");
  const src = readFileSync("lib/settings/roles/core.ts", "utf8");
  it("matches every rpc name and p_ argument", () => {
    const calls = [...src.matchAll(/call\("([a-z_]+)", \{([^}]*)\}\)/g)];
    expect(calls.length).toBe(9);
    for (const [, fn, args] of calls) {
      const sig = sql.match(new RegExp(`function public\\.${fn}\\(([^)]*)\\)`));
      expect(sig, fn).not.toBeNull();
      for (const p of args.match(/p_[a-z_]+/g) ?? []) expect(sig![1], `${fn} ${p}`).toContain(p);
    }
  });
});

describe("parsing what the core returns (shapes taken from 0287)", () => {
  it("turns an error object into a code with key, role and the current version", () => {
    expect(parseError({ ok: false, code: "stale_version", current_version: 4 })).toEqual({ code: "stale_version", currentVersion: 4 });
    expect(parseError({ ok: false, code: "prerequisite_unmet", key: "appt.reassign", role: "practitioner", blocked_by: "appt.move" })).toEqual({
      code: "prerequisite_unmet",
      key: "appt.reassign",
      role: "practitioner",
    });
    expect(parseError({ ok: false, code: "something_new" })).toEqual({ code: "unexpected" });
    expect(parseError(null)).toEqual({ code: "unexpected" });
  });
  it("reads a save preview: server diff, the version it was computed against, server affected people, server sensitive keys", () => {
    const r = parsePreview({
      ok: true,
      version: 3,
      changes: { practitioner: [{ key: "appt.move", before: "off", after: "studio" }] },
      affected: { practitioner: { count: 1, people: [{ membership_id: "m1", display_name: "Alex", state: "active" }] } },
      sensitive_keys: [],
      reason_required: false,
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.preview.version).toBe(3);
    expect(r.preview.roles[0].people).toEqual([{ id: "m1", name: "Alex", state: "active" }]);
    expect(r.preview.roles[0].diff.changes[0]).toMatchObject({ key: "appt.move", from: "off", to: "studio", direction: "widens" });
    expect(r.preview.roles[0].count).toBe(1);
  });
  it("lists fixed narrowings from the adopt preview under the practitioner only", () => {
    const r = parsePreview({
      ok: true,
      version: 0,
      changes: { practitioner: [], receptionist: [] },
      affected: {},
      fixed_narrowings: [{ id: "archive_client", label: "Archive clients", notice: "advance notice" }],
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.preview.roles.find((x) => x.role === "practitioner")!.diff.fixedNarrowings.map((n) => n.id)).toEqual(["archive_client"]);
    expect(r.preview.roles.find((x) => x.role === "receptionist")!.diff.fixedNarrowings).toEqual([]);
  });
  it("takes the sensitive flag from the core's diff entry when it gives one", () => {
    const r = parsePreview({ ok: true, version: 1, changes: { practitioner: [{ key: "appt.move", before: "off", after: "studio", sensitive: true }] }, affected: {} });
    if (!r.ok) throw new Error("expected ok");
    expect(r.preview.roles[0].diff.newlyEnabledSensitive).toBe(1);
  });
  it("separates true practitioner losses from safeguards: the core's practitioner_access wins, a known-loss fallback covers its absence", () => {
    const r = parsePreview({
      ok: true,
      version: 0,
      changes: { practitioner: [] },
      affected: {},
      fixed_narrowings: [
        { id: "performer_change", label: "p", notice: "n" },
        { id: "exposure_incident_history", label: "e", notice: "n" },
        { id: "anonymous_public_writes_closed", label: "a", notice: "n" },
        { id: "notification_read_state", label: "r", notice: "n" },
        { id: "google_flags_operator_only", label: "g", notice: "n" },
        { id: "studio_columns_read", label: "s", notice: "n" },
        { id: "future_thing", label: "f", notice: "n", practitioner_access: "narrows" },
        { id: "performer_change_x", label: "x", notice: "n", practitioner_access: "safeguard" },
      ],
    });
    if (!r.ok) throw new Error("expected ok");
    const kinds = Object.fromEntries(r.preview.roles[0].diff.fixedNarrowings.map((n) => [n.id, n.kind]));
    expect(kinds).toMatchObject({
      performer_change: "narrows",
      exposure_incident_history: "narrows",
      anonymous_public_writes_closed: "safeguard",
      notification_read_state: "safeguard",
      google_flags_operator_only: "safeguard",
      studio_columns_read: "safeguard",
      future_thing: "narrows",
      performer_change_x: "safeguard",
    });
  });
  it("reads each key's enforcement and the staff_role_change gate from get_role_permissions", () => {
    const st = parseState({
      ok: true,
      version: 1,
      basis: "new_studio",
      gates: { staff_role_change: false },
      roles: { practitioner: {}, receptionist: {} },
      keys: { "appt.move": { sensitive: false, consequence: "x", enforcement: "enforced" }, "appt.book": { enforcement: "observe" }, bad: { enforcement: 3 } },
    });
    expect(st?.enforcement).toEqual({ "appt.move": "enforced", "appt.book": "observe" });
    expect(st?.staffRoleChange).toBe(false);
    expect(parseState({ ok: true, version: 1, gates: { staff_role_change: true }, roles: { practitioner: {}, receptionist: {} } })?.staffRoleChange).toBe(true);
    expect(parseState({ ok: true, version: 1, roles: { practitioner: {}, receptionist: {} } })?.enforcement).toEqual({});
  });
  it("answers a malformed preview with unexpected, never with a guess", () => {
    expect(parsePreview({ ok: true })).toEqual({ ok: false, error: { code: "unexpected" } });
  });
  it("reads a write result as the new version", () => {
    expect(parseCommand({ ok: true, new_version: 4, version: 3 })).toEqual({ ok: true, newVersion: 4 });
    expect(parseCommand({ ok: false, code: "stale_version", current_version: 9 })).toEqual({ ok: false, error: { code: "stale_version", currentVersion: 9 } });
  });
  it("reads state: stored choices only, reviewed once custom or adopted", () => {
    const raw = (stored: string | null, basis = "existing_snapshot") => ({
      ok: true,
      version: 2,
      basis,
      gates: { receptionist_legal_name: false },
      roles: { practitioner: { "appt.move": { stored, effective: "off" } }, receptionist: {} },
    });
    expect(parseState(raw(null))!.reviewed).toBe(false);
    expect(parseState(raw("studio"))!.reviewed).toBe(true);
    expect(parseState(raw(null, "new_studio"))!.reviewed).toBe(true);
    expect(parseState(raw("studio"))!.policies.practitioner.values).toEqual({ "appt.move": "studio" });
    expect(parseState({ ok: false })).toBeNull();
  });
  it("reads history with resolved names and no email, and a page cursor only when the page is full", () => {
    const row = (id: number, kind: string) => ({
      id,
      at: "2026-11-03T10:00:00Z",
      kind,
      role: "practitioner",
      actor_name: "Chloe",
      person_name: null,
      person_state: null,
      reason: "cover",
      before: { "appt.move": { stored: "off", effective: "off" } },
      after: { "appt.move": { stored: "studio", effective: "studio" } },
    });
    const r = parseHistory({ ok: true, rows: [row(2, "role_permissions_saved"), row(1, "role_permissions_saved")] }, 2);
    if (!r.ok) throw new Error("expected ok");
    expect(r.rows[0]).toMatchObject({ actorName: "Chloe", before: { "Move appointments": "Off" }, after: { "Move appointments": "Whole studio" } });
    expect(r.next).toBe("1");
    const short = parseHistory({ ok: true, rows: [row(1, "role_permissions_saved")] }, 50);
    if (short.ok) expect(short.next).toBeNull();
  });
  it("shows only changed keys for a reset or adoption, and the role for a staff change", () => {
    const r = parseHistory(
      {
        ok: true,
        rows: [
          { id: 3, at: "t", kind: "role_reset", role: "practitioner", before: { "appt.move": "studio", "appt.book": "studio" }, after: { "appt.move": "off", "appt.book": "studio" } },
          { id: 2, at: "t", kind: "staff_role_changed", role: "receptionist", before: { role: "practitioner" }, after: { role: "receptionist" } },
        ],
      },
      50,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(Object.keys(r.rows[0].after)).toEqual(["Move appointments"]);
    expect(r.rows[1].after).toEqual({ Role: "receptionist" });
  });
  it("reads effective access rows with what capped them", () => {
    const r = parseAccess({ ok: true, state: "active", role: "practitioner", rows: [{ key: "appt.move", scope: "off", source: "snapshot", capped_by: "gate:x" }] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.rows[0]).toEqual({ key: "appt.move", scope: "off", source: "snapshot", cappedBy: "gate:x" });
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
  it("returns to the draft with Review available after a stale version (found in the integrated run)", () => {
    const handler = src.slice(src.indexOf("function handleError"), src.indexOf("async function onReview"));
    expect(handler).toMatch(/stale_version[\s\S]*setReviewing\(false\)/);
  });
  it("keeps the draft on every refusal", () => {
    const handler = src.slice(src.indexOf("function handleError"), src.indexOf("async function onReview"));
    expect(handler).not.toMatch(/setDrafts|setSaved/);
  });
  it("reads history and per-person access from the core, with no email in history", () => {
    expect(src).toContain("props.loadHistory");
    const history = src.slice(src.indexOf("function HistoryPanel"), src.indexOf("function OwnerOnlySettingsNotes"));
    expect(history).not.toMatch(/email/i);
    expect(src).toContain("load(person.id)");
  });
});
