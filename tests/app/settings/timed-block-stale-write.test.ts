import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STALE_BLOCK_MESSAGE,
  readExpectedBlockVersion,
} from "@/lib/booking/timed-block-version";

// HON-48 five-user acceptance: two people editing or deleting one calendar block
// must not silently overwrite each other. The block row already carries
// updated_at, so the protection needs no schema: the form sends back the version
// it loaded and the write only applies when the row still has it. The REAL
// actions run against an in-memory table that applies the same filters
// PostgREST would, so "refused" means the conditional statement matched no row.
// Synthetic ids only.

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  rows: [] as Row[],
  writes: [] as Array<{ op: string; payload?: Row; filters: Array<[string, unknown]> }>,
  // Runs once, between the action's read and its write: another session's save.
  interleave: null as null | (() => void),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "prac-owner", role: "owner", active: true },
    studio: { id: "studio-A", timezone: "America/Los_Angeles", practitioner_capacity_enabled: false },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      expect(table).toBe("studio_timed_blocks");
      let op: "select" | "update" | "delete" = "select";
      let payload: Row | undefined;
      const filters: Array<[string, unknown]> = [];
      const matching = () => db.rows.filter((r) => filters.every(([c, v]) => r[c] === v));
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.update = (p: Row) => { op = "update"; payload = p; return q; };
      q.delete = () => { op = "delete"; return q; };
      q.eq = (c: string, v: unknown) => { filters.push([c, v]); return q; };
      q.maybeSingle = async () => {
        const hit = matching()[0] ?? null;
        const snapshot = hit ? { ...hit } : null;
        // The action has now READ the row: let a competing save land before its write.
        if (db.interleave) { const f = db.interleave; db.interleave = null; f(); }
        return { data: snapshot, error: null };
      };
      q.then = (resolve: (v: unknown) => unknown) => {
        const hits = matching();
        db.writes.push({ op, payload, filters: [...filters] });
        if (op === "update") for (const r of hits) Object.assign(r, payload);
        if (op === "delete") db.rows = db.rows.filter((r) => !hits.includes(r));
        return Promise.resolve({ data: hits.map((r) => ({ id: r.id })), error: null }).then(resolve);
      };
      return q;
    },
  }),
}));

import { deleteTimedBlockAction, updateTimedBlockAction } from "@/app/(app)/settings/availability/actions";

const V1 = "2099-01-01T10:00:00.123456+00:00";
const V2 = "2099-01-01T10:05:00.654321+00:00";

function block(over: Row = {}): Row {
  return {
    id: "blk-1", studio_id: "studio-A", practitioner_id: null, category: "lunch", private_note: null,
    starts_at: "2099-01-02T18:00:00.000Z", ends_at: "2099-01-02T19:00:00.000Z", updated_at: V1, ...over,
  };
}

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const EDIT = { id: "blk-1", date: "2099-01-02", start_local: "10:00", end_local: "11:00", category: "meeting", private_note: "" };

beforeEach(() => {
  db.rows = [block()];
  db.writes = [];
  db.interleave = null;
});

describe("readExpectedBlockVersion", () => {
  it.each([[null], [undefined], [""], ["   "]])("%j is absent (a legacy form keeps last-write-wins)", (raw) => {
    expect(readExpectedBlockVersion(raw)).toEqual({ kind: "absent" });
  });
  it("accepts the microsecond timestamp PostgREST returns, untouched", () => {
    expect(readExpectedBlockVersion(V1)).toEqual({ kind: "present", value: V1 });
    expect(readExpectedBlockVersion("2099-01-01T10:00:00Z")).toEqual({ kind: "present", value: "2099-01-01T10:00:00Z" });
  });
  it.each([["yesterday"], ["2099-01-01"], ["1; drop table"], ["2099-01-01T10:00:00"]])("%j is invalid, never treated as absent", (raw) => {
    expect(readExpectedBlockVersion(raw)).toEqual({ kind: "invalid" });
  });
});

