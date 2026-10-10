import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { lookupPhoneWideSuppression } from "@/lib/sms/phone-suppression-lookup";
import { SUPPRESSION_READ_MAX_PAGES, SUPPRESSION_READ_PAGE_SIZE } from "@/lib/sms/suppression-candidates";
import { candidateRows, pagedSource, type FakeRow } from "@/tests/lib/sms/helpers/postgrest-pages";

// ===========================================================================
// 0208 — THE PHONE-WIDE READ: COMPLETE, AND FAIL-CLOSED (Codex P1 4234615485)
// ===========================================================================
//
// The two candidate sources are the STOP route's own: opted-out `clients`, and
// prospects through 0202's `waitlist_prospect_suppression_candidates`. Each
// response from the fake stops at the API's row limit with no error, exactly
// as PostgREST does. What this proves:
// - both sources are read to the end, past the row limit, so a STOP anywhere
//   is found;
// - only stamped rows count, and the matching law is the STOP route's;
// - ANY failed, incomplete or bounded-out read answers `ok: false`, never
//   "not suppressed".
// The same premise, on a REAL PostgREST: tests/db/sms-stop-read-beyond-row-limit.db.test.ts.

const OPTED_OUT = "2026-09-01T10:00:00.000Z";
const TARGET = "+1 (416) 555-7777";
const ASKED = "416-555-7777";

function fakeAdmin(
  clients: () => readonly FakeRow[],
  prospects: () => readonly FakeRow[],
  opts: {
    clientFail?: (i: number) => boolean;
    prospectFail?: (i: number) => boolean;
    clientThrows?: (i: number) => boolean;
    prospectThrows?: (i: number) => boolean;
    cap?: number;
  } = {},
) {
  const clientSource = pagedSource(clients, { cap: opts.cap, fail: opts.clientFail, throws: opts.clientThrows });
  const prospectSource = pagedSource(prospects, { cap: opts.cap, fail: opts.prospectFail, throws: opts.prospectThrows });
  const tables: string[] = [];
  const rpcs: string[] = [];
  const admin = {
    from(table: string) {
      tables.push(table);
      if (table !== "clients") throw new Error(`unexpected table ${table}`);
      return clientSource.query();
    },
    rpc(name: string) {
      rpcs.push(name);
      if (name !== "waitlist_prospect_suppression_candidates") throw new Error(`unexpected rpc ${name}`);
      return prospectSource.query();
    },
  };
  return { admin: admin as unknown as SupabaseClient, clientSource, prospectSource, tables, rpcs };
}

describe("the read", () => {
  it("reads only `clients` and 0202's prospect candidates, and nothing else", async () => {
    const f = fakeAdmin(() => [], () => []);
    expect(await lookupPhoneWideSuppression(f.admin, ASKED)).toEqual({ ok: true, suppressed: false });
    expect(new Set(f.tables)).toEqual(new Set(["clients"]));
    expect(new Set(f.rpcs)).toEqual(new Set(["waitlist_prospect_suppression_candidates"]));
  });

  it("pages until a page comes back EMPTY: a server limit below the page size cannot end it early", async () => {
    // A server that caps at 300, under the reader's page size of 1,000: a reader
    // trusting a short page to be the last would stop after 300 rows.
    const f = fakeAdmin(() => candidateRows(950, "c", {}, { 940: { phone: TARGET } }), () => [], { cap: 300 });
    expect(await lookupPhoneWideSuppression(f.admin, ASKED)).toEqual({ ok: true, suppressed: true });
    expect(f.clientSource.requests).toBe(5); // 300 + 300 + 300 + 50, then the empty page
  });
});

describe("a STOP beyond the response limit is still found", () => {
  it("a CLIENT's STOP that is row 1,500 of 2,000 opted-out clients", async () => {
    const f = fakeAdmin(() => candidateRows(2000, "c", {}, { 1500: { phone: TARGET } }), () => []);
    expect(await lookupPhoneWideSuppression(f.admin, ASKED)).toEqual({ ok: true, suppressed: true });
  });

  it("a PROSPECT's STOP that is row 1,200 of 1,300 prospect candidates", async () => {
    const prospects = candidateRows(1300, "p", { sms_opted_out_at: null }, { 1200: { phone: TARGET, sms_opted_out_at: OPTED_OUT } });
    const f = fakeAdmin(() => [], () => prospects);
    expect(await lookupPhoneWideSuppression(f.admin, ASKED)).toEqual({ ok: true, suppressed: true });
  });
});

