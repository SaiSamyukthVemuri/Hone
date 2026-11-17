import { beforeEach, describe, expect, it, vi } from "vitest";

// CHARACTERIZATION of confirmImportAction on partial failure. Every test is named for what the code does TODAY, so a later fix flips a test on purpose
// instead of by accident. In-memory fake of the three tables the action writes; no database, no real import.
type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  clients: [] as Row[],
  batches: [] as Row[],
  memories: [] as Row[],
  memoryFailures: 0,
  batchCompleteFails: false,
  batchCompleteZeroRows: false,
  next: 1,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "p1", active: true, role: "owner", user_id: "u1" },
    studio: { id: "s1" },
  }),
}));
vi.mock("@/lib/import/operator-assist", async (orig) => ({ ...(await orig<object>()), isImportOperator: async () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: "clients" | "import_batches" | "imported_treatment_memories") {
      const rows = table === "clients" ? db.clients : table === "import_batches" ? db.batches : db.memories;
      let op: "select" | "insert" | "update" = "select";
      let inserted: Row[] = [];
      let patch: Row = {};
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (_c: string, v: unknown) => {
          if (op === "update") {
            inserted = rows.filter((r) => r.id === v && !(db.batchCompleteZeroRows && "completed_at" in patch));
            for (const r of inserted) Object.assign(r, patch);
          }
          return chain;
        },
        insert: (v: Row | Row[]) => {
          op = "insert";
          const list = Array.isArray(v) ? v : [v];
          if (table === "imported_treatment_memories" && db.memoryFailures > 0) {
            db.memoryFailures -= 1;
            inserted = [];
            (chain as { _err?: unknown })._err = { code: "XX000" };
            return chain;
          }
          inserted = list.map((r) => ({ ...r, id: `id${db.next++}` }));
          rows.push(...inserted);
          return chain;
        },
        update: (p: Row) => {
          op = "update";
          patch = p;
          if (table === "import_batches" && db.batchCompleteFails && "completed_at" in p) {
            (chain as { _err?: unknown })._err = { code: "XX000" };
            patch = {};
          }
          return chain;
        },
        single: () => Promise.resolve({ data: inserted[0] ?? null, error: null }),
        then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
          Promise.resolve(
            op === "select"
              ? { data: rows, error: null }
              : { data: inserted, error: (chain as { _err?: unknown })._err ?? null },
          ).then(f, r),
      };
      return chain;
    },
  }),
}));

const CSV = "client_name,email,treatment_area\nSynthetic One,one@example.test,Upper lip\nSynthetic Two,two@example.test,Chin";
const reset = () => Object.assign(db, { clients: [], batches: [], memories: [], memoryFailures: 0, batchCompleteFails: false, batchCompleteZeroRows: false, next: 1 });
beforeEach(() => reset());

describe("confirmImportAction on partial failure (today's behaviour)", () => {
  it("a happy import creates the clients, their memories, and marks the batch completed", async () => {
    const { confirmImportAction } = await import("@/app/(app)/settings/import/actions");
    const r = await confirmImportAction(CSV, "other");
    expect(r.ok).toBe(true);
    expect(db.clients).toHaveLength(2);
    expect(db.memories).toHaveLength(2);
    expect(db.batches[0].completed_at).toBeTruthy();
    expect(db.batches[0].voided_at).toBeUndefined();
  });

  it("when the memory insert fails twice: the batch is voided, the CLIENTS REMAIN, no memories exist, the answer is an error (rollback voids history only)", async () => {
    db.memoryFailures = 2;
    const { confirmImportAction } = await import("@/app/(app)/settings/import/actions");
    const r = await confirmImportAction(CSV, "other");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("2 client(s) were created, but their imported treatment history could not be saved");
    expect(db.batches[0].voided_at).toBeTruthy();
    expect(db.batches[0].completed_at).toBeUndefined();
    expect(db.clients).toHaveLength(2);
    expect(db.memories).toHaveLength(0);
  });

  it("when the memory insert fails once: the single retry succeeds and the import completes", async () => {
    db.memoryFailures = 1;
    const { confirmImportAction } = await import("@/app/(app)/settings/import/actions");
    const r = await confirmImportAction(CSV, "other");
    expect(r.ok).toBe(true);
    expect(db.memories).toHaveLength(2);
  });

  it("a retry after a memory failure SKIPS the already-created clients as duplicates, so their history is never imported (lost partial-import history)", async () => {
    db.memoryFailures = 2;
    const { confirmImportAction } = await import("@/app/(app)/settings/import/actions");
    await confirmImportAction(CSV, "other");
    const again = await confirmImportAction(CSV, "other");
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error).toContain("Every row matched an existing client");
    expect(db.clients).toHaveLength(2);
    expect(db.memories).toHaveLength(0);
    expect(db.batches).toHaveLength(1); // the retry never even opened a batch
  });

  it("when only the final completed_at update fails: the import is reported as NOT complete (with a do-not-rerun sentence), the data stays, and the batch is neither completed nor voided", async () => {
    db.batchCompleteFails = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { confirmImportAction } = await import("@/app/(app)/settings/import/actions");
    const r = await confirmImportAction(CSV, "other");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/could not be marked complete\. Do not run it again/);
    const line = String(log.mock.calls.at(-1)?.[0]);
    expect(line).toContain("import_batch_completion_mark_failed");
    expect(line).not.toMatch(/one@example|Synthetic/);
    log.mockRestore();
    expect(db.clients).toHaveLength(2);
    expect(db.memories).toHaveLength(2);
    expect(db.batches[0].completed_at).toBeUndefined();
    expect(db.batches[0].voided_at).toBeUndefined();
  });

  it("when the completed_at update matches ZERO rows (no error): treated as a failed completion mark, with the same sentence and a distinct 'no_rows' code in the log", async () => {
    db.batchCompleteZeroRows = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { confirmImportAction } = await import("@/app/(app)/settings/import/actions");
    const r = await confirmImportAction(CSV, "other");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/could not be marked complete\. Do not run it again/);
    const line = String(log.mock.calls.at(-1)?.[0]);
    expect(line).toContain("import_batch_completion_mark_failed");
    expect(line).toContain("no_rows");
    log.mockRestore();
    expect(db.batches[0].completed_at).toBeUndefined();
    expect(db.batches[0].voided_at).toBeUndefined();
  });
});
