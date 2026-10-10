import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// B2a — ONE STOP, EVERY APPLICABLE ROW FOR THAT PHONE
// ===========================================================================
//
// 0202 gave waitlist entries the six SMS columns, which made it possible to
// RECORD a prospect's consent while nothing could honour their STOP. This file
// proves the second half now exists, and proves it at the ROUTE — the selector's
// own unit tests (tests/lib/sms/suppression.test.ts) already cover the matching
// rule, and re-asserting it here would test the mock.
//
// WHAT IS DELIBERATELY REAL: `normalizePhoneForMatch` and `isStopKeyword`. They
// are pure, and the phone-format and keyword cases below are only meaningful if
// the real implementations run. Only the signature validator and the database
// are substituted.
//
// NOT DUPLICATED HERE, because it is already proven where it belongs:
//   * `mobile_verified_at` has no writer — tests/db/waitlist-profile-and-sms-
//     consent-authority.db.test.ts, against a real database and 0202's guard;
//   * prospect send eligibility — tests/lib/waitlist/prospect-sms-consent.test.ts.

import { candidateRows, pagedSource, type PagedSource } from "@/tests/lib/sms/helpers/postgrest-pages";

type Row = { id: string; studio_id: string; phone: string | null; sms_opted_out_at: string | null };

const h: {
  clients: Row[];
  prospects: Row[];
  /** Both scans answer like PostgREST: row-limited pages (Codex P1 4234615485). */
  clientSource: PagedSource;
  prospectSource: PagedSource;
  /** Fail exactly this page (0-based) of a scan. */
  clientPageFail: number | null;
  prospectPageFail: number | null;
  validSignature: boolean;
  clientUpdates: Array<{ id: string }>;
  suppressCalls: Array<{ ids: string[]; optedAt: string }>;
  audits: Array<{ entity_type: string; entity_id: string; studio_id: string; metadata: Record<string, unknown> }>;
  failClientUpdate: boolean;
  failClientScan: boolean;
  failProspectScan: boolean;
  failProspectSuppress: boolean;
} = {
  clients: [], prospects: [],
  clientSource: pagedSource(() => []), prospectSource: pagedSource(() => []),
  clientPageFail: null, prospectPageFail: null,
  validSignature: true,
  clientUpdates: [], suppressCalls: [], audits: [],
  failClientUpdate: false, failClientScan: false, failProspectScan: false, failProspectSuppress: false,
};

vi.mock("@/lib/sms/twilio", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sms/twilio")>();
  return { ...real, validateTwilioFormRequest: () => h.validSignature };
});

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (table === "audit_logs") {
        return {
          insert(rows: typeof h.audits) {
            h.audits.push(...rows);
            return Promise.resolve({ error: null });
          },
        };
      }
      // clients: select(...) starts one row-limited page of the scan;
      // update(...).eq(...).is(...) records the stamp.
      return {
        select: () => h.clientSource.query(),
        update: () => ({
          eq: (_c: string, id: string) => ({
            is: () => {
              if (h.failClientUpdate) return Promise.resolve({ error: { code: "XX", message: "boom" } });
              h.clientUpdates.push({ id });
              return Promise.resolve({ error: null });
            },
          }),
        }),
      };
    },
    rpc(fn: string, args?: Record<string, unknown>) {
      if (fn === "waitlist_prospect_suppression_candidates") return h.prospectSource.query();
      if (fn === "suppress_waitlist_prospects") {
        const ids = (args?.p_entry_ids as string[]) ?? [];
        h.suppressCalls.push({ ids, optedAt: String(args?.p_opted_at) });
        if (h.failProspectSuppress) return Promise.resolve({ data: null, error: { code: "YY", message: "stamp boom" } });
        // Mirrors the command: only rows not already opted out come back.
        const stamped = ids
          .filter((id) => !h.prospects.find((p) => p.id === id)?.sms_opted_out_at)
          .map((id) => ({ stamped_id: id }));
        return Promise.resolve({ data: stamped, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  }),
}));

const { POST } = await import("@/app/api/twilio/inbound-sms/route");

function post(body: Record<string, string>) {
  return POST(
    new Request("https://hone.care/api/twilio/inbound-sms", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "sig",
      },
      body: new URLSearchParams(body).toString(),
    }) as never,
  );
}

const stop = (from: string, to = "+15550001111") => post({ From: from, To: to, Body: "STOP", MessageSid: "SM1" });

