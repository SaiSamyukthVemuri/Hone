import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// P1 — UNROUTABLE ROWS MUST NOT MONOPOLISE A REMINDER BATCH
//
// A routing refusal is deliberately free: nothing sent, no attempt claimed,
// sent column left null. Correct per row, and it means the row's ELIGIBILITY IS
// UNCHANGED — so it sorts into the same position on the next pass.
//
// With a single fixed first page of 50 ordered by starts_at, fifty earlier
// unroutable rows are re-selected forever and a later ROUTABLE row is never
// loaded. Its reminder window closes while the cron reports a clean run.
//
// Provider-FAILED rows do not do this: the claim increments `send_attempts`
// until they exceed MAX_ATTEMPTS and drop out of the filter. Routing refusals
// never touch that counter, which is what makes them starving rather than
// self-limiting.
//
// The fixture below models the candidate table and the keyset predicate, so
// "row 51 is reached" is measured against real paging behaviour rather than
// asserted.
// ===========================================================================

/** The shipped route's source, comment-stripped. Module scope: several
 *  describes assert against it. */
function routeSrc(): string {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  return readFileSync(
    path.resolve(__dirname, "../../../../app/api/cron/appointment-reminders/route.ts"),
    "utf8",
  );
}
function code(): string {
  return routeSrc().replace(/\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

const WINDOW_START = "2026-10-01T00:00:00.000Z";
const WINDOW_END = "2026-10-02T00:00:00.000Z";

type Row = {
  id: string;
  starts_at: string;
  studio_id: string;
  /** Whether this row's studio can resolve a sender. */
  routable: boolean;
};

/** 50 unroutable rows that sort FIRST, then one routable row. */
function estate(unroutable: number, studioOf?: (i: number) => string): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < unroutable; i += 1) {
    rows.push({
      id: `bad-${String(i).padStart(3, "0")}`,
      starts_at: new Date(Date.parse(WINDOW_START) + i * 60_000).toISOString(),
      studio_id: studioOf ? studioOf(i) : "studio-broken",
      routable: false,
    });
  }
  rows.push({
    id: "good-001",
    starts_at: new Date(
      Date.parse(WINDOW_START) + (unroutable + 1) * 60_000,
    ).toISOString(),
    studio_id: "studio-healthy",
    routable: true,
  });
  return rows;
}

/**
 * The candidate query, modelled faithfully:
 *   eligible  = sent column null AND attempts < cap
 *   order     = (starts_at, id) ascending — a TOTAL order
 *   keyset    = strictly after the cursor, never OFFSET
 */
function selectPage(
  rows: Row[],
  sent: Set<string>,
  attempts: Map<string, number>,
  maxAttempts: number,
  after: { startsAt: string; id: string } | null,
  pageSize: number,
): Row[] {
  const eligible = rows
    .filter((r) => !sent.has(r.id))
    .filter((r) => (attempts.get(r.id) ?? 0) < maxAttempts)
    .filter((r) => r.starts_at >= WINDOW_START && r.starts_at <= WINDOW_END)
    .sort((a, b) =>
      a.starts_at === b.starts_at
        ? a.id.localeCompare(b.id)
        : a.starts_at.localeCompare(b.starts_at),
    );
  const afterFiltered = after
    ? eligible.filter(
        (r) =>
          r.starts_at > after.startsAt ||
          (r.starts_at === after.startsAt && r.id > after.id),
      )
    : eligible;
  return afterFiltered.slice(0, pageSize);
}

type PassResult = {
  reached: string[];
  sent: string[];
  claims: string[];
  providerCalls: number;
  scanned: number;
  ceilingHit: boolean;
};

/**
 * One reminder pass.
 *
 * `paged: false` reproduces the pre-repair behaviour — a single fixed first
 * page — so the starvation can be demonstrated rather than described.
 */
