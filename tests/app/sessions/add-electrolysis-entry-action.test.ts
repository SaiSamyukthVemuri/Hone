import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Behavioural test of addElectrolysisEntryAction covering the corrected contracts:
//   * Gate 3, malformed / non-array chip payload FAILS before any insert (never
//     silently coerced to [] then "verified" as success).
//   * Gate 4, STRICT read-back: a raw stored duplicate / non-canonical / non-array
//     value fails verification (not masked by dedup).
//   * Gate 5, the read-back is a SEPARATE query by the written row id (scoped to
//     the session); a post-write failure returns a distinct persisted-but-
//     unverified result carrying the entryId and does NOT auto-retry.
//
// L18 Phase 2: the write is no longer a direct INSERT, it is the
// `add_electrolysis_pass` command (migration 0166), which resolves the block and
// writes the entry in one transaction. Every gate above is unchanged in
// meaning; what the mock counts is now the RPC rather than the insert chain.
//
// The mock supabase distinguishes the WRITE (rpc) from the SEPARATE read chain
// (select("observation_chips") → eq(id) → eq(session_id) → maybeSingle) and from
// assertSessionVisible's sessions read, and counts each so "zero writes" / "one
// separate read" are directly asserted.

const A = "Coarse hair";
const B = "Slight swelling (edema)";

type Ret = { data: unknown; error: unknown };
const state = {
  writeCalls: 0,
  writeName: "" as string,
  writePayload: null as Record<string, unknown> | null,
  writeReturn: { data: [{ block_id: "b1", entry_id: "e1" }], error: null } as Ret,
  readCalls: 0,
  readEqs: {} as Record<string, unknown>,
  readReturn: { data: { observation_chips: [] }, error: null } as Ret,
  sessionRow: { id: "s1" } as unknown,
};

function makeMockSupabase() {
  return {
    from(table: string) {
      const eqs: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          eqs[col] = val;
          return builder;
        },
        // No runtime writer inserts into these tables any more; if one ever
        // reappears the mock records it so a test can catch it.
        insert: (payload: Record<string, unknown>) => {
          state.writeCalls++;
          state.writeName = `direct-insert:${table}`;
          state.writePayload = payload;
          return builder;
        },
        single: async () => state.writeReturn,
        maybeSingle: async () => {
          if (table === "sessions") return { data: state.sessionRow, error: null };
          if (table === "electrolysis_entries") {
            // The SEPARATE read-back by id.
            state.readCalls++;
            state.readEqs = eqs;
            return state.readReturn;
          }
          return { data: null, error: null };
        },
      });
      return builder;
    },
    // The 0166 command. Returns setof (block_id, entry_id), so the action must
    // read the first row rather than a scalar.
    rpc: async (name: string, payload: Record<string, unknown>) => {
      state.writeCalls++;
      state.writeName = name;
      state.writePayload = payload;
      return state.writeReturn;
    },
  };
}

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => makeMockSupabase()),
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(async () => ({
    studio: { id: "studio1" },
    practitioner: { id: "p1", user_id: "u1", active: true, role: "owner" },
  })),
}));
vi.mock("@/lib/sessions/probe-lot-validation", () => ({
  validateProbeLotId: vi.fn(async () => ({ ok: true, value: null })),
  isUuid: () => false,
}));

import { addElectrolysisEntryAction } from "@/app/(app)/clients/[id]/sessions/[sessionId]/actions";

function fd(opts: {
  chips?: string;
  omitChips?: boolean;
  omitBlockId?: boolean;
  comments?: string;
} = {}): FormData {
  const f = new FormData();
  f.set("session_id", "s1");
  f.set("client_id", "c1");
  if (!opts.omitBlockId) f.set("block_id", "b1");
  f.set("areas", JSON.stringify(["Chin"]));
  f.set("comments", opts.comments ?? "");
  if (!opts.omitChips) f.set("observation_chips", opts.chips ?? "[]");
  return f;
}

beforeEach(() => {
  state.writeCalls = 0;
  state.writeName = "";
  state.writePayload = null;
  state.writeReturn = { data: [{ block_id: "b1", entry_id: "e1" }], error: null };
  state.readCalls = 0;
  state.readEqs = {};
  state.readReturn = { data: { observation_chips: [] }, error: null };
  state.sessionRow = { id: "s1" };
});
afterEach(() => vi.clearAllMocks());

