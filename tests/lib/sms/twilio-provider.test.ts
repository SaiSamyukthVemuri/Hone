import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// COMMS-01B — the REAL Twilio adapter, exercised against a stubbed fetch.
//
// WHY THIS FILE EXISTS. The fake provider proves the orchestration; it cannot
// prove the adapter, because a fake does not enforce a provider's parameter
// grammar. That gap shipped a defect: `isNumberAvailable` sent the E.164`+` to
// Twilio's `Contains`, which accepts digits and `*`. Every live provisioning
// attempt would have died on a 400 before any purchase, on a number that was
// perfectly available -- and every test was green, because nothing checked what
// the adapter actually put on the wire.
//
// So these tests assert the REQUEST, not just the response handling. No network
// is touched: `fetch` is stubbed and every call is recorded.

type Recorded = { url: string; method: string; body: string | null };

let calls: Recorded[] = [];

function stubFetch(responses: Array<{ status: number; json: unknown }>) {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
      });
      const res = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: async () => res.json,
      } as unknown as Response;
    }),
  );
}

// The adapter is server-only and reads credentials at call time.
beforeEach(async () => {
  calls = [];
  vi.stubEnv("TWILIO_ACCOUNT_SID", "ACtest");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "sekrit");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function adapter() {
  const mod = await import("@/lib/sms/provider/twilio-provider");
  return mod.twilioProvisioningProvider;
}

const MG = (c: string) => `MG${c.repeat(32)}`;

// ---------------------------------------------------------------------------
// isNumberAvailable — the request grammar
// ---------------------------------------------------------------------------

describe("isNumberAvailable", () => {
  it("sends DIGITS to Contains, never the E.164 plus", async () => {
    stubFetch([
      { status: 200, json: { available_phone_numbers: [{ phone_number: "+14165550100" }] } },
    ]);
    const provider = await adapter();
    const res = await provider.isNumberAvailable({
      country: "CA",
      phoneNumber: "+14165550100",
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.available).toBe(true);

    // THE ASSERTION THE DEFECT NEEDED. Twilio's Contains matches digits and
    // `*`; a `+` yields 400 and would have killed every live attempt.
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("Contains")).toBe("14165550100");
    expect(url.searchParams.get("Contains")).not.toContain("+");
  });

  it("still compares the RESPONSE in E.164, where the provider does speak it", async () => {
    // A near-miss number must not count as the chosen one.
    stubFetch([
      { status: 200, json: { available_phone_numbers: [{ phone_number: "+14165550999" }] } },
    ]);
    const provider = await adapter();
    const res = await provider.isNumberAvailable({
      country: "CA",
      phoneNumber: "+14165550100",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// purchaseNumber — 400 classification
// ---------------------------------------------------------------------------

describe("purchaseNumber", () => {
  it.each([21421, 21422, 21452])(
    "maps Twilio code %i to number_no_longer_available",
    async (code) => {
      stubFetch([{ status: 400, json: { code } }]);
      const provider = await adapter();
      const res = await provider.purchaseNumber({
        claimKey: `hone-sms-${"a".repeat(32)}`,
        phoneNumber: "+14165550100",
      });
      expect(res).toMatchObject({ ok: false, code: "number_no_longer_available" });
    },
  );

  it("does NOT tell the owner to pick another number for an unrelated 400", async () => {
    // 21649 is a regulatory-bundle failure: it follows the owner to every
    // number, so "choose another" sends them round a loop that cannot end.
    stubFetch([{ status: 400, json: { code: 21649 } }]);
    const provider = await adapter();
    const res = await provider.purchaseNumber({
      claimKey: `hone-sms-${"a".repeat(32)}`,
      phoneNumber: "+14165550100",
    });
    expect(res).toMatchObject({ ok: false, code: "provider_rejected" });
  });

  it("asks for the EXACT number and never an area code", async () => {
    stubFetch([
      { status: 201, json: { sid: `PN${"a".repeat(32)}`, phone_number: "+14165550100" } },
    ]);
    const provider = await adapter();
    await provider.purchaseNumber({
      claimKey: `hone-sms-${"b".repeat(32)}`,
      phoneNumber: "+14165550100",
    });
    const body = new URLSearchParams(calls[0].body ?? "");
    expect(body.get("PhoneNumber")).toBe("+14165550100");
    // AreaCode would let Twilio choose something else -- a silent substitution.
    expect(body.get("AreaCode")).toBeNull();
    // The claim key rides along as the reconciliation handle.
    expect(body.get("FriendlyName")).toContain("hone-sms-");
  });
});

// ---------------------------------------------------------------------------
// lookupResourcesByClaim — pagination must be exhaustive AND strict
// ---------------------------------------------------------------------------

describe("lookupResourcesByClaim", () => {
  const claimKey = `hone-sms-${"c".repeat(32)}`;
  const tag = `hone-sms-claim:${claimKey}`;

  const noNumbers = { status: 200, json: { incoming_phone_numbers: [] } };

  it("follows pagination and finds a service on a later page", async () => {
    stubFetch([
      noNumbers,
      {
        status: 200,
        json: {
          services: [{ sid: MG("1"), friendly_name: "someone else" }],
          meta: { next_page_url: "https://messaging.twilio.com/v1/Services?Page=1" },
        },
      },
      {
        status: 200,
        json: {
          services: [{ sid: MG("2"), friendly_name: tag }],
          meta: { next_page_url: null },
        },
      },
    ]);
    const provider = await adapter();
    const res = await provider.lookupResourcesByClaim(claimKey);

    expect(res.ok).toBe(true);
    // A first-page-only scan would have reported "no service" and licensed a
    // duplicate. The account crosses one page at ~100 studios.
    if (res.ok) expect(res.found.messagingServiceSid).toBe(MG("2"));
  });

  it("FAILS CLOSED on malformed pagination metadata rather than calling it the end", async () => {
    stubFetch([
      noNumbers,
      { status: 200, json: { services: [] } }, // no meta at all
    ]);
    const provider = await adapter();
    const res = await provider.lookupResourcesByClaim(claimKey);
    // Absent metadata is not proof of absence.
    expect(res).toMatchObject({ ok: false, code: "provider_response_unparseable" });
  });

  it("FAILS CLOSED on a cursor pointing off Twilio's host", async () => {
    stubFetch([
      noNumbers,
      {
        status: 200,
        json: { services: [], meta: { next_page_url: "https://elsewhere.example/Services" } },
      },
    ]);
    const provider = await adapter();
    expect(await provider.lookupResourcesByClaim(claimKey)).toMatchObject({
      ok: false,
      code: "provider_response_unparseable",
    });
  });

  it("accepts an explicit null cursor as the genuine last page", async () => {
    stubFetch([noNumbers, { status: 200, json: { services: [], meta: { next_page_url: null } } }]);
    const provider = await adapter();
    const res = await provider.lookupResourcesByClaim(claimKey);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.found.messagingServiceSid).toBeNull();
  });

  it("refuses to choose when one claim carries two numbers", async () => {
    stubFetch([
      {
        status: 200,
        json: {
          incoming_phone_numbers: [
            { sid: `PN${"a".repeat(32)}`, phone_number: "+14165550100" },
            { sid: `PN${"b".repeat(32)}`, phone_number: "+14165550101" },
          ],
        },
      },
    ]);
    const provider = await adapter();
    // Two numbers under one claim is the catastrophe; surfacing it beats guessing.
    expect(await provider.lookupResourcesByClaim(claimKey)).toMatchObject({
      ok: false,
      code: "provider_resource_mismatch",
    });
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe("credentials", () => {
  it("never puts the Auth Token in a URL or a body", async () => {
    stubFetch([{ status: 200, json: { available_phone_numbers: [] } }]);
    const provider = await adapter();
    await provider.isNumberAvailable({ country: "CA", phoneNumber: "+14165550100" });
    for (const call of calls) {
      expect(call.url).not.toContain("sekrit");
      expect(call.body ?? "").not.toContain("sekrit");
    }
  });

  it("refuses to call anything at all when unconfigured", async () => {
    vi.unstubAllEnvs();
    stubFetch([{ status: 200, json: {} }]);
    const provider = await adapter();
    expect(
      await provider.isNumberAvailable({ country: "CA", phoneNumber: "+14165550100" }),
    ).toMatchObject({ ok: false, code: "provider_not_configured" });
    expect(calls).toHaveLength(0);
  });
});
