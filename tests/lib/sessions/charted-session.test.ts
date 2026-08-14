import { describe, expect, it } from "vitest";
import {
  chartedSessionCandidates,
  groupBlocksBySession,
  hasChartedContent,
  isChartedSessionCandidate,
  pickNewestChartedSession,
  type ChartedBlockRow,
} from "@/lib/sessions/charted-session";

// THE defect this module exists to prevent: previous-context surfaces selected
// the newest session ROW (`order started_at desc limit 1`), so an empty session,
// which start_session creates the instant a practitioner taps a modality,
// permanently hid the real previous treatment.
//
// Every test here is behavioural. Restoring "newest row wins" (dropping the
// hasChartedContent check from pickNewestChartedSession) must red the first
// describe block; that negative control is recorded in the PR.

type S = {
  id: string;
  started_at: string;
  record_status?: string | null;
  deleted_at?: string | null;
  modality?: string;
  electrolysis_entries?: Array<{ deleted_at?: string | null }>;
  laser_entries?: Array<{ deleted_at?: string | null }>;
};

function session(id: string, startedAt: string, extra: Partial<S> = {}): S {
  return {
    id,
    started_at: startedAt,
    record_status: "draft",
    deleted_at: null,
    electrolysis_entries: [],
    laser_entries: [],
    ...extra,
  };
}

function blocks(
  entries: Record<string, ChartedBlockRow[]>,
): Map<string, ChartedBlockRow[]> {
  return new Map(Object.entries(entries));
}

const LIVE_BLOCK: ChartedBlockRow = { deleted_at: null };

describe("the newest CHARTED session beats a newer empty one", () => {
  it("selects the older charted session when the newest session has nothing on it", () => {
    const newestEmpty = session("s-new", "2026-06-01T10:00:00Z");
    const olderCharted = session("s-old", "2026-01-01T10:00:00Z");

    const picked = pickNewestChartedSession(
      [newestEmpty, olderCharted],
      blocks({ "s-old": [LIVE_BLOCK] }),
    );

    expect(picked?.id).toBe("s-old");
  });

  it("reports that a newer, uncharted session exists via the candidate order", () => {
    const newestEmpty = session("s-new", "2026-06-01T10:00:00Z");
    const olderCharted = session("s-old", "2026-01-01T10:00:00Z");
    const map = blocks({ "s-old": [LIVE_BLOCK] });

    const candidates = chartedSessionCandidates([olderCharted, newestEmpty]);
    const picked = pickNewestChartedSession([olderCharted, newestEmpty], map);

    expect(candidates[0].id).toBe("s-new");
    expect(picked?.id).toBe("s-old");
    // This inequality is exactly what the card renders "a newer session has no
    // treatment details yet" from.
    expect(candidates[0].id).not.toBe(picked?.id);
  });

  it("still prefers the newest session when IT is the charted one", () => {
    const newest = session("s-new", "2026-06-01T10:00:00Z");
    const older = session("s-old", "2026-01-01T10:00:00Z");

    const picked = pickNewestChartedSession(
      [newest, older],
      blocks({ "s-new": [LIVE_BLOCK], "s-old": [LIVE_BLOCK] }),
    );

    expect(picked?.id).toBe("s-new");
  });

  it("does not depend on the input order, it sorts newest-first itself", () => {
    const a = session("s-a", "2026-01-01T10:00:00Z");
    const b = session("s-b", "2026-03-01T10:00:00Z");
    const map = blocks({ "s-a": [LIVE_BLOCK], "s-b": [LIVE_BLOCK] });

    expect(pickNewestChartedSession([a, b], map)?.id).toBe("s-b");
    expect(pickNewestChartedSession([b, a], map)?.id).toBe("s-b");
  });

  it("breaks an exact started_at tie deterministically (id descending)", () => {
    const at = "2026-02-02T09:00:00Z";
    const lo = session("aaaa", at);
    const hi = session("zzzz", at);
    const map = blocks({ aaaa: [LIVE_BLOCK], zzzz: [LIVE_BLOCK] });

    expect(pickNewestChartedSession([lo, hi], map)?.id).toBe("zzzz");
    expect(pickNewestChartedSession([hi, lo], map)?.id).toBe("zzzz");
  });
});

