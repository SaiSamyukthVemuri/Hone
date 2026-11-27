// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-124 item 19 (PR-1): the studio, postcare, policy, profile and colour actions RETURN a human sentence instead of throwing (production
// redacts a thrown message), never show a database code, never write on a refusal; the forms keep typed values and show only that sentence.
const scenario = { role: "owner" as "owner" | "practitioner", dbError: null as null | { code: string; message: string }, rpcId: "p1" as string | null };
const writes: Array<{ table: string; values: Record<string, unknown> }> = [];
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { role: scenario.role, active: true }, studio: { id: "studio-1" } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { cancellation_policy_text: null, no_show_policy_text: null }, error: null }) }) }),
      update: (values: Record<string, unknown>) => ({
        eq: async () => {
          writes.push({ table, values });
          return { error: scenario.dbError };
        },
      }),
    }),
    rpc: async () => ({ data: scenario.rpcId, error: scenario.dbError }),
  }),
}));
vi.mock("@/lib/booking/client-self-service-form", () => ({ parseClientSelfServiceForm: vi.fn() }));

import { updateStudioAction, updateStudioPolicyAction, updateStudioPostcareAction } from "@/app/(app)/settings/studio/actions";
import { updateOwnProfileAction, updatePractitionerColorAction } from "@/app/(app)/settings/profile/actions";
import { actionFailureMessage, GENERIC_SAVE_FAILURE, LOST_REQUEST_FAILURE } from "@/lib/actions/action-result";

const form = (e: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(e)) f.set(k, v); return f; };
beforeEach(() => { scenario.role = "owner"; scenario.dbError = null; scenario.rpcId = "p1"; writes.length = 0; vi.spyOn(console, "error").mockImplementation(() => {}); });

const NO_INTERNALS = /42501|23505|PGRST|duplicate key|omitted in production|Failed to update|violates/i;

describe("actionFailureMessage never returns the error's own text", () => {
  it("fallback for anything caught; the connection sentence for a lost request", () => {
    expect(actionFailureMessage(new Error("Failed to update studio: 42501"))).toBe(GENERIC_SAVE_FAILURE);
    expect(actionFailureMessage(Object.assign(new Error("An error occurred in the Server Components render. The specific message is omitted in production builds"), { digest: "1" }))).toBe(GENERIC_SAVE_FAILURE);
    expect(actionFailureMessage("boom", "Custom next step.")).toBe("Custom next step.");
    expect(actionFailureMessage(new TypeError("Failed to fetch"))).toBe(LOST_REQUEST_FAILURE);
    expect(GENERIC_SAVE_FAILURE).toMatch(/try again/i);
  });
});

describe("the actions return sentences, write nothing on a refusal, and show no code", () => {
  it("studio: blank name and non-owner are returned, not thrown, and nothing is written", async () => {
    expect(await updateStudioAction(form({ name: "  " }))).toEqual({ ok: false, error: "Enter a studio name, then save again." });
    scenario.role = "practitioner";
    const r = await updateStudioAction(form({ name: "Studio" }));
    expect(r).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
  });
  it("studio: a database failure becomes a sentence with the next step and no code", async () => {
    scenario.dbError = { code: "42501", message: "permission denied for table studios secret_detail" };
    const r = await updateStudioAction(form({ name: "Studio" }));
    expect(r.ok).toBe(false);
    const msg = (r as { error: string }).error;
    expect(msg).toMatch(/permission to save the studio details/);
    expect(msg).not.toMatch(NO_INTERNALS);
    expect(msg).not.toContain("secret_detail");
  });
  it("studio: success returns ok", async () => {
    expect(await updateStudioAction(form({ name: "Studio" }))).toEqual({ ok: true });
  });
  it("postcare: a bad review link and a bad contact email explain the fix, and nothing is written", async () => {
    const bad = await updateStudioPostcareAction(form({ postcare_review_url: "not a url" }));
    expect(bad).toEqual({ ok: false, error: expect.stringMatching(/starting with https:\/\/.*clear the field/) });
    const mail = await updateStudioPostcareAction(form({ postcare_contact_email: "nope" }));
    expect(mail).toEqual({ ok: false, error: expect.stringMatching(/name@example\.com/) });
    expect(writes).toHaveLength(0);
    expect(await updateStudioPostcareAction(form({ postcare_review_url: "https://example.com/r" }))).toEqual({ ok: true });
  });
  it("policy: owner-only refusal and a database failure are sentences", async () => {
    scenario.role = "practitioner";
    expect(await updateStudioPolicyAction(form({}))).toMatchObject({ ok: false });
    scenario.role = "owner";
    scenario.dbError = { code: "23505", message: "duplicate key value violates unique constraint x_pkey" };
    const r = (await updateStudioPolicyAction(form({ cancellation_policy_text: "x" }))) as { ok: false; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).not.toMatch(NO_INTERNALS);
  });
  it("profile and colour: blank name, bad colour, and an inactive membership are returned, never success", async () => {
    expect(await updateOwnProfileAction(form({ display_name: " " }))).toEqual({ ok: false, error: "Enter your name, then save again." });
    expect(await updatePractitionerColorAction(form({ color: "not-a-token" }))).toEqual({ ok: false, error: "Pick one of the colors shown." });
    scenario.rpcId = null;
    const r = (await updateOwnProfileAction(form({ display_name: "Ada" }))) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no longer active/);
    scenario.rpcId = "p1";
    expect(await updateOwnProfileAction(form({ display_name: "Ada" }))).toEqual({ ok: true });
  });
});

describe("the forms keep typed values and show only the sentence", () => {
  it("StudioSettingsForm: a returned failure shows its sentence and the field keeps what was typed; a thrown error shows the generic one", async () => {
    const { createElement, act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetModules();
    const result = { current: { ok: false, error: "Enter a studio name, then save again." } as unknown };
    vi.doMock("@/app/(app)/settings/studio/actions", () => ({
      updateStudioAction: vi.fn(async () => { if (result.current instanceof Error) throw result.current; return result.current; }),
    }));
    vi.doMock("@/components/settings/unsaved-changes", () => ({ useUnsavedChangesGuard: () => {} }));
    const { StudioSettingsForm } = await import("@/app/(app)/settings/studio/StudioSettingsForm");
    const host = document.createElement("div");
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(createElement(StudioSettingsForm, { initialName: "Old name", initialLegalEntity: "", ownerEmail: "o@x.test" })); });
    const input = host.querySelector("#studio-name input") as HTMLInputElement;
    expect(input.value).toBe("Old name");
    const submit = async () => { await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
    await submit();
    expect(host.textContent).toContain("Enter a studio name, then save again.");
    expect(input.value).toBe("Old name"); // typed values survive a failure
    result.current = new Error("Failed to update studio: 42501");
    await submit();
    expect(host.textContent).toContain(GENERIC_SAVE_FAILURE);
    expect(host.textContent).not.toMatch(/42501|Failed to update studio/);
    host.remove();
  });
});
