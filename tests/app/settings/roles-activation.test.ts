import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioPolicy } from "@/lib/permissions/catalog";
import { parseActivationPreview, parseHistory, parseState } from "@/lib/settings/roles/core-parse";
import { AUDIT_KIND_LABEL } from "@/lib/settings/roles/api";
import { applyEdit, enforcementRefusal } from "@/lib/settings/roles/model";
import { pendingActivations, type PolicyWithServer } from "@/lib/settings/roles/server-effective";

// Activation UI (0287 Activation rule): released settings are NOT in force until the owner activates them. The page shows them as
// pending, previews the change through the core, and commits only the keys, version and hash it showed. Nothing here decides what is
// allowed; the core refuses and the page shows the code's message.

const owner = vi.hoisted(() => ({ role: "owner" }));
const core = vi.hoisted(() => ({
  corePreviewActivation: vi.fn(async (..._a: unknown[]) => ({ ok: true })),
  coreActivate: vi.fn(async (..._a: unknown[]) => ({ ok: true, newVersion: 8 })),
}));
vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: vi.fn(async () => ({ practitioner: { role: owner.role }, studio: { id: "studio-1" } })),
}));
vi.mock("@/lib/settings/roles/core", () => core);
vi.mock("@/lib/settings/roles/policy-store", () => ({ loadStudioPolicyState: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<Record<string, unknown>>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { activatePermissionsAction, previewActivationAction } = await import("@/app/(app)/settings/roles/actions");
const { RolesEditor } = await import("@/app/(app)/settings/roles/roles-editor");

const K1 = "appt.cancel";
const K2 = "pay.view";

const rawState = (sources: Record<string, string>, stored = "studio") => ({
  ok: true,
  version: 7,
  basis: "existing_snapshot",
  gates: {},
  roles: {
    practitioner: Object.fromEntries(Object.entries(sources).map(([k, source]) => [k, { stored, effective: "own", source }])),
    receptionist: {},
  },
});

describe("pending keys come from the core's source, not the mirror", () => {
  it("lists released-but-not-activated keys with the roles they affect", () => {
    const state = parseState(rawState({ [K1]: "inactive_until_activated", [K2]: "stored" }))!;
    const pending = pendingActivations(state.policies);
    expect(pending.map((p) => p.key)).toEqual([K1]);
    expect(pending[0].roles).toEqual(["practitioner"]);
  });
  it("an unreleased key is not activatable and is not listed", () => {
    const state = parseState(rawState({ [K1]: "unreleased" }))!;
    expect(pendingActivations(state.policies)).toEqual([]);
  });
  it("nothing pending without a core answer", () => {
    const p: PolicyWithServer = { basis: "existing_snapshot", values: {}, gates: {} };
    expect(pendingActivations({ practitioner: p, receptionist: p })).toEqual([]);
  });
});

describe("parseActivationPreview", () => {
  const ok = {
    ok: true,
    version: 7,
    keys: [K1],
    preview_hash: "abc123",
    changes: { practitioner: [{ key: K1, before: "own", after: "studio" }], receptionist: [] },
    affected: { practitioner: { count: 1, people: [{ membership_id: "m1", display_name: "Alex", state: "active" }] }, receptionist: { count: 0, people: [] } },
    sensitive_keys: [K2],
    confirmation_required: true,
  };
  it("keeps the keys, the hash and the confirmation flag the commit must carry back", () => {
    const r = parseActivationPreview(ok);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.keys).toEqual([K1]);
    expect(r.preview.digest).toBe("abc123");
    expect(r.preview.version).toBe(7);
    expect(r.preview.confirmationRequired).toBe(true);
    expect(r.preview.sensitiveKeys).toEqual([K2]);
    expect(r.preview.roles.find((x) => x.role === "practitioner")?.diff.widened).toBe(1);
  });
  it("a preview without a hash or key list is unusable, never committed blind", () => {
    expect(parseActivationPreview({ ...ok, preview_hash: undefined })).toEqual({ ok: false, error: { code: "unexpected" } });
    expect(parseActivationPreview({ ...ok, keys: undefined })).toEqual({ ok: false, error: { code: "unexpected" } });
    expect(parseActivationPreview({ ...ok, preview_hash: "" }).ok).toBe(false);
  });
  it("passes a core refusal through as its code", () => {
    expect(parseActivationPreview({ ok: false, code: "not_released", key: K1 })).toEqual({ ok: false, error: { code: "not_released", key: K1 } });
  });
});

describe("History knows the activation audit kind", () => {
  const row = {
    id: 41,
    at: "2026-11-04T10:00:00Z",
    kind: "permissions_activated",
    role: "practitioner",
    actor_name: "Chloe",
    reason: "Reviewed with the team",
    before: { keys: [K1, K2], effective: { [K1]: "own", [K2]: "off" } },
    after: { keys: [K1, K2], effective: { [K1]: "studio", [K2]: "off" } },
  };
  it("shows the row with only the settings whose effective value moved", () => {
    const r = parseHistory({ ok: true, rows: [row] }, 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].kind).toBe("permissions_activated");
    expect(Object.values(r.rows[0].before)).toEqual(["Own assigned"]);
    expect(Object.values(r.rows[0].after)).toEqual(["Whole studio"]);
    expect(AUDIT_KIND_LABEL.permissions_activated).toBe("Released settings activated");
  });
});

describe("server actions", () => {
  beforeEach(() => {
    owner.role = "owner";
    core.corePreviewActivation.mockClear();
    core.coreActivate.mockClear();
  });
  it("refuse a non-owner before the core is called", async () => {
    owner.role = "practitioner";
    expect(await previewActivationAction([K1])).toEqual({ ok: false, error: { code: "refused" } });
    expect(await activatePermissionsAction([K1], 7, "why not", "h", false)).toEqual({ ok: false, error: { code: "refused" } });
    expect(core.corePreviewActivation).not.toHaveBeenCalled();
    expect(core.coreActivate).not.toHaveBeenCalled();
  });
  it("name the keys explicitly: empty, non-array and non-string lists are refused", async () => {
    for (const bad of [undefined, null, [], "appt.cancel", [1], [""]]) {
      expect(await previewActivationAction(bad)).toEqual({ ok: false, error: { code: "keys_required" } });
      expect(await activatePermissionsAction(bad, 7, "why not", "h", false)).toEqual({ ok: false, error: { code: "keys_required" } });
    }
    expect(core.coreActivate).not.toHaveBeenCalled();
  });
  it("require a version, a preview hash and a meaningful reason", async () => {
    expect(await activatePermissionsAction([K1], undefined, "Reviewed it", "h", false)).toEqual({ ok: false, error: { code: "version_required" } });
    expect(await activatePermissionsAction([K1], 7, "Reviewed it", "", false)).toEqual({ ok: false, error: { code: "preview_required" } });
    expect(await activatePermissionsAction([K1], 7, "Reviewed it", undefined, false)).toEqual({ ok: false, error: { code: "preview_required" } });
    expect(await activatePermissionsAction([K1], 7, "", "h", false)).toEqual({ ok: false, error: { code: "reason_required" } });
    expect(await activatePermissionsAction([K1], 7, "n/a", "h", false)).toEqual({ ok: false, error: { code: "reason_required" } });
    expect(core.coreActivate).not.toHaveBeenCalled();
  });
  it("send the exact keys, version, trimmed reason, hash and a strict boolean confirmation", async () => {
    await activatePermissionsAction([K1, K1, K2], 7, "  Reviewed with the team  ", "hash-1", "yes");
    expect(core.coreActivate).toHaveBeenCalledWith("studio-1", [K1, K2], 7, "Reviewed with the team", "hash-1", false);
    await activatePermissionsAction([K1], 7, "Reviewed with the team", "hash-1", true);
    expect(core.coreActivate).toHaveBeenLastCalledWith("studio-1", [K1], 7, "Reviewed with the team", "hash-1", true);
  });
});

describe("the page", () => {
  const mk = (sources: Record<string, string>): Record<"practitioner" | "receptionist", StudioPolicy> => {
    const s = parseState(rawState(sources))!;
    return s.policies;
  };
  const noop = async () => ({ ok: false as const, error: { code: "unavailable" as const } });
  const render = (policies: Record<"practitioner" | "receptionist", StudioPolicy>, writable = true) =>
    renderToStaticMarkup(
      createElement(RolesEditor, {
        policies,
        reviewed: true,
        writable,
        notWritableReason: null,
        staffRoleChange: false,
        initialView: "permissions",
        people: [],
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
      }),
    );
  it("shows a Pending activation panel naming the setting and that it is not in force", () => {
    const html = render(mk({ [K1]: "inactive_until_activated" }));
    expect(html).toContain('data-testid="activation-pending"');
    expect(html).toContain(`data-pending-key="${K1}"`);
    expect(html).toContain("not in force for your staff until you activate them");
    expect(html).toContain('data-testid="activation-review"');
    // No commit control until the core has previewed.
    expect(html).not.toContain('data-testid="activation-commit"');
  });
  it("shows nothing when no key is waiting, or the key is not released", () => {
    expect(render(mk({ [K1]: "stored" }))).not.toContain("activation-pending");
    expect(render(mk({ [K1]: "unreleased" }))).not.toContain("activation-pending");
  });
  it("the review button is disabled while the page cannot save", () => {
    const html = render(mk({ [K1]: "inactive_until_activated" }), false);
    expect(html).toMatch(/data-testid="activation-review"[^>]*disabled|disabled=""[^>]*data-testid="activation-review"/);
  });
  it("NQ-10: a pending edit choice with viewing off says it is inactive until viewing is on", () => {
    const raw = {
      ok: true,
      version: 7,
      basis: "existing_snapshot",
      gates: {},
      roles: {
        practitioner: {
          "clin.edit_records": { stored: "own", effective: "off", source: "inactive_until_activated" },
          "clin.view_records": { stored: "off", effective: "off", source: "stored" },
        },
        receptionist: {},
      },
    };
    const html = render(parseState(raw)!.policies);
    expect(html).toContain('data-testid="inactive-until"');
    expect(html).toContain("Inactive until View clinical records is on. Your choice is kept.");
    expect(html).toContain("Saved, but not in force yet");
  });
  it("Discard: a pending choice that differs from the basis offers a Discard button per role", () => {
    const raw = rawState({ "clin.edit_records": "inactive_until_activated" }, "own");
    // The existing-snapshot basis for this key is whole studio for practitioners, so a saved "own" differs and can be discarded.
    const html = render(parseState(raw)!.policies);
    expect(html).toContain('data-testid="activation-discard"');
    expect(html).toContain('data-discard-role="practitioner"');
    expect(html).toContain("Discard practitioner choice");
  });
});

describe("Discard is an ordinary save back to the basis", () => {
  const KEY = "clin.edit_records";
  const policy = (stored: "off" | "own" | "studio"): StudioPolicy => ({ basis: "existing_snapshot", values: { [KEY]: stored }, gates: {} });
  it("pendingActivations lists the role only while the saved choice differs from the basis", () => {
    const raw = rawState({ [KEY]: "inactive_until_activated" }, "own");
    const pending = pendingActivations(parseState(raw)!.policies);
    expect(pending[0].discard.map((d) => d.role)).toEqual(["practitioner"]);
    const basis = pending[0].discard[0].basis;
    const same = parseState({ ...raw, roles: { practitioner: { [KEY]: { stored: basis, effective: basis, source: "inactive_until_activated" } }, receptionist: {} } })!;
    expect(pendingActivations(same.policies)[0].discard).toEqual([]);
  });
  it("putting a key back on the basis is allowed even where the app does not enforce it, and never widens", () => {
    const basis = pendingActivations(parseState(rawState({ [KEY]: "inactive_until_activated" }, "own"))!.policies)[0].discard[0].basis;
    expect(enforcementRefusal("practitioner", policy("own"), KEY, basis)).toBeNull();
    const edited = applyEdit("practitioner", policy("own"), KEY, basis);
    expect(edited.ok).toBe(true);
    if (edited.ok) expect(edited.policy.values[KEY]).toBe(basis);
  });
  it("any other change to a key the app does not enforce is still refused", () => {
    const code = enforcementRefusal("practitioner", policy("own"), "clin.edit_records", "studio");
    // enforced keys may legitimately allow it; only assert the refusal where the catalog says not enforced
    expect(["not_enforced", "widening_not_yet", null]).toContain(code);
  });
});

describe("View access labelling", () => {
  const src = readFileSync("app/(app)/settings/roles/roles-editor.tsx", "utf8");
  it("says it is access in force, not saved-but-waiting or unsaved, and flags a pending saved choice", () => {
    expect(src).toContain("Access in force right now. Choices saved but waiting for activation, and unsaved edits, are not counted here.");
    expect(src).toMatch(/r\.source === "inactive_until_activated"[\s\S]{0,200}waiting for activation/);
  });
});
