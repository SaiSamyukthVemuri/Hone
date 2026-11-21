import { beforeEach, describe, expect, it, vi } from "vitest";

// Codex P2 4584603808 / 4584672884: a preview carries the saved-choice list read by the SERVER at the previewed version; if the policy moved
// between the core's preview and that read, the preview is refused as stale instead of describing a version Save will not overwrite.

vi.mock("server-only", () => ({}));
const core = vi.hoisted(() => ({
  corePreviewChanges: vi.fn(),
  corePreviewReset: vi.fn(),
  corePreviewAdopt: vi.fn(),
}));
const store = vi.hoisted(() => ({ loadStudioPolicyState: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({ requirePractitionerWithStudio: async () => ({ practitioner: { role: "owner" }, studio: { id: "s1" } }) }));
vi.mock("@/lib/settings/roles/core", () => ({
  coreAccess: vi.fn(), coreActivate: vi.fn(), coreAdopt: vi.fn(), coreChangeRole: vi.fn(), coreHistory: vi.fn(),
  corePreviewActivation: vi.fn(), coreReset: vi.fn(), coreSave: vi.fn(), ...core,
}));
vi.mock("@/lib/settings/roles/policy-store", () => store);

import type { ServerPreview } from "@/lib/settings/roles/api";
import { previewAdoptAction, previewResetAction, previewRoleChangesAction } from "@/app/(app)/settings/roles/actions";

const snapshot = (values: Record<string, string> = {}) => ({ basis: "existing_snapshot", values, gates: {} });
const state = (version: number, writable = true, values: Record<string, string> = {}) => ({
  version, writable, policies: { practitioner: snapshot(values), receptionist: snapshot() }, reviewed: false, notWritableReason: null, staffRoleChange: false,
});
const corePreview = (version: number) => ({ ok: true as const, preview: { version, roles: [] } });

beforeEach(() => vi.clearAllMocks());

describe("union: the preview type keeps the two summaries apart", () => {
  it("a Save preview (review table) cannot carry choices, and a Reset/Adopt preview (choices) cannot carry a review table: the compiler refuses both", () => {
    // @ts-expect-error a Save preview with choices
    const saveWithChoices: ServerPreview = { version: 1, roles: [], review: null, choices: [] };
    // @ts-expect-error a Reset/Adopt preview with a review table
    const choicesWithReview: ServerPreview = { version: 1, roles: [], choices: [], review: { rows: [], hash: "", version: 1 } };
    const okSave: ServerPreview = { version: 1, roles: [], review: null };
    const okChoices: ServerPreview = { version: 1, roles: [], choices: [] };
    expect([saveWithChoices, choicesWithReview, okSave, okChoices]).toHaveLength(4);
  });
});

describe("previews carry server-read saved choices", () => {
  it("adopt: lists the choices adoption changes and describes the version that was previewed", async () => {
    core.corePreviewAdopt.mockResolvedValue(corePreview(4));
    store.loadStudioPolicyState.mockResolvedValue(state(4));
    const r = await previewAdoptAction();
    if (!r.ok) throw new Error("expected ok");
    expect(r.preview.version).toBe(4);
    expect(r.preview.choices?.some((c) => c.role === "receptionist" && c.key === "appt.cancel" && c.from === "off" && c.to === "studio")).toBe(true);
  });
  it("reset: only the previewed role's stored overrides are reverted, to the studio's own basis (Codex 4623900551)", async () => {
    core.corePreviewReset.mockResolvedValue(corePreview(4));
    const st = state(4, true, { "appt.cancel": "off" });
    st.policies.receptionist = snapshot({ "appt.cancel": "studio" });
    store.loadStudioPolicyState.mockResolvedValue(st);
    const r = await previewResetAction("receptionist");
    if (!r.ok) throw new Error("expected ok");
    expect(r.preview.choices).toEqual([{ role: "receptionist", key: "appt.cancel", label: "Cancel appointments", from: "studio", to: "off" }]);
  });
  it("reset of a role with no stored overrides lists nothing: a reset keeps the basis and never applies new-studio defaults (Codex 4623900551)", async () => {
    core.corePreviewReset.mockResolvedValue(corePreview(4));
    store.loadStudioPolicyState.mockResolvedValue(state(4));
    const r = await previewResetAction("receptionist");
    if (!r.ok) throw new Error("expected ok");
    expect(r.preview.choices).toEqual([]);
  });
  it("adopt keeps a stored override: a practitioner appt.cancel = off is not previewed as a move (Codex 4623900551)", async () => {
    core.corePreviewAdopt.mockResolvedValue(corePreview(4));
    store.loadStudioPolicyState.mockResolvedValue(state(4, true, { "appt.cancel": "off" }));
    const r = await previewAdoptAction();
    if (!r.ok) throw new Error("expected ok");
    expect(r.preview.choices?.some((c) => c.role === "practitioner" && c.key === "appt.cancel")).toBe(false);
    expect(r.preview.choices?.some((c) => c.role === "receptionist" && c.key === "appt.cancel" && c.to === "studio")).toBe(true);
  });
  it("save: the preview is the DATABASE's review table at the requested version, with no server-read choices beside it (the Save path no longer builds them)", async () => {
    const review = { version: 5, hash: "ab".repeat(32), rows: [] };
    core.corePreviewChanges.mockResolvedValue({ ok: true as const, preview: { version: 5, roles: [], review } });
    const r = await previewRoleChangesAction({ practitioner: { "appt.cancel": "own" } }, 5);
    if (!r.ok) throw new Error("expected ok");
    expect(core.corePreviewChanges).toHaveBeenCalledWith(expect.any(String), { practitioner: { "appt.cancel": "own" } }, 5);
    expect(r.preview.review).toEqual(review);
    expect(r.preview.choices).toBeUndefined();
  });
  it("save: a preview without the page's version is refused before anything is read", async () => {
    const r = await previewRoleChangesAction({ practitioner: { "appt.cancel": "own" } }, undefined);
    expect(r).toEqual({ ok: false, error: { code: "version_required" } });
    expect(core.corePreviewChanges).not.toHaveBeenCalled();
  });
  it("a policy that moved between the core's preview and the read is refused as stale, for the Reset and Adopt previews (the Save preview is checked by the database at the requested version)", async () => {
    store.loadStudioPolicyState.mockResolvedValue(state(6));
    core.corePreviewAdopt.mockResolvedValue(corePreview(5));
    core.corePreviewReset.mockResolvedValue(corePreview(5));
    for (const r of [await previewAdoptAction(), await previewResetAction("practitioner")]) {
      expect(r).toEqual({ ok: false, error: { code: "stale_version" } });
    }
  });
  it("an unreadable policy is refused, never described from a snapshot fallback", async () => {
    core.corePreviewAdopt.mockResolvedValue(corePreview(4));
    store.loadStudioPolicyState.mockResolvedValue(state(4, false));
    expect(await previewAdoptAction()).toEqual({ ok: false, error: { code: "unavailable" } });
  });
  it("a core refusal passes through untouched and the policy is not even read", async () => {
    core.corePreviewAdopt.mockResolvedValue({ ok: false, error: { code: "unexpected" } });
    expect(await previewAdoptAction()).toEqual({ ok: false, error: { code: "unexpected" } });
    expect(store.loadStudioPolicyState).not.toHaveBeenCalled();
  });
});
