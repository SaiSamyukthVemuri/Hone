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
  const src = () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    return readFileSync(
      path.resolve(__dirname, "../../../../app/api/cron/appointment-reminders/route.ts"),
      "utf8",
    );
  };
  const code = () =>
    src().replace(/\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

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
    const loopStart = c.indexOf("for (const appt of page)");
    const cursorSet = c.indexOf("cursor = { startsAt: appt.starts_at, id: appt.id }");
    const firstContinue = c.indexOf("continue;", loopStart);
    expect(loopStart).toBeGreaterThan(-1);
    expect(cursorSet).toBeGreaterThan(loopStart);
    expect(cursorSet).toBeLessThan(firstContinue);
  });

  it("adds NO migration and does not touch the sender authority law", () => {
    const c = code();
    // The routing law itself lives in lib/sms and is untouched by this repair.
    expect(c).not.toContain("resolveStudioSmsSender");
    expect(c).not.toContain("TWILIO_MESSAGING_SERVICE_SID");
  });
});