describe("Gate 3: malformed-payload contract (fail BEFORE any insert)", () => {
  it("MISSING field → normalizes to [], proceeds, creates exactly one entry", async () => {
    const res = await addElectrolysisEntryAction(fd({ omitChips: true }));
    expect(res).toEqual({ ok: true, entryId: "e1", observationChips: [] });
    expect(state.writeCalls).toBe(1);
    expect(state.writePayload?.p_observation_chips).toEqual([]);
  });

  it("EXPLICIT empty array → [], proceeds, one entry", async () => {
    const res = await addElectrolysisEntryAction(fd({ chips: "[]" }));
    expect(res).toEqual({ ok: true, entryId: "e1", observationChips: [] });
    expect(state.writeCalls).toBe(1);
  });

  it("MALFORMED JSON → invalid_input, ZERO inserts, NO verification query, no success", async () => {
    const res = await addElectrolysisEntryAction(fd({ chips: "{ not json" }));
    expect(res).toEqual({ ok: false, code: "invalid_input", error: expect.any(String) });
    expect(state.writeCalls).toBe(0);
    expect(state.readCalls).toBe(0);
  });

  it("parsed OBJECT → invalid_input, zero inserts", async () => {
    const res = await addElectrolysisEntryAction(fd({ chips: '{"a":1}' }));
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
    expect(state.writeCalls).toBe(0);
  });

  it("parsed STRING → invalid_input, zero inserts", async () => {
    const res = await addElectrolysisEntryAction(fd({ chips: '"Coarse hair"' }));
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
    expect(state.writeCalls).toBe(0);
  });

  it("parsed NUMBER → invalid_input, zero inserts", async () => {
    const res = await addElectrolysisEntryAction(fd({ chips: "42" }));
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
    expect(state.writeCalls).toBe(0);
  });

  it("parsed NULL → invalid_input, zero inserts", async () => {
    const res = await addElectrolysisEntryAction(fd({ chips: "null" }));
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
    expect(state.writeCalls).toBe(0);
  });

  it("does not expose raw JSON/parse internals in the error", async () => {
    const res = await addElectrolysisEntryAction(fd({ chips: "{ not json" }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toMatch(/JSON|SyntaxError|token|position/i);
    }
  });
});

describe("Gate 4: duplicate-verification contract (raw stored duplicate FAILS)", () => {
  it("submitted duplicates are DEDUPED before insert (one canonical copy)", async () => {
    state.readReturn = { data: { observation_chips: [A] }, error: null };
    const res = await addElectrolysisEntryAction(
      fd({ chips: JSON.stringify(["Coarse hair", "coarse hair", "COARSE HAIR"]) }),
    );
    expect(state.writePayload?.p_observation_chips).toEqual([A]);
    expect(res).toEqual({ ok: true, entryId: "e1", observationChips: [A] });
  });

  it("reordered stored chips verify successfully (order-insensitive)", async () => {
    state.readReturn = { data: { observation_chips: [B, A] }, error: null };
    const res = await addElectrolysisEntryAction(fd({ chips: JSON.stringify([A, B]) }));
    expect(res).toMatchObject({ ok: true });
  });

  it("stored array MISSING an expected chip → unverified", async () => {
    state.readReturn = { data: { observation_chips: [A] }, error: null };
    const res = await addElectrolysisEntryAction(fd({ chips: JSON.stringify([A, B]) }));
    expect(res).toMatchObject({ ok: false, code: "unverified", entryId: "e1" });
  });

  it("stored array with an UNEXPECTED extra chip → unverified", async () => {
    state.readReturn = { data: { observation_chips: [A, B] }, error: null };
    const res = await addElectrolysisEntryAction(fd({ chips: JSON.stringify([A]) }));
    expect(res).toMatchObject({ ok: false, code: "unverified" });
  });

  it("stored RAW DUPLICATE → unverified (does NOT report verified success)", async () => {
    // The crux: DB holds ["Coarse hair","Coarse hair"] but we submitted one.
    state.readReturn = { data: { observation_chips: [A, A] }, error: null };
    const res = await addElectrolysisEntryAction(fd({ chips: JSON.stringify([A]) }));
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "unverified", entryId: "e1" });
  });

  it("stored NON-CANONICAL casing → unverified (documented strict contract)", async () => {
    state.readReturn = { data: { observation_chips: ["coarse hair"] }, error: null };
    const res = await addElectrolysisEntryAction(fd({ chips: JSON.stringify([A]) }));
    expect(res).toMatchObject({ ok: false, code: "unverified" });
  });

  it("stored NON-ARRAY value → unverified", async () => {
    state.readReturn = { data: { observation_chips: "Coarse hair" }, error: null };
    const res = await addElectrolysisEntryAction(fd({ chips: JSON.stringify([A]) }));
    expect(res).toMatchObject({ ok: false, code: "unverified" });
  });
});