beforeEach(() => {
  process.env.TWILIO_AUTH_TOKEN = "token";
  h.clients = [];
  h.prospects = [];
  h.validSignature = true;
  h.clientUpdates = [];
  h.suppressCalls = [];
  h.audits = [];
  h.failClientUpdate = false;
  h.failClientScan = false;
  h.failProspectScan = false;
  h.failProspectSuppress = false;
  h.clientPageFail = null;
  h.prospectPageFail = null;
  h.clientSource = pagedSource(() => h.clients, { fail: (i) => h.failClientScan || i === h.clientPageFail });
  h.prospectSource = pagedSource(() => h.prospects, { fail: (i) => h.failProspectScan || i === h.prospectPageFail });
});

const P = (id: string, studio: string, phone: string | null, out: string | null = null): Row => ({
  id, studio_id: studio, phone, sms_opted_out_at: out,
});

describe("a prospect-only phone is suppressed", () => {
  it("stamps the prospect row and audits it as a waitlist entry", async () => {
    h.prospects = [P("e1", "s1", "647-555-1234")];
    const res = await stop("+16475551234");
    expect(res.status).toBe(200);
    expect(h.suppressCalls[0].ids).toEqual(["e1"]);
    const audit = h.audits.find((a) => a.entity_id === "e1");
    expect(audit?.entity_type).toBe("new_client_waitlist_entry");
    expect(audit?.metadata.suppression_scope).toBe("phone_wide");
  });
});

describe("the client path is unchanged", () => {
  it("a client-only phone still suppresses exactly as before", async () => {
    h.clients = [P("c1", "s1", "+16475551234")];
    const res = await stop("+16475551234");
    expect(res.status).toBe(200);
    expect(h.clientUpdates).toEqual([{ id: "c1" }]);
    // No prospect rows exist, so the command is never called — adding the second
    // pass must not turn every STOP into a write it did not need.
    expect(h.suppressCalls).toEqual([]);
    expect(h.audits.find((a) => a.entity_id === "c1")?.entity_type).toBe("client");
  });
});

describe("one human, two record types", () => {
  it("the same phone as client AND prospect suppresses BOTH", async () => {
    // The case the whole slice exists for. A person who booked once and later
    // joined the waitlist is one human with one phone.
    h.clients = [P("c1", "s1", "647 555 1234")];
    h.prospects = [P("e1", "s1", "(647) 555-1234")];
    const res = await stop("+16475551234");
    expect(res.status).toBe(200);
    expect(h.clientUpdates).toEqual([{ id: "c1" }]);
    expect(h.suppressCalls[0].ids).toEqual(["e1"]);
  });
});

describe("suppression stays phone-wide across studios", () => {
  it("prospect rows in different studios are all suppressed", async () => {
    h.prospects = [P("e1", "s1", "+16475551234"), P("e2", "s2", "6475551234")];
    await stop("+16475551234");
    expect(h.suppressCalls[0].ids.sort()).toEqual(["e1", "e2"]);
  });

  it("the sender the STOP arrived on cannot narrow it", async () => {
    // Same data, a different `To`. Per-studio senders make filtering by the
    // inbound number look reasonable; it would reintroduce the cross-studio
    // leak, so the result must not move.
    h.prospects = [P("e1", "s1", "+16475551234"), P("e2", "s2", "+16475551234")];
    await stop("+16475551234", "+15559998888");
    expect(h.suppressCalls[0].ids.sort()).toEqual(["e1", "e2"]);
  });
});

