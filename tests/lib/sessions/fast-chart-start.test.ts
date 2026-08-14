import { describe, expect, it } from "vitest";
import {
  FAST_CHART_PARAM,
  fastChartUrl,
  landingBlockId,
  resolveAutoEditBlockId,
} from "@/lib/sessions/fast-chart-start";

// Repeat-client fast charting: the pure landing model. This module carries the
// ONE concept the fast path adds on top of the governed 0157 copy: which
// just-created treatment area the practitioner lands in, and how that survives
// the server round trip. It performs no I/O and owns no write path.

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("landingBlockId: the FIRST area created by the batch", () => {
  it("is element 0, which copy_session_setup assigns sort_order 1", () => {
    expect(landingBlockId([A, B, C])).toBe(A);
  });

  it("is stable across an idempotent replay (the ledger returns the same array)", () => {
    const created = [A, B];
    expect(landingBlockId(created)).toBe(landingBlockId([...created]));
  });

  it("is null when nothing was created, so the caller falls back to a plain refresh", () => {
    expect(landingBlockId([])).toBeNull();
    expect(landingBlockId(null)).toBeNull();
    expect(landingBlockId(undefined)).toBeNull();
  });

  it("rejects a blank/non-string id rather than routing to a meaningless anchor", () => {
    expect(landingBlockId([""])).toBeNull();
    expect(landingBlockId(["   "])).toBeNull();
    expect(landingBlockId([undefined as unknown as string])).toBeNull();
  });
});

describe("fastChartUrl: a same-origin path carrying the landing area", () => {
  it("is path-only (no origin, no protocol) so it can never navigate off-site", () => {
    const url = fastChartUrl("client-1", "session-1", A);
    expect(url.startsWith("/clients/")).toBe(true);
    expect(url).not.toMatch(/^https?:|^\/\//);
    expect(url).toBe(`/clients/client-1/sessions/session-1?${FAST_CHART_PARAM}=${A}`);
  });

  it("encodes every segment, so a hostile id cannot break out of the query", () => {
    const url = fastChartUrl("c/../..", "s?x=1", "b&chart=other#frag");
    expect(url).toBe(
      "/clients/c%2F..%2F../sessions/s%3Fx%3D1?chart=b%26chart%3Dother%23frag",
    );
    // Concretely: no second `?`, no bare `&`, no `#` survives into the URL.
    expect(url.indexOf("?")).toBe(url.lastIndexOf("?"));
    expect(url).not.toMatch(/[&#]/);
  });
});

describe("resolveAutoEditBlockId: fails closed against anything not on this chart", () => {
  const live = [A, B];

  it("honours a live block id on this session", () => {
    expect(resolveAutoEditBlockId(A, live)).toBe(A);
    expect(resolveAutoEditBlockId(` ${B} `, live)).toBe(B);
  });

  it("returns null for an id that is not a live block here (stale, removed, or another session's)", () => {
    expect(resolveAutoEditBlockId(C, live)).toBeNull();
    expect(resolveAutoEditBlockId(A, [])).toBeNull();
  });

  it("returns null when the param is absent or blank", () => {
    expect(resolveAutoEditBlockId(undefined, live)).toBeNull();
    expect(resolveAutoEditBlockId(null, live)).toBeNull();
    expect(resolveAutoEditBlockId("", live)).toBeNull();
    expect(resolveAutoEditBlockId("   ", live)).toBeNull();
  });

  it("returns null for a REPEATED param (?chart=a&chart=b), never silently picking one", () => {
    expect(resolveAutoEditBlockId([A, B], live)).toBeNull();
    expect(resolveAutoEditBlockId([A], live)).toBeNull();
  });

  it("cannot be used to widen anything, it only ever names a block already rendered", () => {
    // Whatever the browser sends, the result is either null or a member of the
    // live list the server itself computed.
    for (const hostile of [
      "'; drop table session_blocks; --",
      "../../other-session",
      "*",
      "%",
      A.toUpperCase(),
    ]) {
      const resolved = resolveAutoEditBlockId(hostile, live);
      expect(resolved === null || live.includes(resolved)).toBe(true);
    }
  });
});