describe("what counts as charted", () => {
  it("a session row on its own is NOT charted", () => {
    const s = session("s1", "2026-01-01T10:00:00Z");
    expect(hasChartedContent(s, blocks({}))).toBe(false);
    expect(pickNewestChartedSession([s], blocks({}))).toBeNull();
  });

  it("an EMPTY blocks array is not charted", () => {
    const s = session("s1", "2026-01-01T10:00:00Z");
    expect(hasChartedContent(s, blocks({ s1: [] }))).toBe(false);
  });

  it("a live settings block qualifies", () => {
    const s = session("s1", "2026-01-01T10:00:00Z");
    expect(hasChartedContent(s, blocks({ s1: [LIVE_BLOCK] }))).toBe(true);
  });

  it("a live electrolysis entry qualifies even with no blocks (legacy chart)", () => {
    const s = session("s1", "2026-01-01T10:00:00Z", {
      electrolysis_entries: [{ deleted_at: null }],
    });
    expect(hasChartedContent(s, blocks({}))).toBe(true);
  });

  it("a live laser entry qualifies, a laser visit is still the last treatment", () => {
    const s = session("s1", "2026-01-01T10:00:00Z", {
      modality: "laser",
      laser_entries: [{ deleted_at: null }],
    });
    expect(hasChartedContent(s, blocks({}))).toBe(true);
  });

  it("ONLY soft-deleted blocks does not qualify", () => {
    const s = session("s1", "2026-01-01T10:00:00Z");
    expect(
      hasChartedContent(
        s,
        blocks({ s1: [{ deleted_at: "2026-01-02T00:00:00Z" }] }),
      ),
    ).toBe(false);
  });

  it("ONLY soft-deleted entries does not qualify", () => {
    const s = session("s1", "2026-01-01T10:00:00Z", {
      electrolysis_entries: [{ deleted_at: "2026-01-02T00:00:00Z" }],
      laser_entries: [{ deleted_at: "2026-01-02T00:00:00Z" }],
    });
    expect(hasChartedContent(s, blocks({}))).toBe(false);
  });

  it("a newer session with only deleted blocks does not hide an older charted one", () => {
    const newest = session("s-new", "2026-06-01T10:00:00Z");
    const older = session("s-old", "2026-01-01T10:00:00Z");
    const picked = pickNewestChartedSession(
      [newest, older],
      blocks({
        "s-new": [{ deleted_at: "2026-06-02T00:00:00Z" }],
        "s-old": [LIVE_BLOCK],
      }),
    );
    expect(picked?.id).toBe("s-old");
  });

  it("a newer session with only deleted entries does not hide an older charted one", () => {
    const newest = session("s-new", "2026-06-01T10:00:00Z", {
      electrolysis_entries: [{ deleted_at: "2026-06-02T00:00:00Z" }],
    });
    const older = session("s-old", "2026-01-01T10:00:00Z", {
      electrolysis_entries: [{ deleted_at: null }],
    });
    const picked = pickNewestChartedSession([newest, older], blocks({}));
    expect(picked?.id).toBe("s-old");
  });
});

