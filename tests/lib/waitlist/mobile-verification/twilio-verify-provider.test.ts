import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TwilioVerifyProvider } from "@/lib/waitlist/mobile-verification/twilio-verify-provider";

// ===========================================================================
// THE REAL TWILIO VERIFY ADAPTER — EVERY MAPPING, NO NETWORK
// ===========================================================================
//
// `fetch` is stubbed in every test. Nothing here reaches Twilio, sends an SMS or
// needs credentials that exist; the env below is fabricated so the adapter gets
// past its own configuration check and no further.
//
// WHAT THIS FILE IS FOR. The adapter's whole job is to turn Twilio's vocabulary
// into the four coarse values in `mobile-verification/types.ts`, and exactly one
// of those values can promote a standing. So each mapping is asserted
// individually rather than by sampling, and the two that would be dangerous if
// wrong — `pending` on check, and a timeout on check — are asserted twice, once
// for the value and once for what it must NOT be.

// THE FLAG IS ONE OF THE ADAPTER'S OWN INPUTS, not just the resolver's. It
// enforces the same four-input predicate, so a test that armed only the three
// credentials would get `unavailable` from everything and prove nothing.
const ENV_KEYS = [
  "HONE_MOBILE_VERIFICATION_LIVE",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_VERIFY_SERVICE_SID",
] as const;

const SAVED: Record<string, string | undefined> = {};
const TO = "+15555550123";
const CODE = "123456";

/** Fabricated, and shaped like the real thing only so a URL can be built. */
function configure(): void {
  process.env.HONE_MOBILE_VERIFICATION_LIVE = "true";
  process.env.TWILIO_ACCOUNT_SID = "ACtest0000000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "authtoken-not-real";
  process.env.TWILIO_VERIFY_SERVICE_SID = "VAtest0000000000000000000000000000";
}

type Reply = { status: number; body?: unknown; throws?: "abort" | "network" };

let calls: { url: string; init: RequestInit }[] = [];

function stubFetch(reply: Reply): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (reply.throws === "abort") {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      if (reply.throws === "network") throw new TypeError("fetch failed");
      return {
        status: reply.status,
        json: async () => {
          if (reply.body === undefined) throw new SyntaxError("not json");
          return reply.body;
        },
      } as unknown as Response;
    }),
  );
}