function runPass(
  rows: Row[],
  state: { sent: Set<string>; attempts: Map<string, number> },
  opts: { paged: boolean; perRunLimit?: number; pageSize?: number; maxScan?: number },
): PassResult {
  const PER_RUN = opts.perRunLimit ?? 50;
  const PAGE = opts.pageSize ?? 50;
  const MAX_SCAN = opts.maxScan ?? 500;
  const MAX_ATTEMPTS = 3;

  const out: PassResult = {
    reached: [],
    sent: [],
    claims: [],
    providerCalls: 0,
    scanned: 0,
    ceilingHit: false,
  };

  let cursor: { startsAt: string; id: string } | null = null;
  let sendWork = 0;

  for (;;) {
    if (sendWork >= PER_RUN || out.scanned >= MAX_SCAN) break;
    const page = selectPage(
      rows,
      state.sent,
      state.attempts,
      MAX_ATTEMPTS,
      cursor,
      PAGE,
    );
    if (page.length === 0) break;

    for (const row of page) {
      cursor = { startsAt: row.starts_at, id: row.id };
      out.scanned += 1;
      if (out.scanned >= MAX_SCAN) out.ceilingHit = true;
      out.reached.push(row.id);

      if (!row.routable) {
        // ROUTING REFUSAL: no claim, no provider call, no sent stamp, and NO
        // send-budget charge. Scan budget only.
        if (!opts.paged) {
          // Pre-repair: the refusal consumed one of the 50 batch slots.
          sendWork += 1;
        }
      } else {
        state.attempts.set(row.id, (state.attempts.get(row.id) ?? 0) + 1);
        out.claims.push(row.id);
        out.providerCalls += 1;
        state.sent.add(row.id);
        out.sent.push(row.id);
        sendWork += 1;
      }

      if (sendWork >= PER_RUN) break;
      if (out.scanned >= MAX_SCAN) break;
    }

    if (!opts.paged) break; // single fixed first page
    if (page.length < PAGE) break;
  }
  return out;
}

function freshState() {
  return { sent: new Set<string>(), attempts: new Map<string, number>() };
}

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "error").mockImplementation((m) => logs.push(String(m)));
  vi.spyOn(console, "info").mockImplementation((m) => logs.push(String(m)));
});
afterEach(() => vi.restoreAllMocks());

// --- A ---------------------------------------------------------------------

describe("A — 50 unroutable earlier rows + a 51st routable row", () => {
  const rows = estate(50);

  it("PRE-REPAIR: row 51 is never reached, and the same prefix returns next pass", () => {
    const state = freshState();
    const pass1 = runPass(rows, state, { paged: false });
    expect(pass1.reached).toHaveLength(50);
    expect(pass1.reached).not.toContain("good-001");
    expect(pass1.sent).toEqual([]);

    // Nothing changed: no sent stamp, no attempt bump. The identical prefix is
    // selected again — forever.
    const pass2 = runPass(rows, state, { paged: false });
    expect(pass2.reached).toEqual(pass1.reached);
    expect(pass2.reached).not.toContain("good-001");
  });

  it("REPAIRED: the routable row IS reached, in the same pass", () => {
    const state = freshState();
    const pass = runPass(rows, state, { paged: true });
    expect(pass.reached).toContain("good-001");
    expect(pass.sent).toEqual(["good-001"]);
  });
});

// --- B ---------------------------------------------------------------------

describe("B — refused rows cost nothing", () => {
  it("zero claims, zero attempts, zero provider calls for the refused prefix", () => {
    const state = freshState();
    const pass = runPass(estate(50), state, { paged: true });
    // Only the routable row was ever claimed or sent.
    expect(pass.claims).toEqual(["good-001"]);
    expect(pass.providerCalls).toBe(1);
    for (let i = 0; i < 50; i += 1) {
      const id = `bad-${String(i).padStart(3, "0")}`;
      expect(state.attempts.get(id) ?? 0).toBe(0);
      expect(state.sent.has(id)).toBe(false);
    }
  });

  it("never fakes a sent timestamp on a refused row", () => {
    const state = freshState();
    runPass(estate(50), state, { paged: true });
    expect([...state.sent]).toEqual(["good-001"]);
  });
});

// --- C ---------------------------------------------------------------------

describe("C — an ordinary routable batch is unchanged", () => {
  it("sends at most PER_RUN_LIMIT and stops", () => {
    const rows: Row[] = Array.from({ length: 60 }, (_, i) => ({
      id: `ok-${String(i).padStart(3, "0")}`,
      starts_at: new Date(Date.parse(WINDOW_START) + i * 60_000).toISOString(),
      studio_id: "studio-healthy",
      routable: true,
    }));
    const state = freshState();
    const pass = runPass(rows, state, { paged: true });
    expect(pass.sent).toHaveLength(50);
    expect(pass.providerCalls).toBe(50);
    // Bounded exactly as before the repair.
    expect(pass.scanned).toBe(50);
  });

  it("a small fully-routable batch behaves identically paged or not", () => {
    const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({
      id: `ok-${i}`,
      starts_at: new Date(Date.parse(WINDOW_START) + i * 60_000).toISOString(),
      studio_id: "s",
      routable: true,
    }));
    const a = runPass(rows, freshState(), { paged: false });
    const b = runPass(rows, freshState(), { paged: true });
    expect(b.sent).toEqual(a.sent);
  });
});

