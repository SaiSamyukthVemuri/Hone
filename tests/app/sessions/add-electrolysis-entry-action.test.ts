import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Gate 3 + 4 — behavioural test of addElectrolysisEntryAction: the submitted
// observation_chips reach the action, are normalized/deduped, the insert receives
// the canonical array (comments separate), a malformed payload cannot silently
// produce an unexpected stored value, and — the structural fix — the PERSISTED
// row is re-read and compared, failing visibly on any silent partial write.

let capturedInsert: Record<string, unknown> | null = null;
let insertReturn: { data: unknown; error: unknown } = { data: { observation_chips: [] }, error: null };
let sessionRow: unknown = { id: "s1" };

function makeMockSupabase() {
  const client = {
    from(_table: string) {
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: () => builder,
        eq: () => builder,
        insert: (payload: Record<string, unknown>) => {
          capturedInsert = payload;
          return builder;
        },
        single: async () => insertReturn,
        maybeSingle: async () => ({ data: sessionRow, error: null }),
      });
      return builder;
    },
  };
  return client;
}

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => makeMockSupabase()) }));
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

function fdFor(observationChipsJson: string, comments = ""): FormData {
  const fd = new FormData();
  fd.set("session_id", "s1");
  fd.set("client_id", "c1");
  fd.set("block_id", "b1"); // provided → ensureBlockForSession is skipped
  fd.set("areas", JSON.stringify(["Chin"]));
  fd.set("comments", comments);
  fd.set("observation_chips", observationChipsJson);
  return fd;
}

beforeEach(() => {
  capturedInsert = null;
  insertReturn = { data: { observation_chips: [] }, error: null };
  sessionRow = { id: "s1" };
});
afterEach(() => vi.clearAllMocks());

describe("submitted chips reach the insert, normalized + deduped, comments separate", () => {
  it("dedups + canonicalizes + drops unknowns; comments stay separate", async () => {
    insertReturn = { data: { observation_chips: ["Coarse hair", "Slight edema"] }, error: null };
    const res = await addElectrolysisEntryAction(
      fdFor(JSON.stringify(["coarse HAIR", "Coarse hair", "Slight edema", "not a chip"]), "tender near jaw"),
    );
    expect(capturedInsert?.observation_chips).toEqual(["Coarse hair", "Slight edema"]);
    expect(capturedInsert?.comments).toBe("tender near jaw");
    expect(res.observationChips).toEqual(["Coarse hair", "Slight edema"]);
  });

  it("a MALFORMED chip payload becomes [] (never a silent unexpected value)", async () => {
    insertReturn = { data: { observation_chips: [] }, error: null };
    const res = await addElectrolysisEntryAction(fdFor("{ not json"));
    expect(capturedInsert?.observation_chips).toEqual([]);
    expect(res.observationChips).toEqual([]);
  });

  it("an empty-array submission persists [] and verifies", async () => {
    insertReturn = { data: { observation_chips: [] }, error: null };
    const res = await addElectrolysisEntryAction(fdFor(JSON.stringify([])));
    expect(res.observationChips).toEqual([]);
  });
});

describe("persisted-row read-back verification (silent-partial-write guard)", () => {
  it("exact match → success returning the verified stored value", async () => {
    insertReturn = { data: { observation_chips: ["Coarse hair"] }, error: null };
    const res = await addElectrolysisEntryAction(fdFor(JSON.stringify(["Coarse hair"])));
    expect(res.observationChips).toEqual(["Coarse hair"]);
  });

  it("MISSING stored chip (silent drop) → throws, does NOT report success", async () => {
    insertReturn = { data: { observation_chips: ["Coarse hair"] }, error: null }; // stored dropped one
    await expect(
      addElectrolysisEntryAction(fdFor(JSON.stringify(["Coarse hair", "Slight edema"]))),
    ).rejects.toThrow(/did not match|not have saved/i);
  });

  it("UNEXPECTED extra stored chip → throws", async () => {
    insertReturn = { data: { observation_chips: ["Coarse hair", "Lots of anagen"] }, error: null };
    await expect(
      addElectrolysisEntryAction(fdFor(JSON.stringify(["Coarse hair"]))),
    ).rejects.toThrow(/did not match|not have saved/i);
  });

  it("DUPLICATE in the stored value normalizes equal (no false failure)", async () => {
    insertReturn = { data: { observation_chips: ["Coarse hair", "coarse hair"] }, error: null };
    const res = await addElectrolysisEntryAction(fdFor(JSON.stringify(["Coarse hair"])));
    expect(res.observationChips).toEqual(["Coarse hair"]);
  });

  it("a DB re-read failure → throws (never an unverified success)", async () => {
    insertReturn = { data: null, error: { message: "read failed" } };
    await expect(
      addElectrolysisEntryAction(fdFor(JSON.stringify(["Coarse hair"]))),
    ).rejects.toThrow(/Failed to add entry/i);
  });
});