describe("edit", () => {
  it("applies when the version still matches, and moves the version forward", async () => {
    const res = await updateTimedBlockAction(form({ ...EDIT, expected_updated_at: V1 }));
    expect(res).toEqual({ ok: true });
    expect(db.rows[0].category).toBe("meeting");
    expect(db.rows[0].updated_at).not.toBe(V1);
  });

  it("refuses a stale version: nothing is written and the person is told to look at the latest", async () => {
    db.rows[0].updated_at = V2; // someone saved after this form loaded
    const res = await updateTimedBlockAction(form({ ...EDIT, expected_updated_at: V1 }));
    expect(res).toEqual({ ok: false, error: STALE_BLOCK_MESSAGE, stale: true });
    expect(db.rows[0].category).toBe("lunch");
    expect(db.writes.filter((w) => w.op === "update")).toHaveLength(0);
  });

  it("a save that lands BETWEEN this action's read and its write still cannot be overwritten (the write is conditional)", async () => {
    db.interleave = () => { db.rows[0].category = "personal"; db.rows[0].updated_at = V2; };
    const res = await updateTimedBlockAction(form({ ...EDIT, expected_updated_at: V1 }));
    expect(res).toEqual({ ok: false, error: STALE_BLOCK_MESSAGE, stale: true });
    expect(db.rows[0].category).toBe("personal"); // the other person's change survives
    const write = db.writes.find((w) => w.op === "update");
    expect(write?.filters).toContainEqual(["updated_at", V1]);
  });

  it("a block deleted since the form loaded is reported as changed, not as 'not found'", async () => {
    db.rows = [];
    expect(await updateTimedBlockAction(form({ ...EDIT, expected_updated_at: V1 }))).toMatchObject({ ok: false, stale: true });
  });

  it("an older form with no version behaves exactly as before (last write wins)", async () => {
    db.rows[0].updated_at = V2;
    expect(await updateTimedBlockAction(form(EDIT))).toEqual({ ok: true });
    expect(db.rows[0].category).toBe("meeting");
    expect(db.writes.find((w) => w.op === "update")?.filters.map(([c]) => c)).not.toContain("updated_at");
  });

  it("a malformed version is refused before anything is read or written", async () => {
    const res = await updateTimedBlockAction(form({ ...EDIT, expected_updated_at: "later" }));
    expect(res.ok).toBe(false);
    expect(db.writes).toHaveLength(0);
    expect(db.rows[0].category).toBe("lunch");
  });
});

describe("delete", () => {
  it("deletes the block the person was looking at", async () => {
    expect(await deleteTimedBlockAction(form({ id: "blk-1", expected_updated_at: V1 }))).toEqual({ ok: true });
    expect(db.rows).toHaveLength(0);
  });

  it("does NOT delete a block someone edited since: they may not have meant that version", async () => {
    db.rows[0].updated_at = V2;
    const res = await deleteTimedBlockAction(form({ id: "blk-1", expected_updated_at: V1 }));
    expect(res).toEqual({ ok: false, error: STALE_BLOCK_MESSAGE, stale: true });
    expect(db.rows).toHaveLength(1);
  });

  it("a block already deleted by someone else is simply done (idempotent), not an error", async () => {
    db.rows = [];
    expect(await deleteTimedBlockAction(form({ id: "blk-1", expected_updated_at: V1 }))).toEqual({ ok: true });
  });

  it("an older form with no version deletes by id exactly as before", async () => {
    db.rows[0].updated_at = V2;
    expect(await deleteTimedBlockAction(form({ id: "blk-1" }))).toEqual({ ok: true });
    expect(db.rows).toHaveLength(0);
  });

  it("is studio-scoped: another studio's block is untouched", async () => {
    db.rows = [block({ studio_id: "studio-B" })];
    await deleteTimedBlockAction(form({ id: "blk-1", expected_updated_at: V1 }));
    expect(db.rows).toHaveLength(1);
  });
});