describe("retries are harmless", () => {
  it("an already-opted-out prospect is not re-stamped or re-audited", async () => {
    h.prospects = [P("e1", "s1", "+16475551234", "2026-09-01T00:00:00.000Z")];
    const res = await stop("+16475551234");
    expect(res.status).toBe(200);
    // Selected out before the command, so it is not even asked for.
    expect(h.suppressCalls).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("a mixed retry only touches the row that was missed", async () => {
    h.prospects = [
      P("e1", "s1", "+16475551234", "2026-09-01T00:00:00.000Z"),
      P("e2", "s2", "+16475551234"),
    ];
    await stop("+16475551234");
    expect(h.suppressCalls[0].ids).toEqual(["e2"]);
    expect(h.audits.map((a) => a.entity_id)).toEqual(["e2"]);
  });
});

describe("matching is by phone, not by string", () => {
  for (const stored of ["+16475551234", "647-555-1234", "(647) 555 1234", "1 647 555 1234"]) {
    it(`stored as ${JSON.stringify(stored)} still matches an inbound +1 number`, async () => {
      h.prospects = [P("e1", "s1", stored)];
      await stop("+16475551234");
      expect(h.suppressCalls[0]?.ids).toEqual(["e1"]);
    });
  }

  it("an unrelated phone is untouched", async () => {
    h.prospects = [P("e1", "s1", "+16470000000")];
    h.clients = [P("c1", "s1", "+16470000000")];
    await stop("+16475551234");
    expect(h.suppressCalls).toEqual([]);
    expect(h.clientUpdates).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("a prospect with no stored phone is never matched", async () => {
    h.prospects = [P("e1", "s1", null)];
    await stop("+16475551234");
    expect(h.suppressCalls).toEqual([]);
  });
});

describe("authentication and intent gate every write", () => {
  it("an invalid signature produces ZERO writes of either kind", async () => {
    h.validSignature = false;
    h.clients = [P("c1", "s1", "+16475551234")];
    h.prospects = [P("e1", "s1", "+16475551234")];
    const res = await stop("+16475551234");
    expect(res.status).toBe(403);
    expect(h.clientUpdates).toEqual([]);
    expect(h.suppressCalls).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("a non-STOP message produces zero suppression writes", async () => {
    h.clients = [P("c1", "s1", "+16475551234")];
    h.prospects = [P("e1", "s1", "+16475551234")];
    const res = await post({ From: "+16475551234", To: "+15550001111", Body: "hello", MessageSid: "SM2" });
    expect(res.status).toBe(200);
    expect(h.clientUpdates).toEqual([]);
    expect(h.suppressCalls).toEqual([]);
    expect(h.audits).toEqual([]);
  });
});

describe("an unprotected prospect earns a retry", () => {
  it("a failed prospect scan returns 500 so Twilio asks again", async () => {
    // A prospect we could not READ is exactly as unprotected as one we could
    // not stamp. Reporting 200 would leave them opted in with no second chance.
    h.failProspectScan = true;
    h.prospects = [P("e1", "s1", "+16475551234")];
    const res = await stop("+16475551234");
    expect(res.status).toBe(500);
  });

  it("a failed prospect stamp returns 500", async () => {
    h.failProspectSuppress = true;
    h.prospects = [P("e1", "s1", "+16475551234")];
    const res = await stop("+16475551234");
    expect(res.status).toBe(500);
  });

  it("a client failure does not deny a prospect the protection", async () => {
    // Both passes are attempted before the status is decided, so one bad row
    // cannot cost the other record type its suppression.
    h.failClientUpdate = true;
    h.clients = [P("c1", "s1", "+16475551234")];
    h.prospects = [P("e1", "s1", "+16475551234")];
    const res = await stop("+16475551234");
    expect(res.status).toBe(500);
    expect(h.suppressCalls[0].ids).toEqual(["e1"]);
  });
});

describe("neither record type can be starved by the other's failure", () => {
  it("a failed CLIENT SCAN still suppresses the prospect", async () => {
    // Found in review. The clients SELECT catch used to return 500 immediately,
    // and it sits ABOVE the prospect pass — so a persistent client read failure
    // would have stopped a healthy prospect from ever being suppressed, on every
    // retry. The 500 still happens; it is just decided after both passes.
    h.failClientScan = true;
    h.prospects = [P("e1", "s1", "+16475551234")];
    const res = await stop("+16475551234");
    expect(res.status).toBe(500);
    expect(h.suppressCalls[0].ids).toEqual(["e1"]);
    expect(h.audits.map((a) => a.entity_id)).toEqual(["e1"]);
  });
});

describe("a suppression that landed is always recorded", () => {
  it("audits the successful subset BEFORE returning the retryable 500", async () => {
    // Found in review. The status decision used to run before both audit
    // blocks, so on a partial failure the audit for a suppression that DID land
    // was never written — and a retry skips rows already stamped, so it was lost
    // for good. A suppression with no record of it is the one outcome nobody can
    // reconstruct afterwards.
    h.failClientUpdate = true;
    h.clients = [P("c1", "s1", "+16475551234")];
    h.prospects = [P("e1", "s1", "+16475551234")];
    const res = await stop("+16475551234");
    expect(res.status).toBe(500);
    expect(h.suppressCalls[0].ids).toEqual(["e1"]);
    // The prospect stamp succeeded, so its audit row must exist despite the 500.
    expect(h.audits.map((a) => a.entity_id)).toEqual(["e1"]);
  });

  it("the audit survives the reverse partial failure too", async () => {
    h.failProspectSuppress = true;
    h.clients = [P("c1", "s1", "+16475551234")];
    h.prospects = [P("e1", "s1", "+16475551234")];
    const res = await stop("+16475551234");
    expect(res.status).toBe(500);
    expect(h.clientUpdates).toEqual([{ id: "c1" }]);
    expect(h.audits.map((a) => a.entity_id)).toEqual(["c1"]);
  });
});

describe("the route holds no second suppression rule", () => {
  it("uses the shared selector and passes no studio or sender to it", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("app/api/twilio/inbound-sms/route.ts", "utf8"),
    );
    // Two call sites, one function: clients and prospects are selected by the
    // same rule. A WAIT-only matcher here is the thing this asserts against.
    const callSites = [...src.matchAll(/selectHoneSuppressionTargets\(\{([\s\S]*?)\}\)/g)].map(
      (m) => m[1],
    );
    expect(callSites.length, "both record types go through the shared selector").toBe(2);

    // SCOPED TO THE ARGUMENTS, not the file. An earlier version of this
    // assertion searched the whole route and matched a harmless local
    // `studio_id: studioId` in the audit mapping — a rule that fails on correct
    // code teaches people to delete it. What must never appear is a studio or
    // the inbound `To` being handed to the selector, because either would let
    // one sender's STOP stop covering the other studios.
    for (const args of callSites) {
      expect(args, "no studio scoping reaches the selector").not.toMatch(/studio/i);
      expect(args, "the inbound To never reaches the selector").not.toMatch(/\bto\b/);
      expect(args, "matching is on the sender-blind From").toMatch(/fromPhone:\s*from/);
    }
  });
});

// ===========================================================================
// THE SCANS ARE COMPLETE PAST THE API'S ROW LIMIT (Codex P1 4234615485).
// One PostgREST response stops at its row limit (1,000) with no error, so a
// single read would never see a match past it, and that STOP would never be
// recorded. Both scans now read to the end. A failed page is a failed scan:
// the existing posture, a 500 so Twilio retries.
// ===========================================================================
describe("a STOP is recorded however many rows precede the match", () => {
  const FROM = "+14165557777";

  it("a CLIENT whose number is row 1,500 of 2,000 clients with a phone is opted out", async () => {
    h.clients = candidateRows(2000, "c", { sms_opted_out_at: null }, { 1500: { phone: "(416) 555-7777" } }) as Row[];
    const res = await stop(FROM);
    expect(res.status).toBe(200);
    expect(h.clientUpdates).toEqual([{ id: "c-001500" }]);
    expect(h.clientSource.requests).toBe(3); // 1,000 + 1,000, then the empty page
  });

  it("a PROSPECT whose number is row 1,200 of 1,300 prospect candidates is suppressed", async () => {
    h.prospects = candidateRows(1300, "p", { sms_opted_out_at: null }, { 1200: { phone: "416.555.7777" } }) as Row[];
    const res = await stop(FROM);
    expect(res.status).toBe(200);
    expect(h.suppressCalls.map((c) => c.ids)).toEqual([["p-001200"]]);
  });

  it("a failed SECOND page of the client scan is a failed scan: 500, so Twilio retries", async () => {
    h.clients = candidateRows(1500, "c", { sms_opted_out_at: null });
    h.clientPageFail = 1;
    const res = await stop(FROM);
    expect(res.status).toBe(500);
    expect(h.clientUpdates).toEqual([]);
  });

  it("a failed SECOND page of the prospect scan is a failed scan: 500", async () => {
    h.prospects = candidateRows(1500, "p", { sms_opted_out_at: null });
    h.prospectPageFail = 1;
    const res = await stop(FROM);
    expect(res.status).toBe(500);
    expect(h.suppressCalls).toEqual([]);
  });

  it("control: a match on the first page still opts out exactly as before", async () => {
    h.clients = candidateRows(10, "c", { sms_opted_out_at: null }, { 4: { phone: "+1 416 555 7777" } }) as Row[];
    const res = await stop(FROM);
    expect(res.status).toBe(200);
    expect(h.clientUpdates).toEqual([{ id: "c-000004" }]);
  });
});
