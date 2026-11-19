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

import { previewAdoptAction, previewResetAction, previewRoleChangesAction } from "@/app/(app)/settings/roles/actions";

const snapshot = (values: Record<string, string> = {}) => ({ basis: "existing_snapshot", values, gates: {} });
const state = (version: number, writable = true, values: Record<string, string> = {}) => ({
  version, writable, policies: { practitioner: snapshot(values), receptionist: snapshot() }, reviewed: false, notWritableReason: null, staffRoleChange: false,
});
const corePreview = (version: number) => ({ ok: true as const, preview: { version, roles: [] } });

beforeEach(() => vi.clearAllMocks());

describe("previews carry server-read saved choices", () => {
  it("adopt: lists the choices adoption changes and describes the version that was previewed", async () => {
    core.corePreviewAdopt.mockResolvedValue(corePreview(4));
    store.loadStudioPolicyState.mockResolvedValue(state(4));
    const r = await previewAdoptAction();
    if (!r.ok) throw new Error("expected ok");
    expect(r.preview.version).toBe(4);
    expect(r.preview.choices?.some((c) => c.role === "receptionist" && c.key === "appt.cancel" && c.from === "off" && c.to === "studio")).toBe(true);
  });
  it("reset: only the previewed role's choices", async () => {
    core.corePreviewReset.mockResolvedValue(corePreview(4));
    store.loadStudioPolicyState.mockResolvedValue(state(4));
    const r = await previewResetAction("receptionist");
    if (!r.ok) throw new Error("expected ok");
    expect(r.preview.choices?.length).toBeGreaterThan(0);
    expect(r.preview.choices?.every((c) => c.role === "receptionist")).toBe(true);
  });
  it("save: before-values are the server's, not the page's", async () => {
    core.corePreviewChanges.mockResolvedValue(corePreview(5));
    store.loadStudioPolicyState.mockResolvedValue(state(5, true, { "appt.cancel": "off" }));
    const r = await previewRoleChangesAction({ practitioner: { "appt.cancel": "own" } });
    if (!r.ok) throw new Error("expected ok");
    expect(r.preview.choices).toEqual([{ role: "practitioner", key: "appt.cancel", label: "Cancel appointments", from: "off", to: "own" }]);
  });
  it("a policy that moved between the core's preview and the read is refused as stale, for all three previews", async () => {
    store.loadStudioPolicyState.mockResolvedValue(state(6));
    core.corePreviewAdopt.mockResolvedValue(corePreview(5));
    core.corePreviewReset.mockResolvedValue(corePreview(5));
    core.corePreviewChanges.mockResolvedValue(corePreview(5));
    for (const r of [await previewAdoptAction(), await previewResetAction("practitioner"), await previewRoleChangesAction({ practitioner: { "appt.cancel": "own" } })]) {
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
