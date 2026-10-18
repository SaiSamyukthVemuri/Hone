import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import { readingsForBlock, type MachineDb } from "@/lib/machines/machine-queries";

// ===========================================================================
// A BLOCK'S READINGS ARE READ COMPLETELY, OR THE READ FAILS
// (Codex, #860 4288424513, then 4305555264)
// ===========================================================================
//
// ROUND ONE. The read asked for `.order("field_key").limit(500)`. Two faults
// compounded: a block CAN exceed the cap, and ordered by `field_key` ALONE the
// cap does not cut at a capture boundary - it cuts mid-alphabet across every
// capture at once, so the surface rendered captures MISSING SOME FIELDS. A
// complete-looking record of a treatment that never happened. Raising the
// limit would only have moved the cliff, because PostgREST answers a read past
// `max_rows` with 200, the first window and no error.
//
// ROUND TWO, AND WHY THIS FILE LOOKS DIFFERENT NOW. The keyset pagination that
// replaced it paged over `id`, and those ids are random UUIDs across SEPARATE
// requests - so a capture committed to this block mid-loop could sort either
// side of the cursor. Rows before it were never seen, rows after it were
// included, and part of a new capture could come back as a complete setup.
//
// A PAGE LOOP CAN ONLY DETECT THAT; IT CANNOT AVOID IT. So the loop is gone:
// `setup_readings_for_block` is ONE STATEMENT, and one statement is one MVCC
// snapshot - a concurrent commit is either wholly in it or wholly out.
//
// SIX CASES WERE DELETED HERE, DELIBERATELY, and they are named so nobody
// looks for them: "returns rows from BEYOND the first page", "does NOT trust a
// short page to be the last one", "never splits a capture, however the cap
// falls", "refuses when the keyset does not advance", "refuses when a row
// carries no id to page by", and "refuses at the page ceiling instead of
// truncating". Every one of them asserted that the loop NOTICED its own
// incoherence. There is no loop to notice anything, and a test that pins a
// mechanism after the mechanism is gone is a test that passes for ever.
//
// WHAT REPLACES THEM is the property they were approximating: the read is a
// single call, it is not assembled from windows, and the application cannot
// reintroduce one without the source contract at the bottom of this file going
// red.
// ===========================================================================

type Row = Record<string, unknown>;

/** One reading row, shaped as the function returns it. */
function row(id: string, o: Partial<Row> = {}): Row {
  return {
    session_block_id: "block-1",
    machine_profile_id: "fixture:paging",
    machine_profile_version: 1,
    mode_key: "galvanic",
    group_key: "g1",
    channels: [],
    stage_key: null,
    field_key: "current",
    value_numeric: "120",
    absence_reason: null,
    native_unit: "µA",
    decimals: 0,
    revision: 1,
    capture_id: `cap-${id}`,
    studio_machine_id: "dev-1",
    observation_source: "machine-displayed",
    recorded_at: "2026-10-15T10:00:00Z",
    ...o,
  };
}

type FakeOptions = {
  error?: { message: string; code?: string };
  /** Hand back something that is not an array, as a broken client would. */
  notAnArray?: boolean;
};

function fakeDb(rows: Row[], opts: FakeOptions = {}) {
  // EVERY RPC CALL, so "exactly one" is provable rather than assumed.
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const db = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (opts.error) return Promise.resolve({ data: null, error: opts.error });
      if (opts.notAnArray) return Promise.resolve({ data: {}, error: null });
      return Promise.resolve({ data: rows, error: null });
    },
    from: () => {
      throw new Error(
        "the read must not touch a table directly - it goes through the RPC",
      );
    },
  } as unknown as MachineDb;
  return { db, calls };
}