// --- D ---------------------------------------------------------------------

describe("D — one broken studio does not starve a healthy one", () => {
  it("reaches the healthy studio's rows past a broken studio's prefix", () => {
    const rows = estate(50, () => "studio-broken");
    rows.push({
      id: "good-002",
      starts_at: new Date(Date.parse(WINDOW_START) + 99 * 60_000).toISOString(),
      studio_id: "studio-healthy",
      routable: true,
    });
    const pass = runPass(rows, freshState(), { paged: true });
    expect(pass.sent).toEqual(["good-001", "good-002"]);
    // And the broken studio consumed no send budget at all.
    expect(pass.claims).toEqual(["good-001", "good-002"]);
  });
});

// --- E ---------------------------------------------------------------------

describe("E — the pagination boundary cannot duplicate or skip", () => {
  it("sends each row exactly once across page boundaries", () => {
    // Small pages force many boundaries.
    const rows: Row[] = Array.from({ length: 25 }, (_, i) => ({
      id: `r-${String(i).padStart(3, "0")}`,
      starts_at: new Date(Date.parse(WINDOW_START) + i * 60_000).toISOString(),
      studio_id: "s",
      routable: true,
    }));
    const pass = runPass(rows, freshState(), { paged: true, pageSize: 4 });
    expect(pass.sent).toHaveLength(25);
    expect(new Set(pass.sent).size).toBe(25);
  });

  it("does not re-emit a row whose sibling shares its starts_at", () => {
    // Identical timestamps: the id tiebreak is what makes the keyset total.
    const same = WINDOW_START;
    const rows: Row[] = ["a", "b", "c", "d"].map((k) => ({
      id: `tie-${k}`,
      starts_at: same,
      studio_id: "s",
      routable: true,
    }));
    const pass = runPass(rows, freshState(), { paged: true, pageSize: 2 });
    expect(pass.sent).toEqual(["tie-a", "tie-b", "tie-c", "tie-d"]);
    expect(new Set(pass.reached).size).toBe(pass.reached.length);
  });

  it("skipped rows advance the cursor, so a page cannot repeat forever", () => {
    // Every row unroutable: the pass must terminate by exhausting candidates,
    // not spin on page one.
    const rows = estate(10).slice(0, 10);
    const pass = runPass(rows, freshState(), { paged: true, pageSize: 3 });
    expect(pass.scanned).toBe(10);
    expect(new Set(pass.reached).size).toBe(10);
  });
});

// --- scan ceiling ----------------------------------------------------------

describe("the scan ceiling is explicit and cannot masquerade as coverage", () => {
  it("stops at the ceiling and reports it", () => {
    const rows = estate(600).slice(0, 600);
    const pass = runPass(rows, freshState(), { paged: true, maxScan: 500 });
    expect(pass.scanned).toBe(500);
    expect(pass.ceilingHit).toBe(true);
    // Did NOT reach the end of the candidate space.
    expect(pass.reached).not.toContain("good-001");
  });

  it("does not flag the ceiling when candidates were genuinely exhausted", () => {
    const pass = runPass(estate(10).slice(0, 11), freshState(), {
      paged: true,
      maxScan: 500,
    });
    expect(pass.ceilingHit).toBe(false);
  });
});

// --- F ---------------------------------------------------------------------

describe("F — negative control: single fixed first page", () => {
  it("restoring it turns the starvation proof RED", () => {
    const rows = estate(50);
    const repaired = runPass(rows, freshState(), { paged: true });
    const preRepair = runPass(rows, freshState(), { paged: false });

    expect(repaired.reached).toContain("good-001");
    // The control: the exact assertion that proves the fix, failing.
    expect(preRepair.reached).not.toContain("good-001");
    expect(preRepair.sent).toEqual([]);
    expect(repaired.sent).toEqual(["good-001"]);
  });
});

