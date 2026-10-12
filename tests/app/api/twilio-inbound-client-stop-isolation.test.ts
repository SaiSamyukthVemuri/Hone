import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// WILLOW-ISOLATION-01 — a client's STOP, across studios and senders (#824)
// ===========================================================================
//
// Per-studio senders are coming (#824, SMS lane): each studio texts from its
// own number. That makes one tempting "improvement" dangerous: treating a STOP
// that arrived on Studio B's number as a STOP for Studio B only. Hone's law is
// that STOP is a statement by a PERSON about their PHONE, so it must reach every
// client record holding that number, in every studio, whatever number it
// arrived on.
//
// tests/app/api/twilio-inbound-prospect-stop.test.ts proves this for waitlist
// prospects. This file proves it for CLIENTS, the record type whose appointment
// texts are live today, and adds the cases a per-studio sender makes new:
//   * the `To` number (Studio B's own sender, or the platform's) never changes
//     WHO is opted out, and each audit row is attributed to its own studio;
//   * an opt-out the studio already recorded (a withdrawal) is never
//     re-stamped, re-sourced or re-audited by a later STOP. 0211 (#827) makes
//     that opt-out terminal in the database; here the route never even tries;
//   * only the exact STOP keywords act: START, HELP and STOP-like sentences
//     write nothing, so no re-subscribe path exists by accident;
//   * an unsigned request reaches nobody, however many studios hold the number.
//
// WHAT IS REAL: the route, `normalizePhoneForMatch`, `isStopKeyword` and the
// shared selector. Only the signature check and the database are substituted.

import { pagedSource, type PagedSource } from "@/tests/lib/sms/helpers/postgrest-pages";

type Row = { id: string; studio_id: string; phone: string | null; sms_opted_out_at: string | null };

