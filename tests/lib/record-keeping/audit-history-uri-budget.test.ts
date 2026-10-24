import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// The request-line budget that AUDIT_HISTORY_ID_CHUNK exists to respect.
// ===========================================================================
//
// PostgREST filters ride in the query string, so `.in("record_id", ids)` puts
// roughly 39 bytes per uuid on the GET request line, and the gateway in front
// of PostgREST answers a request line over ~8 KiB with HTTP 414. Measured
// against the local stack on the shipped query shapes:
//
//   getAuditEventsByRecord   .in(record_id)        last OK 205 ids (8,167 B)
//                                                  first 414 206 ids (8,206 B)
//   getClientProcedureRecords.in(session_id)       last OK 202 ids (8,153 B)
//   getSessionBlockAreasByBlockIds .in(block_id)   last OK 205 ids (8,147 B)
//
// Three different shapes wall within four ids of each other, which is the tell
// that the wall is the BYTE BUDGET and not the id count.
//
// WHAT THIS FILE PROTECTS. Before chunking, the only thing keeping the history
// read under that wall was the `.limit(200)` on each record list — a ~5-id
// margin that nothing asserted and that any of these would have erased in
// silence: raising a list limit, adding a column to the select, adding a
// filter, or a longer Supabase project URL. This pins the margin so that the
// next change to any of them fails HERE, loudly, instead of on a studio's
// screen as "No history recorded yet."
//
// The URLs are the ones the SHIPPED function builds: fetch is captured, not
// re-implemented, so a change to the select list or the filters is measured
// rather than assumed.

// supabase-js builds a realtime client on construction and looks for a global
// WebSocket. Node has none under vitest; the db suites stub it the same way.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const HISTORY_PATH = "/rest/v1/record_keeping_audit_events";

/**
 * The observed wall. Not a target — the budget asserted below sits far under
 * it, and this constant exists so the comparison in the test reads honestly.
 */
const OBSERVED_414_REQUEST_LINE_BYTES = 8192;

/**
 * What one chunked request may spend. Generous room under the wall, so that a
 * moderate growth in the select list or the project URL is absorbed rather
 * than becoming an incident.
 */
const CHUNK_REQUEST_LINE_BUDGET_BYTES = 4096;

/**
 * A project URL the LENGTH of a hosted Supabase one, not the short local one.
 * `https://<20-char-ref>.supabase.co` is ~11 bytes longer than
 * `http://127.0.0.1:54321`, and the budget has to hold for production, which
 * is the longer of the two.
 */
const HOSTED_LENGTH_SUPABASE_URL = "https://aaaaaaaaaaaaaaaaaaaa.supabase.co";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
  }),
}));

const requestLines: number[] = [];
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  requestLines.length = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL = HOSTED_LENGTH_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (href.includes(HISTORY_PATH)) {
      const u = new URL(href);
      requestLines.push(Buffer.byteLength(u.pathname + u.search));
    }
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const ids = (n: number) => Array.from({ length: n }, () => randomUUID());

describe("audit history request-line budget", () => {
  it("chunks a max-size caller into requests that each stay well under the wall", async () => {
    const { getAuditEventsByRecord, AUDIT_HISTORY_ID_CHUNK } = await import(
      "@/lib/record-keeping/queries"
    );
    // 200 is the largest id list any caller can produce: every record list on
    // the page is `.limit(200)`.
    await getAuditEventsByRecord(randomUUID(), "sterile_item", ids(200));

    expect(requestLines.length).toBe(Math.ceil(200 / AUDIT_HISTORY_ID_CHUNK));
    expect(Math.max(...requestLines)).toBeLessThanOrEqual(
      CHUNK_REQUEST_LINE_BUDGET_BYTES,
    );
    // And far enough under the real wall that the margin is not coincidental.
    expect(Math.max(...requestLines) * 1.5).toBeLessThan(
      OBSERVED_414_REQUEST_LINE_BYTES,
    );
  });

  it("ANTI-VACUITY: the capture is real — one id produces one small request", async () => {
    const { getAuditEventsByRecord } = await import("@/lib/record-keeping/queries");
    await getAuditEventsByRecord(randomUUID(), "disinfectant", ids(1));
    expect(requestLines.length).toBe(1);
    expect(requestLines[0]).toBeGreaterThan(0);
    expect(requestLines[0]).toBeLessThan(CHUNK_REQUEST_LINE_BUDGET_BYTES);
  });

  it("REPRODUCTION: one UNCHUNKED request at the old caller cap would have sat ~5 ids under a 414", async () => {
    const { AUDIT_HISTORY_ID_CHUNK } = await import("@/lib/record-keeping/queries");
    const { getAuditEventsByRecord } = await import("@/lib/record-keeping/queries");

    // Measure the per-id cost of the SHIPPED query shape rather than assuming
    // it: two chunk-sized reads, one id apart, give the slope directly.
    requestLines.length = 0;
    await getAuditEventsByRecord(randomUUID(), "sterile_item", ids(AUDIT_HISTORY_ID_CHUNK));
    const atChunk = requestLines[0];
    requestLines.length = 0;
    await getAuditEventsByRecord(
      randomUUID(),
      "sterile_item",
      ids(AUDIT_HISTORY_ID_CHUNK - 1),
    );
    const atChunkMinusOne = requestLines[0];
    const bytesPerId = atChunk - atChunkMinusOne;
    expect(bytesPerId).toBeGreaterThan(30);

    const base = atChunk - AUDIT_HISTORY_ID_CHUNK * bytesPerId;
    const unchunkedAt = (n: number) => base + n * bytesPerId;

    // The defect this PR removes: the shipped caps put the single request
    // within a handful of ids of the wall, with nothing asserting it.
    expect(unchunkedAt(200)).toBeLessThan(OBSERVED_414_REQUEST_LINE_BYTES);
    expect(unchunkedAt(206)).toBeGreaterThan(OBSERVED_414_REQUEST_LINE_BYTES);
    // Under 20 ids of headroom is what "nothing was holding it there" means.
    const headroomIds =
      (OBSERVED_414_REQUEST_LINE_BYTES - unchunkedAt(200)) / bytesPerId;
    expect(headroomIds).toBeLessThan(20);
  });
});