// --- the SHIPPED route, not only the model ---------------------------------

describe("the real cron route actually pages", () => {
  // The fixture above models the behaviour. This asserts the shipped code has
  // the structure that behaviour depends on, so the model cannot stay green
  // while the route regresses to a single fixed page.

  it("uses a KEYSET cursor, never OFFSET", async () => {
    // BEHAVIOURAL, not a grep. A negative control proved a string guard here
    // was worthless: wrapping the keyset in `if (false && …)` left every
    // string in place and the test green. This calls the predicate.
    const { keysetFilter } = await import(
      "@/lib/cron/reminder-keyset"
    );
    expect(keysetFilter(null)).toBeNull();
    expect(keysetFilter({ startsAt: "2026-10-01T00:00:00.000Z", id: "abc" })).toBe(
      "starts_at.gt.2026-10-01T00:00:00.000Z,and(starts_at.eq.2026-10-01T00:00:00.000Z,id.gt.abc)",
    );
    // OFFSET is unsafe when eligibility changes under the run.
    expect(code()).not.toMatch(/\.range\(|offset/i);
  });

  it("the keyset predicate is WIRED, not merely defined", async () => {
    const { keysetFilter } = await import(
      "@/lib/cron/reminder-keyset"
    );
    const c = code();
    // The loader must consume the predicate's RESULT, not re-inline the string.
    expect(c).toContain("const keyset = keysetFilter(opts.after ?? null);");
    expect(c).toContain("if (keyset) q = q.or(keyset);");
    expect(typeof keysetFilter).toBe("function");
  });

  it("orders by (starts_at, id) so the keyset is a TOTAL order", () => {
    const c = code();
    expect(c).toContain('.order("starts_at", { ascending: true })');
    expect(c).toContain('.order("id", { ascending: true })');
  });

  it("loops pages instead of taking one fixed batch", () => {
    const c = code();
    expect(c).toMatch(/pages:\s*while/);
    expect(c).toContain("REMINDER_PAGE_SIZE");
  });

  it("EXEMPTS routing refusals from the send budget", () => {
    const c = code();
    expect(c).toContain("ROUTING_REFUSAL_REASONS");
    expect(c).toContain("if (!routingRefused) sendWork += 1;");
  });

  it("keeps the send budget at PER_RUN_LIMIT — provider work is unchanged", () => {
    expect(code()).toContain("sendWork < PER_RUN_LIMIT");
    expect(code()).toContain("const PER_RUN_LIMIT = 50;");
  });

  it("has an explicit scan ceiling that reports itself truthfully", () => {
    const c = code();
    expect(c).toContain("MAX_SCAN_ROWS");
    expect(c).toContain("reminder_scan_ceiling_reached");
    expect(c).toContain("candidates_exhausted: false");
  });

  it("advances the cursor BEFORE any continue, so a page cannot repeat", () => {
    const c = code();
    const loopStart = c.indexOf("for (const appt of rows)");
    const cursorSet = c.indexOf("cursor = { startsAt: appt.starts_at, id: appt.id }");
    const firstContinue = c.indexOf("continue;", loopStart);
    expect(loopStart).toBeGreaterThan(-1);
    expect(cursorSet).toBeGreaterThan(loopStart);
    expect(cursorSet).toBeLessThan(firstContinue);
  });

  it("does not BYPASS the sender authority, and reads no env sender", () => {
    // Updated deliberately, and the reason is recorded rather than quietly
    // swapped: the first version asserted the route never NAMES
    // `resolveStudioSmsSender`. The fairness repair makes the route resolve
    // each candidate studio once, for SELECTION — so naming it is now correct
    // and the old assertion encoded an assumption, not the invariant.
    //
    // The real invariant is unchanged and is what this now asserts: selection
    // may narrow which rows are loaded, but it may never decide that a send is
    // permitted. Every row still goes through the send helper, which
    // re-resolves and re-refuses on its own — so a studio that becomes
    // unroutable between enumeration and send is still refused, fail-closed.
    const c = code();
    expect(c).toContain("resolveStudioSmsSender");          // selection only
    expect(c).toContain("studioSenderAllowsSend");
    // The send still goes through the helper; the route never posts directly.
    expect(c).toMatch(/send24hReminderSmsToClient|send2hReminderSmsToClient/);
    expect(c).not.toContain("sendSmsSafely");
    // And no environment sender anywhere.
    expect(c).not.toContain("TWILIO_MESSAGING_SERVICE_SID");
    expect(c).not.toContain("TWILIO_FROM_NUMBER");
  });
});

// ===========================================================================
// P2-A — FAIRNESS MUST SURVIVE ACROSS CRON RUNS
//
// Keyset paging fixed ONE invocation and moved the boundary from 50 to
// MAX_SCAN_ROWS: every later invocation still started from the beginning, so a
// large enough unroutable prefix hid a routable suffix forever.
//
// The repair removes unroutable rows from SELECTION, so there is nothing to
// page past and no persisted cursor is needed. These tests model that: a run
// enumerates candidate studios, resolves each once, and selects only from the
// routable ones.
// ===========================================================================

type Studio = { id: string; routable: boolean };

function runFairPass(
  rows: Array<Row & { studio_id: string }>,
  studios: Studio[],
  state: { sent: Set<string> },
  opts: { perRun?: number; pageSize?: number } = {},
): { reached: string[]; sent: string[]; studiosResolved: string[] } {
  const PER_RUN = opts.perRun ?? 50;
  const PAGE = opts.pageSize ?? 50;

  // 1 enumerate distinct candidate studios, 2 resolve each ONCE
  const candidateStudios = [
    ...new Set(rows.filter((r) => !state.sent.has(r.id)).map((r) => r.studio_id)),
  ];
  const resolved = candidateStudios.map((id) => ({
    studioId: id,
    routable: studios.find((s) => s.id === id)?.routable ?? false,
  }));
  const routable = resolved.filter((r) => r.routable).map((r) => r.studioId);

  // 3 select ONLY from studios that can send
  const eligible = rows
    .filter((r) => !state.sent.has(r.id))
    .filter((r) => routable.includes(r.studio_id))
    .sort((a, b) =>
      a.starts_at === b.starts_at
        ? a.id.localeCompare(b.id)
        : a.starts_at.localeCompare(b.starts_at),
    )
    .slice(0, Math.min(PER_RUN, PAGE));

  const reached = eligible.map((r) => r.id);
  for (const r of eligible) state.sent.add(r.id);
  return {
    reached,
    sent: reached,
    studiosResolved: candidateStudios,
  };
}

describe("P2-A — cross-run fairness", () => {
  /** 600 permanently-refused rows, then one routable row beyond them. */
  function bigEstate() {
    const rows: Array<Row & { studio_id: string }> = [];
    for (let i = 0; i < 600; i += 1) {
      rows.push({
        id: `bad-${String(i).padStart(4, "0")}`,
        starts_at: new Date(Date.parse(WINDOW_START) + i * 1000).toISOString(),
        studio_id: "studio-broken",
        routable: false,
      });
    }
    rows.push({
      id: "good-001",
      starts_at: new Date(Date.parse(WINDOW_START) + 900 * 1000).toISOString(),
      studio_id: "studio-healthy",
      routable: true,
    });
    return rows;
  }
  const studios: Studio[] = [
    { id: "studio-broken", routable: false },
    { id: "studio-healthy", routable: true },
  ];

  it("reaches the routable row on the FIRST run, past 600 refused rows", () => {
    // 600 > MAX_SCAN_ROWS (500). Under the previous keyset-only repair this
    // suffix was unreachable on every run.
    const state = { sent: new Set<string>() };
    const run = runFairPass(bigEstate(), studios, state);
    expect(run.sent).toEqual(["good-001"]);
  });

  it("resolves each candidate studio ONCE, not once per row", () => {
    const run = runFairPass(bigEstate(), studios, { sent: new Set() });
    expect(run.studiosResolved).toEqual(["studio-broken", "studio-healthy"]);
    expect(run.studiosResolved).toHaveLength(2);
  });

  it("repeated runs eventually process an entire routable suffix", () => {
    // 600 refused + 120 routable: more routable rows than one run's cap.
    const rows = bigEstate();
    for (let i = 0; i < 120; i += 1) {
      rows.push({
        id: `ok-${String(i).padStart(3, "0")}`,
        starts_at: new Date(Date.parse(WINDOW_START) + (1000 + i) * 1000).toISOString(),
        studio_id: "studio-healthy",
        routable: true,
      });
    }
    const state = { sent: new Set<string>() };
    let runs = 0;
    while (runs < 20) {
      const r = runFairPass(rows, studios, state);
      runs += 1;
      if (r.sent.length === 0) break;
    }
    const routableIds = rows.filter((r) => r.routable).map((r) => r.id);
    for (const id of routableIds) expect(state.sent.has(id)).toBe(true);
    // And the refused rows were never sent, however many runs happened.
    for (const r of rows.filter((x) => !x.routable)) {
      expect(state.sent.has(r.id)).toBe(false);
    }
  });

  it("a refused row staying refused NEVER blocks progress", () => {
    const rows = bigEstate();
    const state = { sent: new Set<string>() };
    runFairPass(rows, studios, state);
    // Refused rows are untouched: sent_at null, attempts 0, still eligible.
    // The next run is unaffected by them.
    const second = runFairPass(rows, studios, state);
    expect(second.sent).toEqual([]); // nothing routable left, not blocked
  });

  it("no duplicate send across runs", () => {
    const rows = bigEstate();
    const state = { sent: new Set<string>() };
    const a = runFairPass(rows, studios, state);
    const b = runFairPass(rows, studios, state);
    expect(a.sent).toEqual(["good-001"]);
    expect(b.sent).toEqual([]);
    expect([...state.sent]).toHaveLength(1);
  });

  it("a studio becoming routable later is picked up without any stored cursor", () => {
    const rows = bigEstate();
    const state = { sent: new Set<string>() };
    runFairPass(rows, studios, state); // good-001 sent
    // The broken studio is provisioned between runs.
    const fixed: Studio[] = [
      { id: "studio-broken", routable: true },
      { id: "studio-healthy", routable: true },
    ];
    const after = runFairPass(rows, fixed, state, { perRun: 50 });
    expect(after.sent.length).toBe(50);
    expect(after.sent.every((id) => id.startsWith("bad-"))).toBe(true);
  });

  it("24h and 2h windows are independent", () => {
    // Separate state per window: a send in one must not mark the other.
    const rows = bigEstate();
    const s24 = { sent: new Set<string>() };
    const s2 = { sent: new Set<string>() };
    runFairPass(rows, studios, s24);
    expect(s24.sent.has("good-001")).toBe(true);
    expect(s2.sent.has("good-001")).toBe(false);
    const r2 = runFairPass(rows, studios, s2);
    expect(r2.sent).toEqual(["good-001"]);
  });
});

// ===========================================================================
// P2-B — TRUNCATION MUST MEAN ACTUAL TRUNCATION
// ===========================================================================

describe("P2-B — a full page is not proof of truncation", () => {
  it("499 rows: exhausted, no ceiling warning", async () => {
    const { truncationProven } = await import("@/lib/cron/reminder-routable-studios");
    // The query asks for limit+1 and gets 499.
    expect(truncationProven({ returned: 499, limit: 500 })).toBe(false);
  });

  it("EXACTLY 500 rows: exhausted, no ceiling warning", async () => {
    const { truncationProven } = await import("@/lib/cron/reminder-routable-studios");
    // The defect: a full page read as proof that more existed.
    expect(truncationProven({ returned: 500, limit: 500 })).toBe(false);
  });

  it("501 rows: the extra candidate is PROVEN, so truncation is truthful", async () => {
    const { truncationProven } = await import("@/lib/cron/reminder-routable-studios");
    expect(truncationProven({ returned: 501, limit: 500 })).toBe(true);
  });

  it("the route asks for limit + 1 so the lookahead row can exist at all", () => {
    const c = code();
    expect(c).toContain("pageSize: REMINDER_PAGE_SIZE + 1");
    expect(c).toContain("truncationProven({");
    // And it processes only the page, never the lookahead row.
    expect(c).toContain("page.slice(0, REMINDER_PAGE_SIZE)");
  });

  it("records exhaustion from the lookahead BEFORE any ceiling break", () => {
    // Updated with the P2-3 repair. The old shape acted on `hasMore` only at
    // the BOTTOM of the page loop, so an early `break pages` at the scan
    // ceiling jumped over it — the exactly-500 case then emitted a ceiling
    // alert the +1 query had already disproved. The assignment must therefore
    // come BEFORE the row loop that can break out.
    const c = code();
    expect(c).toContain("if (!hasMore) exhausted = true;");
    const assignAt = c.indexOf("if (!hasMore) exhausted = true;");
    const rowLoopAt = c.indexOf("for (const appt of rows)");
    expect(assignAt).toBeGreaterThan(-1);
    expect(rowLoopAt).toBeGreaterThan(assignAt);
  });
});

// ===========================================================================
// NEGATIVE CONTROLS for P2-A / P2-B
// ===========================================================================

describe("negative controls", () => {
  it("A — selecting WITHOUT the routable filter starves the suffix", () => {
    // Model the pre-repair selection: no studio filter, fixed page.
    const rows = (() => {
      const r: Array<Row & { studio_id: string }> = [];
      for (let i = 0; i < 600; i += 1) {
        r.push({
          id: `bad-${String(i).padStart(4, "0")}`,
          starts_at: new Date(Date.parse(WINDOW_START) + i * 1000).toISOString(),
          studio_id: "studio-broken",
          routable: false,
        });
      }
      r.push({
        id: "good-001",
        starts_at: new Date(Date.parse(WINDOW_START) + 900 * 1000).toISOString(),
        studio_id: "studio-healthy",
        routable: true,
      });
      return r;
    })();

    const unfiltered = rows
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
      .slice(0, 500);
    // 500-row scan ceiling never reaches it — the defect this repair removes.
    expect(unfiltered.map((r) => r.id)).not.toContain("good-001");

    // With the filter, it is the FIRST row selected.
    const fair = runFairPass(rows, [
      { id: "studio-broken", routable: false },
      { id: "studio-healthy", routable: true },
    ], { sent: new Set() });
    expect(fair.sent).toEqual(["good-001"]);
  });

  it("B — treating a full page as truncation breaks the exactly-500 case", async () => {
    const { truncationProven } = await import("@/lib/cron/reminder-routable-studios");
    const naive = (returned: number, limit: number) => returned >= limit;
    // The naive rule cries truncation on a complete set…
    expect(naive(500, 500)).toBe(true);
    // …where the lookahead rule correctly does not.
    expect(truncationProven({ returned: 500, limit: 500 })).toBe(false);
  });
});

// ===========================================================================
// The SHIPPED route implements the fairness mechanism
//
// The cross-run tests above exercise a MODEL of the selection. A negative
// control proved that is not sufficient on its own: disabling the studio
// filter in the real route left every model test green, because the model
// always applies it. These bind the proof to the shipped code.
// ===========================================================================

describe("the real route selects only from routable studios", () => {
  it("passes the routable set into the query, not null", () => {
    const c = code();
    expect(c).toContain("onlyStudioIds: routable");
    // …and the loader must actually apply it.
    expect(c).toContain('q = q.in("studio_id", opts.onlyStudioIds as string[])');
  });

  it("resolves each candidate studio ONCE, outside the row loop", () => {
    const c = code();
    expect(c).toContain("const studioIds = await toggledStudioIds(studioToggle);");
    expect(c).toMatch(/for \(const studioId of studioIds\) \{/);
    expect(c).toContain("partitionRoutableStudios(resolutions)");
    // The resolve must NOT be inside the per-row loop.
    const resolveAt = c.indexOf("resolveStudioSmsSender(admin, studioId)");
    const rowLoopAt = c.indexOf("for (const appt of rows)");
    expect(resolveAt).toBeGreaterThan(-1);
    expect(rowLoopAt).toBeGreaterThan(resolveAt);
  });

  it("enumerates studios from the STUDIOS table, bounded by studio count", () => {
    // P2-2. The earlier version scanned every eligible appointment in the
    // window in 500-row pages before any send, which defeated the per-run
    // bound — and capping THAT scan would have reintroduced starvation,
    // because a capped prefix of one broken studio yields no routable studios.
    const c = code();
    expect(c).toContain('.from("studios")');
    expect(c).toContain(".eq(studioToggle, true)");
    // The unbounded appointment-scan enumeration is gone.
    expect(c).not.toContain("candidateStudioIds");
    expect(c).not.toContain("STUDIO_SCAN_PAGE_SIZE");
  });

  it("REPORTS an unroutable studio before excluding it", () => {
    // P2-1. Filtering an unroutable studio out of selection means its rows
    // never reach sendOne, the only path that records the durable alert. That
    // would trade starvation for SILENCE — strictly worse, since a starving
    // studio at least alerted on the rows it did reach.
    const c = code();
    expect(c).toContain("logStudioRoutingRefusal({");
    expect(c).toContain("sms_routing_studio_excluded");
    expect(c).toContain("excluded_from_selection: true");
    // The report must happen in the resolve loop, before selection uses
    // `routable`.
    const reportAt = c.indexOf("logStudioRoutingRefusal({");
    const selectAt = c.indexOf("onlyStudioIds: routable");
    expect(reportAt).toBeGreaterThan(-1);
    expect(selectAt).toBeGreaterThan(reportAt);
  });

  it("reports EVERY unroutable studio, by behaviour not by grep", async () => {
    // Three source guards in this lane failed to prove reachability — a call
    // wrapped in `if (false && …)` leaves the string in place. The decision is
    // therefore a pure function, and this tests its RETURN VALUE.
    const { refusalsToReport } = await import(
      "@/lib/cron/reminder-routable-studios"
    );
    expect(
      refusalsToReport([
        { studioId: "a", routable: false, reason: "sms_sender_not_active_for_studio" },
        { studioId: "b", routable: true },
        { studioId: "c", routable: false, reason: "sms_sender_ambiguous" },
      ]),
    ).toEqual([
      { studioId: "a", reason: "sms_sender_not_active_for_studio" },
      { studioId: "c", reason: "sms_sender_ambiguous" },
    ]);
  });

  it("reports each unroutable studio ONCE, never per row", async () => {
    const { refusalsToReport } = await import(
      "@/lib/cron/reminder-routable-studios"
    );
    const dupes = Array.from({ length: 50 }, () => ({
      studioId: "broken",
      routable: false,
      reason: "sms_sender_read_failed",
    }));
    expect(refusalsToReport(dupes)).toHaveLength(1);
  });

  it("an all-routable estate reports nothing", async () => {
    const { refusalsToReport } = await import(
      "@/lib/cron/reminder-routable-studios"
    );
    expect(
      refusalsToReport([
        { studioId: "a", routable: true },
        { studioId: "b", routable: true },
      ]),
    ).toEqual([]);
  });

  it("the route CONSUMES that decision rather than re-deciding", () => {
    const c = code();
    expect(c).toMatch(/for \(const refusal of refusalsToReport\(resolutions\)\)/);
    expect(c).toContain("logStudioRoutingRefusal({");
  });

  it("the studio-level alert reuses the shipped vocabulary, inventing none", () => {
    const c = code();
    expect(c).toContain("SENDER_REFUSAL_REASON[r.reason]");
    expect(c).toContain("recordOpsAlert");
    // No fourth reason word.
    expect(c).not.toMatch(/sms_sender_[a-z_]*(?<!not_active_for_studio)(?<!ambiguous)(?<!read_failed)"/);
  });

  it("short-circuits when NO studio can send", () => {
    expect(code()).toMatch(/if \(routable\.length === 0\) \{/);
  });

  it("still sends through the helper, so the authority re-refuses per row", () => {
    // Selection narrows what is LOADED. It never decides that a send is
    // permitted: a studio that becomes unroutable between enumeration and send
    // is still refused, fail-closed, by the helper.
    const c = code();
    expect(c).toMatch(/send24hReminderSmsToClient|send2hReminderSmsToClient/);
    expect(c).toContain("ROUTING_REFUSAL_REASONS");
  });
});

describe("partitionRoutableStudios, behaviourally", () => {
  it("splits and dedupes, preserving order", async () => {
    const { partitionRoutableStudios } = await import(
      "@/lib/cron/reminder-routable-studios"
    );
    const r = partitionRoutableStudios([
      { studioId: "a", routable: false },
      { studioId: "b", routable: true },
      { studioId: "a", routable: false },
      { studioId: "c", routable: true },
    ]);
    expect(r.routable).toEqual(["b", "c"]);
    expect(r.unroutable).toEqual(["a"]);
  });

  it("an all-unroutable estate yields no routable studios", async () => {
    const { partitionRoutableStudios } = await import(
      "@/lib/cron/reminder-routable-studios"
    );
    const r = partitionRoutableStudios([
      { studioId: "x", routable: false },
      { studioId: "y", routable: false },
    ]);
    expect(r.routable).toEqual([]);
    expect(r.unroutable).toEqual(["x", "y"]);
  });
});