const h: {
  clients: Row[];
  prospects: Row[];
  clientSource: PagedSource;
  prospectSource: PagedSource;
  validSignature: boolean;
  clientUpdates: Array<{ id: string; values: Record<string, unknown> }>;
  suppressCalls: string[][];
  audits: Array<{ entity_type: string; entity_id: string; studio_id: string; metadata: Record<string, unknown> }>;
} = {
  clients: [],
  prospects: [],
  clientSource: pagedSource(() => []),
  prospectSource: pagedSource(() => []),
  validSignature: true,
  clientUpdates: [],
  suppressCalls: [],
  audits: [],
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
      return {
        select: () => h.clientSource.query(),
        update: (values: Record<string, unknown>) => ({
          eq: (_c: string, id: string) => ({
            is: (col: string, val: unknown) => {
              // The route must only ever stamp a row that has no opt-out yet.
              expect([col, val]).toEqual(["sms_opted_out_at", null]);
              h.clientUpdates.push({ id, values });
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
        h.suppressCalls.push(ids);
        return Promise.resolve({ data: ids.map((id) => ({ stamped_id: id })), error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  }),
}));

const { POST } = await import("@/app/api/twilio/inbound-sms/route");

const PLATFORM_SENDER = "+15550001111";
const STUDIO_B_SENDER = "+15559998888";
const PHONE = "+16475551234";

function inbound(body: string, from = PHONE, to = PLATFORM_SENDER, signed = true) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (signed) headers["x-twilio-signature"] = "sig";
  return POST(
    new Request("https://hone.care/api/twilio/inbound-sms", {
      method: "POST",
      headers,
      body: new URLSearchParams({ From: from, To: to, Body: body, MessageSid: "SM1" }).toString(),
    }) as never,
  );
}

const C = (id: string, studio: string, phone: string | null, out: string | null = null): Row => ({
  id,
  studio_id: studio,
  phone,
  sms_opted_out_at: out,
});

/** One person, three studios, three spellings of the same number, and a stranger. */
function threeStudiosOnePerson() {
  h.clients = [
    C("a1", "studio-a", "647-555-1234"),
    C("b1", "studio-b", "+1 (647) 555-1234"),
    C("c1", "studio-c", "6475551234"),
    C("d1", "studio-d", "+16475559999"),
  ];
}

beforeEach(() => {
  process.env.TWILIO_AUTH_TOKEN = "token";
  h.clients = [];
  h.prospects = [];
  h.validSignature = true;
  h.clientUpdates = [];
  h.suppressCalls = [];
  h.audits = [];
  h.clientSource = pagedSource(() => h.clients);
  h.prospectSource = pagedSource(() => h.prospects);
});

describe("the sender a STOP arrives on never narrows who is opted out", () => {
  it("a STOP sent to Studio B's own number opts the person out at A, B and C, and nobody else", async () => {
    threeStudiosOnePerson();
    const res = await inbound("STOP", PHONE, STUDIO_B_SENDER);
    expect(res.status).toBe(200);
    expect(h.clientUpdates.map((u) => u.id).sort()).toEqual(["a1", "b1", "c1"]);
    for (const u of h.clientUpdates) {
      expect(u.values).toMatchObject({ sms_opt_out_source: "twilio_stop" });
      expect(typeof u.values.sms_opted_out_at).toBe("string");
    }
  });

  it("the same STOP sent to the platform number reaches exactly the same rows", async () => {
    threeStudiosOnePerson();
    await inbound("STOP", PHONE, STUDIO_B_SENDER);
    const viaStudio = h.clientUpdates.map((u) => u.id).sort();
    h.clientUpdates = [];
    h.audits = [];
    await inbound("STOP", PHONE, PLATFORM_SENDER);
    expect(h.clientUpdates.map((u) => u.id).sort()).toEqual(viaStudio);
  });

  it("each audit row is attributed to the client's OWN studio, and says the scope was phone-wide", async () => {
    threeStudiosOnePerson();
    await inbound("STOP", PHONE, STUDIO_B_SENDER);
    const byClient = Object.fromEntries(h.audits.map((a) => [a.entity_id, a]));
    expect(Object.keys(byClient).sort()).toEqual(["a1", "b1", "c1"]);
    for (const [id, studio] of [
      ["a1", "studio-a"],
      ["b1", "studio-b"],
      ["c1", "studio-c"],
    ]) {
      expect(byClient[id]).toMatchObject({
        entity_type: "client",
        studio_id: studio,
        metadata: { source: "twilio_stop", suppression_scope: "phone_wide" },
      });
    }
    // No audit row carries either raw number, the person's (From) or the
    // studio sender it arrived on (To): only the masked forms.
    const stored = JSON.stringify(h.audits);
    for (const raw of [PHONE, STUDIO_B_SENDER]) {
      expect(stored).not.toContain(raw);
      expect(stored).not.toContain(raw.replace(/^\+1/, ""));
    }
  });
});

describe("a withdrawal the studio already recorded is left exactly as it is", () => {
  it("a STOP never re-stamps, re-sources or re-audits an existing opt-out, and still reaches the others", async () => {
    h.clients = [
      C("a1", "studio-a", PHONE, "2026-10-01T09:00:00.000Z"), // e.g. a studio-recorded withdrawal
      C("b1", "studio-b", PHONE),
    ];
    const res = await inbound("STOP", PHONE, STUDIO_B_SENDER);
    expect(res.status).toBe(200);
    expect(h.clientUpdates.map((u) => u.id)).toEqual(["b1"]);
    expect(h.audits.map((a) => a.entity_id)).toEqual(["b1"]);
  });

  it("when every record is already opted out, a STOP writes nothing and still answers 200", async () => {
    h.clients = [C("a1", "studio-a", PHONE, "2026-10-01T09:00:00.000Z")];
    const res = await inbound("STOP", PHONE, STUDIO_B_SENDER);
    expect(res.status).toBe(200);
    expect(h.clientUpdates).toEqual([]);
    expect(h.audits).toEqual([]);
  });
});

describe("only the exact STOP keywords act; nothing re-subscribes", () => {
  for (const body of ["START", "UNSTOP", "HELP", "YES", "STOP please", "please stop", "stop texting me"]) {
    it(`"${body}" writes nothing, in any studio`, async () => {
      threeStudiosOnePerson();
      const res = await inbound(body, PHONE, STUDIO_B_SENDER);
      expect(res.status).toBe(200);
      expect(h.clientUpdates).toEqual([]);
      expect(h.suppressCalls).toEqual([]);
      expect(h.audits).toEqual([]);
    });
  }

  for (const body of ["stop", " STOP ", "Stop", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "STOPALL"]) {
    it(`"${body}" is a STOP and reaches all three studios`, async () => {
      threeStudiosOnePerson();
      await inbound(body, PHONE, STUDIO_B_SENDER);
      expect(h.clientUpdates.map((u) => u.id).sort()).toEqual(["a1", "b1", "c1"]);
    });
  }
});

describe("authentication gates every studio at once", () => {
  it("an UNSIGNED STOP (no signature header at all) opts out nobody, even with the number in three studios", async () => {
    threeStudiosOnePerson();
    // The validator would accept: only the route's own missing-header guard can refuse.
    h.validSignature = true;
    const res = await inbound("STOP", PHONE, STUDIO_B_SENDER, false);
    expect(res.status).toBe(403);
    expect(h.clientUpdates).toEqual([]);
    expect(h.suppressCalls).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("a STOP whose signature does not verify opts out nobody either", async () => {
    threeStudiosOnePerson();
    h.validSignature = false;
    const res = await inbound("STOP", PHONE, STUDIO_B_SENDER);
    expect(res.status).toBe(403);
    expect(h.clientUpdates).toEqual([]);
    expect(h.suppressCalls).toEqual([]);
    expect(h.audits).toEqual([]);
  });
});

describe("clients and prospects of different studios are one person", () => {
  it("a STOP to Studio B's number reaches A's client and C's waitlist prospect alike", async () => {
    h.clients = [C("a1", "studio-a", PHONE)];
    h.prospects = [C("e3", "studio-c", "647 555 1234")];
    await inbound("STOP", PHONE, STUDIO_B_SENDER);
    expect(h.clientUpdates.map((u) => u.id)).toEqual(["a1"]);
    expect(h.suppressCalls).toEqual([["e3"]]);
  });
});
