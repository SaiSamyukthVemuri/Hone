import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-75: two owners saving the same consent template at once must not both write version N+1 with different texts. The update names the version it read; zero
// rows updated means someone edited first, and nothing is overwritten.
const state = vi.hoisted(() => ({ currentVersion: 3, updateMatches: true, updates: [] as Record<string, unknown>[], filters: [] as [string, unknown][], dbError: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: async () => ({ practitioner: { role: "owner", active: true }, studio: { id: "studio-1" } }) }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = (cols?: string) => {
        if (cols === "version") return { eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { version: state.currentVersion } }) }) }) };
        return Promise.resolve({ data: state.updateMatches ? [{ id: "t1" }] : [], error: state.dbError });
      };
      q.update = (patch: Record<string, unknown>) => {
        state.updates.push(patch);
        const chain: Record<string, unknown> = {};
        chain.eq = (col: string, val: unknown) => {
          state.filters.push([col, val]);
          return chain;
        };
        chain.select = q.select;
        return chain;
      };
      return q;
    },
  }),
}));

const form = (over: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ id: "t1", title: "Title", description: "", body: "Body text", form_type: "general", ...over })) f.set(k, v);
  return f;
};

beforeEach(() => {
  state.currentVersion = 3;
  state.updateMatches = true;
  state.updates = [];
  state.filters = [];
  state.dbError = null;
});

describe("updateConsentTemplateAction compares the version it read", () => {
  it("names the version it read in the update and bumps by one", async () => {
    const { updateConsentTemplateAction } = await import("@/app/(app)/settings/consent/actions");
    const r = await updateConsentTemplateAction(form());
    expect(r).toEqual({ ok: true, templateId: "t1" });
    expect(state.updates[0].version).toBe(4);
    expect(state.filters).toContainEqual(["version", 3]);
    expect(state.filters).toContainEqual(["studio_id", "studio-1"]);
  });
  it("zero rows updated (someone edited first) refuses with the reload sentence", async () => {
    state.updateMatches = false;
    const { updateConsentTemplateAction } = await import("@/app/(app)/settings/consent/actions");
    const r = await updateConsentTemplateAction(form());
    expect(r).toEqual({ ok: false, error: "Someone just edited this template. Reload to see their changes." });
  });
  it("a database error is still the generic failure, not the 'someone edited' message", async () => {
    state.dbError = { code: "57014" };
    state.updateMatches = false;
    const { updateConsentTemplateAction } = await import("@/app/(app)/settings/consent/actions");
    const r = await updateConsentTemplateAction(form());
    expect(r).toEqual({ ok: false, error: "Couldn't update the template." });
  });
});