describe("readingsForBlock is ONE statement, so it cannot return half a block", () => {
  it("makes exactly one call, and it is the reader function", async () => {
    // THE WHOLE POINT. More than one request is more than one snapshot, which
    // is the defect; a single call is what makes the result coherent.
    const { db, calls } = fakeDb([row("r1"), row("r2")]);

    const out = await readingsForBlock(db, "block-1", "session-1");

    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("setup_readings_for_block");
  });

  it("binds the block to the session IN the call, not before it", async () => {
    // The lineage used to be a separate bounded lookup HERE, sound only
    // because `session_blocks.session_id` is immutable - a property of a
    // trigger in another file. It lives in the function now, as both an
    // `exists` refusal and a join predicate, so the session id has to reach it
    // or the read cannot be bound at all (Codex, #860 4298457378).
    const { db, calls } = fakeDb([row("r1")]);

    await readingsForBlock(db, "block-7", "session-9");

    expect(calls[0]!.args).toEqual({
      p_block_id: "block-7",
      p_session_id: "session-9",
    });
  });

  it("returns a large block WHOLE, with no cap to fall under", async () => {
    // The number is deliberately past both the old 500 limit and the 1,000
    // page size: neither is a boundary any more, and a result that came back
    // short here would mean a window had reappeared somewhere.
    const many = Array.from({ length: 2500 }, (_, i) =>
      row(`r${String(i).padStart(4, "0")}`),
    );
    const { db, calls } = fakeDb(many);

    const out = await readingsForBlock(db, "block-1", "session-1");

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toHaveLength(2500);
    expect(calls).toHaveLength(1);
  });

  it("does not sort in memory - the ORDER is the database's", async () => {
    // Ordering is part of what makes a retrieved setup reproducible, so it
    // belongs with the read. Re-sorting here would also hide a function that
    // had stopped ordering at all.
    const { db } = fakeDb([
      row("r1", { field_key: "duration" }),
      row("r2", { field_key: "current" }),
    ]);

    const out = await readingsForBlock(db, "block-1", "session-1");

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.map((r) => r.fieldKey)).toEqual(["duration", "current"]);
  });
});

describe("readingsForBlock fails CLOSED rather than returning part of a block", () => {
  it("refuses on a failed read, and passes the server's own words through", async () => {
    const { db } = fakeDb([], { error: { message: "connection reset" } });

    const out = await readingsForBlock(db, "block-1", "session-1");

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("connection reset");
  });

  it("uses the fallback sentence when the failure carries no message", async () => {
    const { db } = fakeDb([], { error: { message: "" } });

    const out = await readingsForBlock(db, "block-1", "session-1");

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe("Could not read settings.");
  });

  it("refuses when the client hands back something that is not a list", async () => {
    const { db } = fakeDb([], { notAnArray: true });

    const out = await readingsForBlock(db, "block-1", "session-1");

    expect(out.ok).toBe(false);
  });

  it("CONTROL: an empty block is an ordinary EMPTY success, not a refusal", async () => {
    // Without this the refusals above would also pass if the read refused
    // everything, and a treatment with no settings yet is the ordinary case
    // on every new area.
    const { db } = fakeDb([]);

    const out = await readingsForBlock(db, "block-1", "session-1");

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toEqual([]);
  });

  it("a block in another session arrives as a REFUSAL, not an empty success", async () => {
    // The function RAISES for a block it cannot see or that is not in the
    // given session, identically to one that does not exist - so it reaches
    // here as an ordinary RPC error. Answering `[]` would have rendered "no
    // settings recorded" to someone with no business there, reversing a
    // decision the paginated read already encoded.
    const { db } = fakeDb([], {
      error: { message: "Unknown treatment block for this session.", code: "P0002" },
    });

    const out = await readingsForBlock(db, "someone-elses-block", "session-1");

    expect(out.ok).toBe(false);
  });

  it("and the practitioner is shown the GENERIC sentence, not the precise one", async () => {
    // THE TWO CASES MUST READ ALIKE. A practitioner cannot tell "not yours"
    // from "the database is unhappy", so neither can anyone probing with
    // someone else's block id. The database keeps the precise sentence
    // because a refusal has to be provable; this is where it stops.
    const { db } = fakeDb([], {
      error: { message: "Unknown treatment block for this session.", code: "P0002" },
    });

    const out = await readingsForBlock(db, "someone-elses-block", "session-1");

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe("Could not read settings.");
    expect(
      out.error,
      "the database's precise sentence reached the practitioner",
    ).not.toContain("Unknown treatment block");
  });

  it("CONTROL: a failure with ANOTHER code still passes its words through", async () => {
    // Without this the mapping above would also pass if it swallowed every
    // message, and "connection reset" is exactly the detail worth keeping.
    const { db } = fakeDb([], {
      error: { message: "connection reset", code: "08006" },
    });

    const out = await readingsForBlock(db, "block-1", "session-1");

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("connection reset");
  });
});

