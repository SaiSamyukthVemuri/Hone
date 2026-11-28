import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-130 D2/D3: the add and revise actions call the database command add_client_clinical_note (a SECURITY INVOKER wrapper of the same insert) and the
// budget action calls upsert_client_budget_context. This pins the call shape (the diff of the three actions), the closed codes, and that a missing
// command FAILS CLOSED and READABLE instead of throwing.
const S = "11111111-1111-4111-8111-111111111111";
const C = "33333333-3333-4333-8333-333333333333";
const G = "55555555-5555-4555-8555-555555555555";
const N = "77777777-7777-4777-8777-777777777777";
const rpc = vi.hoisted(() => vi.fn());
const logs = vi.hoisted(() => [] as string[]);
const row = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc,
    from: (table: string) => ({
      select: () => {
        const chain = {
          eq: () => chain,
          maybeSingle: async () => (table === "clients" ? { data: { id: C }, error: null } : { data: row.value, error: null }),
        };
        return chain;
      },
    }),
  }),
}));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: async () => ({ studio: { id: S }, practitioner: { id: "p1", display_name: "P" } }) }));
vi.mock("@/lib/logging/safe-log", () => ({ safeLog: { error: (...m: unknown[]) => logs.push(m.join(" ")), info: (...m: unknown[]) => logs.push(m.join(" ")) } }));

import { addClinicalNoteAction, reviseClinicalNoteAction } from "@/app/(app)/clients/[id]/clinical-notes-actions";
import { updateClientBudgetContextAction } from "@/app/(app)/clients/[id]/budget-context-actions";

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const base = { client_id: C, kind: "consultation", body: "SECRET CLINICAL TEXT", areas: "[]" };

beforeEach(() => {
  rpc.mockReset();
  logs.length = 0;
  row.value = { id: N, client_id: C, kind: "consultation", body: "SECRET CLINICAL TEXT", supersedes_note_id: null, areas: [], studio_id: S, practitioner_id: "p1", occurred_at: "t", created_at: "t" };
});

describe("the add and revise actions call the command with exactly this shape", () => {
  it("add: the command, with the draft generation, and nothing else the caller could forge", async () => {
    rpc.mockResolvedValue({ data: N, error: null });
    const r = await addClinicalNoteAction(form({ ...base, draft_generation: G }));
    expect(r.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("add_client_clinical_note", {
      p_client_id: C,
      p_kind: "consultation",
      p_body: "SECRET CLINICAL TEXT",
      p_areas: [],
      p_occurred_at: null,
      p_supersedes_note_id: null,
      p_generation: G,
    });
    // Studio and practitioner are NOT arguments: they come from the session inside the command.
    expect(Object.keys(rpc.mock.calls[0][1]).join(",")).not.toMatch(/studio|practitioner/);
  });
  it("revise passes the note being revised; an invalid or missing generation is NULL and never fails the Save", async () => {
    rpc.mockResolvedValue({ data: N, error: null });
    row.value = { ...row.value, supersedes_note_id: N };
    for (const g of ["not-a-uuid", ""]) {
      rpc.mockClear();
      const r = await reviseClinicalNoteAction(form({ ...base, supersedes_note_id: N, draft_generation: g }));
      expect(r.ok).toBe(true);
      expect(rpc.mock.calls[0][1]).toMatchObject({ p_supersedes_note_id: N, p_generation: null });
    }
  });
  it("budget: the command, with the draft generation", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const r = await updateClientBudgetContextAction(form({ client_id: C, budget_level: "no_stated_limit", budget_notes: "n", draft_generation: G }));
    expect(r).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("upsert_client_budget_context", { p_client_id: C, p_budget_level: "no_stated_limit", p_budget_notes: "n", p_generation: G });
  });
});

describe("closed codes", () => {
  it("HN131 (the draft was already saved or discarded from another window) is a closed code and a fixed sentence: no second note, no text in the message", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "HN131", message: "note draft already ended SECRET CLINICAL TEXT" } });
    const r = await addClinicalNoteAction(form({ ...base, draft_generation: G }));
    expect(r).toMatchObject({ ok: false, code: "draft_ended" });
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect((r as { error: string }).error).toMatch(/already saved from another window/);
    expect(logs.join(" ")).not.toContain("SECRET");
  });
  it("23505 on a revision is still the stale-revision conflict", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "23505", message: "dup" } });
    const r = await reviseClinicalNoteAction(form({ ...base, supersedes_note_id: N }));
    expect(r).toMatchObject({ ok: false, code: "stale_revision" });
  });
  it("any other database error is the fixed save-failed copy and the log carries no note text", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "SECRET CLINICAL TEXT leaked" } });
    const r = await addClinicalNoteAction(form(base));
    expect(r).toMatchObject({ ok: false, code: "error" });
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(logs.join(" ")).not.toContain("SECRET");
  });
});

describe("a MISSING command fails closed and readable (the migration is not applied yet)", () => {
  it.each(["PGRST202", "42883"])("add and revise: %s returns a fixed sentence, writes nothing, never throws", async (code) => {
    rpc.mockResolvedValue({ data: null, error: { code, message: "Could not find the function public.add_client_clinical_note SECRET CLINICAL TEXT" } });
    const added = await addClinicalNoteAction(form({ ...base, draft_generation: G }));
    expect(added).toMatchObject({ ok: false, code: "error", error: expect.stringMatching(/temporarily unavailable.*text is still here/) });
    const revised = await reviseClinicalNoteAction(form({ ...base, supersedes_note_id: N }));
    expect(revised).toMatchObject({ ok: false, code: "error" });
    expect(JSON.stringify([added, revised])).not.toContain("SECRET");
    expect(logs.join(" ")).not.toContain("SECRET");
    expect(rpc).toHaveBeenCalledTimes(2); // and no fallback direct write was attempted
  });
  it.each(["PGRST202", "42883"])("budget: %s returns a fixed sentence and does not throw", async (code) => {
    rpc.mockResolvedValue({ data: null, error: { code, message: "no function" } });
    const r = await updateClientBudgetContextAction(form({ client_id: C, budget_level: "", budget_notes: "n" }));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/temporarily unavailable.*text is still here/) });
  });
});