beforeEach(() => {
  calls = [];
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  configure();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

const provider = () => new TwilioVerifyProvider();

describe("start — mapping", () => {
  const cases: ReadonlyArray<[string, Reply, string]> = [
    ["201 pending is the success case", { status: 201, body: { status: "pending" } }, "started"],
    ["200 pending is accepted too", { status: 200, body: { status: "pending" } }, "started"],
    ["429 is a rate limit", { status: 429, body: { code: 20429 } }, "rate_limited"],
    ["60203 max send attempts", { status: 400, body: { code: 60203 } }, "rate_limited"],
    ["60212 too many concurrent", { status: 400, body: { code: 60212 } }, "rate_limited"],
    ["an ordinary 400 is a refusal", { status: 400, body: { code: 60200 } }, "refused"],
    ["a 400 with no code is a refusal", { status: 400, body: {} }, "refused"],
    ["404 is a refusal", { status: 404, body: {} }, "refused"],
    ["401 is an outage, not the person's fault", { status: 401, body: {} }, "unavailable"],
    ["403 is an outage", { status: 403, body: {} }, "unavailable"],
    ["500 is an outage", { status: 500, body: {} }, "unavailable"],
    ["503 is an outage", { status: 503, body: {} }, "unavailable"],
    ["a timeout is an outage", { status: 0, throws: "abort" }, "unavailable"],
    ["a network failure is an outage", { status: 0, throws: "network" }, "unavailable"],
    ["a non-JSON 201 is an outage", { status: 201 }, "unavailable"],
    ["a 201 with no status field is an outage", { status: 201, body: { sid: "VE1" } }, "unavailable"],
  ];

  for (const [name, reply, expected] of cases) {
    it(name, async () => {
      stubFetch(reply);
      expect(await provider().start({ e164: TO })).toBe(expected);
    });
  }

  it("NEVER reports an approval, whatever the start endpoint says", () => {
    // A start that reported an approval would be a possession proof nobody
    // proved. There is no path to `approved` in `start` at all.
    return (async () => {
      stubFetch({ status: 201, body: { status: "approved" } });
      const outcome = await provider().start({ e164: TO });
      expect(outcome).not.toBe("approved");
      expect(outcome).toBe("unavailable");
    })();
  });
});

describe("check — mapping", () => {
  const cases: ReadonlyArray<[string, Reply, string]> = [
    ["200 approved is the ONLY approval", { status: 200, body: { status: "approved" } }, "approved"],
    ["200 pending means the code was wrong", { status: 200, body: { status: "pending" } }, "rejected"],
    ["200 canceled is a rejection", { status: 200, body: { status: "canceled" } }, "rejected"],
    ["404 (expired or consumed) collapses to rejected", { status: 404, body: {} }, "rejected"],
    ["429 is a rate limit", { status: 429, body: {} }, "rate_limited"],
    // 60202 IS TERMINAL, SO IT IS `rejected` AND NOT `rate_limited`. P2 at
    // b72d393d: ./types.ts puts "too many attempts" with wrong and expired, on
    // purpose, and reserves `rate_limited` for a WINDOW limit.
    ["60202 max check attempts is a REJECTION, not a window limit", { status: 400, body: { code: 60202 } }, "rejected"],
    ["60212 too many concurrent IS a window limit", { status: 400, body: { code: 60212 } }, "rate_limited"],
    ["an ordinary 400 is an OUTAGE, not a rejection", { status: 400, body: { code: 60200 } }, "unavailable"],
    ["401 is an outage", { status: 401, body: {} }, "unavailable"],
    ["500 is an outage", { status: 500, body: {} }, "unavailable"],
    ["a timeout is an outage", { status: 0, throws: "abort" }, "unavailable"],
    ["a network failure is an outage", { status: 0, throws: "network" }, "unavailable"],
    ["a non-JSON 200 is an outage", { status: 200 }, "unavailable"],
    ["an unrecognised status string is an outage", { status: 200, body: { status: "weird" } }, "unavailable"],
  ];

  for (const [name, reply, expected] of cases) {
    it(name, async () => {
      stubFetch(reply);
      expect(await provider().check({ e164: TO }, CODE)).toBe(expected);
    });
  }

  it("a timeout is never reported as a rejection", async () => {
    // The dangerous direction. A timed-out check may have been APPROVED on
    // Twilio's side; `rejected` would tell a person their code was wrong about a
    // proof that may well have succeeded.
    stubFetch({ status: 0, throws: "abort" });
    expect(await provider().check({ e164: TO }, CODE)).not.toBe("rejected");
  });

  it("only the literal string 'approved' approves", async () => {
    for (const status of ["Approved", "APPROVED", "approved_", "pending", "", "ok"]) {
      stubFetch({ status: 200, body: { status } });
      expect(
        await provider().check({ e164: TO }, CODE),
        `"${status}" must not approve`,
      ).not.toBe("approved");
    }
  });
});

describe("the request it actually sends", () => {
  it("start posts To and a CONSTANT sms channel, and nothing else", async () => {
    stubFetch({ status: 201, body: { status: "pending" } });
    await provider().start({ e164: TO });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://verify.twilio.com/v2/Services/VAtest0000000000000000000000000000/Verifications",
    );
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(body.get("To")).toBe(TO);
    expect(body.get("Channel")).toBe("sms");
    expect([...body.keys()].sort()).toEqual(["Channel", "To"]);
  });

  it("check posts To and Code, and the code is passed through untouched", async () => {
    stubFetch({ status: 200, body: { status: "approved" } });
    await provider().check({ e164: TO }, " 0042 ");
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(body.get("Code")).toBe(" 0042 ");
    expect([...body.keys()].sort()).toEqual(["Code", "To"]);
    expect(calls[0].url).toMatch(/\/VerificationCheck$/);
  });

  it("authenticates with Basic auth over the account credentials", async () => {
    stubFetch({ status: 201, body: { status: "pending" } });
    await provider().start({ e164: TO });
    const auth = (calls[0].init.headers as Record<string, string>).Authorization;
    expect(auth).toMatch(/^Basic /);
    expect(Buffer.from(auth.slice(6), "base64").toString()).toBe(
      "ACtest0000000000000000000000000000:authtoken-not-real",
    );
  });

  it("every request is bounded by an abort signal", async () => {
    stubFetch({ status: 201, body: { status: "pending" } });
    await provider().start({ e164: TO });
    expect(calls[0].init.signal).toBeTruthy();
  });
});

describe("configuration is read per call, and its absence performs no request", () => {
  // ALL FOUR, INCLUDING THE FLAG. That the adapter refuses on its own when the flag
  // is unset is the fix for the P1 raised at b6cecbb0: the resolver's gate was the
  // only enforcement point, and this class is exported.
  for (const missing of ENV_KEYS) {
    it(`${missing} absent -> unavailable, with NO request made`, async () => {
      delete process.env[missing];
      stubFetch({ status: 201, body: { status: "pending" } });
      expect(await provider().start({ e164: TO })).toBe("unavailable");
      expect(await provider().check({ e164: TO }, CODE)).toBe("unavailable");
      expect(calls, "an unconfigured adapter must not call out").toHaveLength(0);
    });
  }

  it("one instance follows a LATER env change, because config is not cached", async () => {
    const p = provider();
    delete process.env.TWILIO_VERIFY_SERVICE_SID;
    stubFetch({ status: 201, body: { status: "pending" } });
    expect(await p.start({ e164: TO })).toBe("unavailable");
    configure();
    expect(await p.start({ e164: TO })).toBe("started");
  });
});

describe("LOG_SECRET_NEGATIVE_CONTROL", () => {
  it("no secret, code or number appears in any returned value", async () => {
    // The outcome is an enum, so this is cheap to state and worth stating: there
    // is no shape in which the adapter can hand a caller something to log.
    for (const reply of [
      { status: 200, body: { status: "approved" } },
      { status: 400, body: { code: 60200, message: `bad To ${TO}` } },
      { status: 0, throws: "network" as const },
    ]) {
      stubFetch(reply);
      const out = JSON.stringify([
        await provider().start({ e164: TO }),
        await provider().check({ e164: TO }, CODE),
      ]);
      expect(out).not.toContain(TO);
      expect(out).not.toContain(CODE);
      expect(out).not.toContain("authtoken-not-real");
      expect(out).not.toContain("VAtest0000000000000000000000000000");
    }
  });
});

describe("the check path cannot re-expose what the contract coarsened", () => {
  // P2 at b72d393d, and the half that matters more than the retry advice.
  //
  // ./types.ts collapses "wrong, expired, already-consumed, too many attempts" into
  // ONE value because a surface must render one message: learning that a code
  // EXISTED to be exhausted is learning that the number is on a waitlist. A
  // distinct `rate_limited` for an exhausted verification handed that distinction
  // straight back, which is the membership oracle this whole boundary is shaped to
  // avoid.

  it("every terminal outcome is indistinguishable from a wrong code", async () => {
    const terminal: Reply[] = [
      { status: 200, body: { status: "pending" } },   // wrong code
      { status: 200, body: { status: "canceled" } },  // cancelled
      { status: 404, body: {} },                     // expired or consumed
      { status: 400, body: { code: 60202 } },         // attempts exhausted
    ];
    const outcomes: string[] = [];
    for (const reply of terminal) {
      stubFetch(reply);
      outcomes.push(await provider().check({ e164: TO }, CODE));
    }
    expect(new Set(outcomes), `distinguishable: ${outcomes.join(", ")}`).toEqual(
      new Set(["rejected"]),
    );
  });

  it("rate_limited on check is reachable ONLY from a genuine window limit", async () => {
    // The counterweight: the value must still exist and still be reachable, or the
    // assertion above could be satisfied by collapsing everything.
    for (const reply of [
      { status: 429, body: {} } as Reply,
      { status: 400, body: { code: 20429 } } as Reply,
    ]) {
      stubFetch(reply);
      expect(await provider().check({ e164: TO }, CODE)).toBe("rate_limited");
    }
  });

  it("start and check do not share a code set", async () => {
    // 60203 is "max SEND attempts", which IS a window limit on start. It must not
    // become a check outcome by sharing a set, and 60202 must not become a start
    // outcome either.
    stubFetch({ status: 400, body: { code: 60203 } });
    expect(await provider().start({ e164: TO })).toBe("rate_limited");
    stubFetch({ status: 400, body: { code: 60202 } });
    expect(await provider().start({ e164: TO })).toBe("refused");
  });
});