describe("Gate 5: atomicity / retry safety", () => {
  it("SUCCESS: exactly one insert + exactly one SEPARATE read by the returned id (session-scoped)", async () => {
    state.readReturn = { data: { observation_chips: [A] }, error: null };
    const res = await addElectrolysisEntryAction(fd({ chips: JSON.stringify([A]) }));
    expect(res).toEqual({ ok: true, entryId: "e1", observationChips: [A] });
    expect(state.writeCalls).toBe(1);
    expect(state.readCalls).toBe(1);
    // The verification query targets the exact inserted row id + the session.
    expect(state.readEqs).toMatchObject({ id: "e1", session_id: "s1" });
  });

  it("WRITE failure → not_persisted, NO read-back query, zero persisted", async () => {
    state.writeReturn = { data: null, error: { message: "insert boom" } };
    const res = await addElectrolysisEntryAction(fd({ chips: JSON.stringify([A]) }));
    expect(res).toMatchObject({ ok: false, code: "not_persisted" });
    expect(state.readCalls).toBe(0);
  });

  it("SEPARATE read failure → persisted-but-unverified, keeps the entryId (no rollback pretense)", async () => {
    state.readReturn = { data: null, error: { message: "read boom" } };
    const res = await addElectrolysisEntryAction(fd({ chips: JSON.stringify([A]) }));
    expect(res).toMatchObject({ ok: false, code: "unverified", entryId: "e1" });
    expect(state.writeCalls).toBe(1);
  });

  it("read returns NO ROW → unverified (does not claim rollback)", async () => {
    state.readReturn = { data: null, error: null };
    const res = await addElectrolysisEntryAction(fd({ chips: JSON.stringify([A]) }));
    expect(res).toMatchObject({ ok: false, code: "unverified", entryId: "e1" });
  });

  it("read-back MISMATCH → unverified and does NOT auto-issue a second insert", async () => {
    state.readReturn = { data: { observation_chips: [] }, error: null }; // stored dropped the chip
    const res = await addElectrolysisEntryAction(fd({ chips: JSON.stringify([A]) }));
    expect(res).toMatchObject({ ok: false, code: "unverified" });
    expect(state.writeCalls).toBe(1); // exactly one, never a blind retry inside the action
  });

  it("comments stay SEPARATE from the chip array in the command payload", async () => {
    state.readReturn = { data: { observation_chips: [A] }, error: null };
    await addElectrolysisEntryAction(
      fd({ chips: JSON.stringify([A]), comments: "tender near jaw" }),
    );
    expect(state.writePayload?.p_comments).toBe("tender near jaw");
    expect(state.writePayload?.p_observation_chips).toEqual([A]);
  });

  it("the write is the 0166 command, never a direct insert", async () => {
    state.readReturn = { data: { observation_chips: [A] }, error: null };
    await addElectrolysisEntryAction(fd({ chips: JSON.stringify([A]) }));
    expect(state.writeName).toBe("add_electrolysis_pass");
    expect(state.writeName).not.toMatch(/^direct-insert:/);
  });

  it("an explicit block_id is forwarded; the command is not asked to guess", async () => {
    state.readReturn = { data: { observation_chips: [] }, error: null };
    await addElectrolysisEntryAction(fd());
    expect(state.writePayload?.p_block_id).toBe("b1");
  });

  it("a MISSING block_id sends null plus the default bag, the DB resolves it", async () => {
    state.readReturn = { data: { observation_chips: [] }, error: null };
    await addElectrolysisEntryAction(fd({ omitBlockId: true }));
    expect(state.writePayload?.p_block_id).toBeNull();
    // The application no longer reads or inserts a block itself.
    expect(state.writePayload?.p_block_defaults).toMatchObject({ block_name: "Main" });
    expect(state.writeCalls).toBe(1);
  });

  it("a command failure never leaks the raw database message", async () => {
    state.writeReturn = {
      data: null,
      error: { message: 'duplicate key value violates unique constraint "entries_pkey"' },
    };
    const res = await addElectrolysisEntryAction(fd({ chips: JSON.stringify([A]) }));
    expect(res).toMatchObject({ ok: false, code: "not_persisted" });
    if (!res.ok) {
      expect(res.error).not.toMatch(/constraint|duplicate key|pkey/i);
    }
  });

  it("galvanic_intensity_percent has no parameter to forge", async () => {
    state.readReturn = { data: { observation_chips: [] }, error: null };
    await addElectrolysisEntryAction(fd());
    expect(state.writePayload).not.toHaveProperty("p_galvanic_intensity_percent");
    expect(state.writePayload).not.toHaveProperty("galvanic_intensity_percent");
  });
});