describe("FAILS CLOSED: a failed, incomplete or bounded-out read is `ok: false`, never `not suppressed`", () => {
  it("the SECOND page of clients fails", async () => {
    const f = fakeAdmin(() => candidateRows(1500, "c"), () => [], { clientFail: (i) => i === 1 });
    expect(await lookupPhoneWideSuppression(f.admin, ASKED)).toEqual({ ok: false });
  });

  it("the SECOND page of prospects fails", async () => {
    const f = fakeAdmin(() => [], () => candidateRows(1500, "p"), { prospectFail: (i) => i === 1 });
    expect(await lookupPhoneWideSuppression(f.admin, ASKED)).toEqual({ ok: false });
  });

  it("an error or a throw from either source, on the first page", async () => {
    for (const opts of [
      { clientFail: () => true },
      { prospectFail: () => true },
      { clientThrows: () => true },
      { prospectThrows: () => true },
    ]) {
      const f = fakeAdmin(() => candidateRows(3, "c"), () => candidateRows(3, "p"), opts);
      expect(await lookupPhoneWideSuppression(f.admin, ASKED), Object.keys(opts).join()).toEqual({ ok: false });
    }
  });

  it("BOUNDED OUT: more rows than the page ceiling allows is incomplete, so it fails closed", async () => {
    // An endless source: every page after `after` is full. Generated per page,
    // so the test stays fast while proving the reader stops at the ceiling.
    let requests = 0;
    const endless = {
      from: () => {
        let after: string | null = null;
        const b: Record<string, unknown> = {
          select: () => b, not: () => b, order: () => b, limit: () => b,
          gt: (_col: string, value: string) => ((after = value), b),
          then: (resolve: (v: unknown) => unknown) => {
            requests += 1;
            const start = after ? Number(after.slice(2)) + 1 : 1;
            const data = Array.from({ length: SUPPRESSION_READ_PAGE_SIZE }, (_, i) => ({
              id: `c-${String(start + i).padStart(9, "0")}`,
              studio_id: "studio-1",
              phone: "+14160000000",
              sms_opted_out_at: OPTED_OUT,
            }));
            return Promise.resolve({ data, error: null }).then(resolve);
          },
        };
        return b;
      },
      rpc: () => pagedSource(() => []).query(),
    } as unknown as SupabaseClient;
    expect(await lookupPhoneWideSuppression(endless, ASKED)).toEqual({ ok: false });
    expect(requests).toBe(SUPPRESSION_READ_MAX_PAGES);
  });

  it("a page whose ids do not advance is not trusted", async () => {
    // A misbehaving source that ignores the keyset filter answers the same page
    // forever; the reader refuses on the second identical page.
    const page = candidateRows(SUPPRESSION_READ_PAGE_SIZE, "c");
    const stuck = {
      from: () => {
        const b: Record<string, unknown> = {
          select: () => b, not: () => b, gt: () => b, order: () => b, limit: () => b,
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: page, error: null }).then(resolve),
        };
        return b;
      },
      rpc: () => pagedSource(() => []).query(),
    } as unknown as SupabaseClient;
    expect(await lookupPhoneWideSuppression(stuck, ASKED)).toEqual({ ok: false });
  });
});

describe("controls", () => {
  it("a client who said STOP in ANOTHER studio suppresses the number (the phone-wide law)", async () => {
    const f = fakeAdmin(
      () => [{ id: "c-1", studio_id: "studio-b", phone: "(416) 555-7777", sms_opted_out_at: OPTED_OUT }],
      () => [],
    );
    expect(await lookupPhoneWideSuppression(f.admin, "+1 416 555 7777")).toEqual({ ok: true, suppressed: true });
  });

  it("a prospect counts only once stamped", async () => {
    const prospect = { id: "p-1", studio_id: "studio-b", phone: TARGET };
    const unstamped = fakeAdmin(() => [], () => [{ ...prospect, sms_opted_out_at: null }]);
    expect(await lookupPhoneWideSuppression(unstamped.admin, ASKED)).toEqual({ ok: true, suppressed: false });
    const stamped = fakeAdmin(() => [], () => [{ ...prospect, sms_opted_out_at: OPTED_OUT }]);
    expect(await lookupPhoneWideSuppression(stamped.admin, ASKED)).toEqual({ ok: true, suppressed: true });
  });

  it("a STOP inside the first page is found", async () => {
    const f = fakeAdmin(() => candidateRows(10, "c", {}, { 3: { phone: TARGET } }), () => []);
    expect(await lookupPhoneWideSuppression(f.admin, ASKED)).toEqual({ ok: true, suppressed: true });
  });

  it("2,500 opted-out rows, none of them this number: a complete read says not suppressed", async () => {
    const f = fakeAdmin(() => candidateRows(2500, "c"), () => candidateRows(1200, "p"));
    expect(await lookupPhoneWideSuppression(f.admin, ASKED)).toEqual({ ok: true, suppressed: false });
  });
});