describe("the filters a LIMIT 1 cannot express", () => {
  it("excludes a soft-deleted session", () => {
    const s = session("s1", "2026-01-01T10:00:00Z", {
      deleted_at: "2026-01-05T00:00:00Z",
    });
    expect(isChartedSessionCandidate(s)).toBe(false);
    expect(pickNewestChartedSession([s], blocks({ s1: [LIVE_BLOCK] }))).toBeNull();
  });

  it("excludes a VOID session, and it cannot hide an older charted one", () => {
    const voided = session("s-void", "2026-06-01T10:00:00Z", {
      record_status: "void",
    });
    const older = session("s-old", "2026-01-01T10:00:00Z");
    const picked = pickNewestChartedSession(
      [voided, older],
      blocks({ "s-void": [LIVE_BLOCK], "s-old": [LIVE_BLOCK] }),
    );
    expect(picked?.id).toBe("s-old");
  });

  it("treats a narrow select without record_status as non-void", () => {
    const s: { id: string; started_at: string } = {
      id: "s1",
      started_at: "2026-01-01T10:00:00Z",
    };
    expect(isChartedSessionCandidate(s)).toBe(true);
  });

  it("excludes the session being charted right now", () => {
    const current = session("s-current", "2026-06-01T10:00:00Z");
    const older = session("s-old", "2026-01-01T10:00:00Z");
    const picked = pickNewestChartedSession(
      [current, older],
      blocks({ "s-current": [LIVE_BLOCK], "s-old": [LIVE_BLOCK] }),
      { excludeSessionId: "s-current" },
    );
    expect(picked?.id).toBe("s-old");
  });

  it("never returns the current session as its own last treatment", () => {
    const current = session("s-current", "2026-06-01T10:00:00Z");
    const picked = pickNewestChartedSession(
      [current],
      blocks({ "s-current": [LIVE_BLOCK] }),
      { excludeSessionId: "s-current" },
    );
    expect(picked).toBeNull();
  });

  it("applies a strict started_at upper bound", () => {
    const later = session("s-later", "2026-06-01T12:00:00Z");
    const earlier = session("s-earlier", "2026-06-01T08:00:00Z");
    const picked = pickNewestChartedSession(
      [later, earlier],
      blocks({ "s-later": [LIVE_BLOCK], "s-earlier": [LIVE_BLOCK] }),
      { before: "2026-06-01T10:00:00Z" },
    );
    expect(picked?.id).toBe("s-earlier");
  });

  it("the bound is strict: a session at exactly the bound is excluded", () => {
    const at = session("s1", "2026-06-01T10:00:00Z");
    expect(
      pickNewestChartedSession([at], blocks({ s1: [LIVE_BLOCK] }), {
        before: "2026-06-01T10:00:00Z",
      }),
    ).toBeNull();
  });

  it("does NOT filter by modality by default (a laser visit can be the last treatment)", () => {
    const laser = session("s-laser", "2026-06-01T10:00:00Z", {
      modality: "laser",
      laser_entries: [{ deleted_at: null }],
    });
    const electro = session("s-electro", "2026-01-01T10:00:00Z", {
      modality: "electrolysis",
    });
    const picked = pickNewestChartedSession(
      [laser, electro],
      blocks({ "s-electro": [LIVE_BLOCK] }),
    );
    expect(picked?.id).toBe("s-laser");
  });

  it("filters by modality only when explicitly asked", () => {
    const laser = session("s-laser", "2026-06-01T10:00:00Z", {
      modality: "laser",
      laser_entries: [{ deleted_at: null }],
    });
    const electro = session("s-electro", "2026-01-01T10:00:00Z", {
      modality: "electrolysis",
    });
    const picked = pickNewestChartedSession(
      [laser, electro],
      blocks({ "s-electro": [LIVE_BLOCK] }),
      { modality: "electrolysis" },
    );
    expect(picked?.id).toBe("s-electro");
  });

  it("returns null when the client has no prior charted session at all", () => {
    expect(pickNewestChartedSession([], blocks({}))).toBeNull();
  });
});

describe("bounded candidate window", () => {
  it("inspects at most `limit` rows so an unbounded history cannot become an unbounded IN(...)", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      session(`s-${String(i).padStart(3, "0")}`, `2026-01-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`),
    );
    expect(chartedSessionCandidates(many)).toHaveLength(25);
    expect(chartedSessionCandidates(many, { limit: 5 })).toHaveLength(5);
  });

  it("the window is the NEWEST rows, not an arbitrary slice", () => {
    const a = session("s-a", "2026-01-01T10:00:00Z");
    const b = session("s-b", "2026-02-01T10:00:00Z");
    const c = session("s-c", "2026-03-01T10:00:00Z");
    expect(chartedSessionCandidates([a, b, c], { limit: 2 }).map((s) => s.id)).toEqual(
      ["s-c", "s-b"],
    );
  });
});

describe("groupBlocksBySession", () => {
  it("groups a flat batched read by session_id, preserving row order", () => {
    const grouped = groupBlocksBySession([
      { session_id: "s1", id: "b1" },
      { session_id: "s2", id: "b2" },
      { session_id: "s1", id: "b3" },
    ]);
    expect(grouped.get("s1")?.map((b) => b.id)).toEqual(["b1", "b3"]);
    expect(grouped.get("s2")?.map((b) => b.id)).toEqual(["b2"]);
    expect(grouped.get("s3")).toBeUndefined();
  });
});