describe("retrieved readings keep their observation provenance", () => {
  it("carries the RECORDED source back, not the contract's expectation", async () => {
    // THE DEFECT (Codex, #860 4294673727). The write path stored
    // `observation_source` and the SQL emitted it, but the shared column list
    // omitted it and `toReading` dropped it, so previous-treatment and
    // recorded-history both lost provenance permanently at the application
    // boundary.
    //
    // DERIVING IT FROM THE PROFILE DOES NOT RECOVER IT. `validateReading`
    // deliberately permits a mismatch and records what actually happened, so
    // a field the contract calls machine-displayed can legitimately carry a
    // practitioner-entered reading. That exception is the one case where
    // provenance matters, and it is exactly the case derivation destroys.
    const { db } = fakeDb([
      row("r1", { observation_source: "practitioner-entered" }),
      row("r2", { field_key: "duration", observation_source: "estimated" }),
    ]);

    const out = await readingsForBlock(db, "block-1", "session-1");

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.map((r) => r.observationSource)).toEqual([
      "practitioner-entered",
      "estimated",
    ]);
  });

  it("the FUNCTION emits the column, so a mapping test cannot pass alone", async () => {
    // The omission was in the SELECT list, so a mapping test alone would have
    // passed against a query that never requested it. The list lives in SQL
    // now, which is where this has to be checked - there is no client-side
    // column string left to inspect.
    const sql = readFileSync(
      nodePath.resolve(
        __dirname,
        "../../..",
        "supabase/migrations/0223_machine_inventory_and_setup_readings.sql",
      ),
      "utf8",
    );
    const at = sql.indexOf(
      "create or replace function public.setup_readings_for_block(",
    );
    expect(at, "the reader function is gone").toBeGreaterThan(-1);
    const body = sql.slice(at, sql.indexOf("$$;", at));
    for (const col of [
      "observation_source",
      "native_unit",
      "decimals",
      "revision",
      "capture_id",
      "group_key",
      "channels",
      "stage_key",
      "absence_reason",
    ]) {
      expect(body, `the reader does not emit ${col}`).toContain(`'${col}',`);
    }
  });

  it("a row written before the column existed reads as UNKNOWN, not assumed", async () => {
    const { db } = fakeDb([row("r1", { observation_source: null })]);

    const out = await readingsForBlock(db, "block-1", "session-1");

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value[0]!.observationSource).toBeNull();
  });

  it("an unrecognised value is null rather than asserted into the union", async () => {
    // Narrowed against the same list the write path validates, so a value
    // outside it cannot be typed as one of the four by a cast.
    const { db } = fakeDb([row("r1", { observation_source: "guessed" })]);

    const out = await readingsForBlock(db, "block-1", "session-1");

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value[0]!.observationSource).toBeNull();
  });
});

describe("the page loop cannot come back", () => {
  it("the reader holds no cursor, no page size and no page ceiling", () => {
    // WHY A SOURCE CONTRACT. Everything above runs against a fake that serves
    // one call; none of it would fail if someone reintroduced a loop that
    // happened to finish in one iteration against that fake. This is the
    // assertion that notices.
    const src = readFileSync(
      nodePath.resolve(__dirname, "../../..", "lib/machines/machine-queries.ts"),
      "utf8",
    );
    const at = src.indexOf("export async function readingsForBlock(");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\nexport ", at + 1));
    // Comments are NOT stripped here on purpose: the body's own comments
    // explain the defect and name these very words, so stripping them would
    // be the only way to keep the assertion honest... which is why each check
    // targets a code form rather than a word.
    expect(body, "a keyset cursor is back").not.toMatch(/\.gt\(/);
    expect(body, "a page loop is back").not.toMatch(/for \(let page/);
    expect(body, "a row limit is back").not.toMatch(/\.limit\(/);
    expect(body, "the read goes through the RPC").toContain(
      'db.rpc("setup_readings_for_block"',
    );
  });

  it("and the pagination constants are gone with it", () => {
    // Left exported, they read as a supported knob and invite a caller to
    // page again somewhere else.
    const src = readFileSync(
      nodePath.resolve(__dirname, "../../..", "lib/machines/machine-queries.ts"),
      "utf8",
    );
    expect(src).not.toContain("BLOCK_READING_PAGE_SIZE");
    expect(src).not.toContain("BLOCK_READING_MAX_PAGES");
  });
});
