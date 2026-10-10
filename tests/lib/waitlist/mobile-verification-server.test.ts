import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FakeMobileVerificationProvider,
  FAKE_VERIFICATION_CODE,
  resolveMobileVerificationProvider,
  type MobileVerificationProvider,
} from "@/lib/waitlist/mobile-verification";
import { prospectMayReceiveSms } from "@/lib/waitlist/prospect-sms-consent";

// ===========================================================================
// WAIT B2b — POSSESSION PROOF, AND NOTHING ELSE, PROMOTES A MOBILE
// ===========================================================================
//
// The database half is proved against a real database by 0203's own validation
// (the guard admits one writer, a permit for row A authorizes nothing over row
// B, a verified instant cannot move or be cleared, and 0202's carried rules
// still hold). What can only be proved HERE is the ORDER: that the provider is
// asked first, that every non-approval returns before a write exists to make,
// and that a submitted code can never construct verified evidence by itself.

type RpcCall = { fn: string; args: Record<string, unknown> };

const h: {
  calls: RpcCall[];
  reply: string | null;
  error: boolean;
  throws: boolean;
} = { calls: [], reply: "verified", error: false, throws: false };

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    async rpc(fn: string, args: Record<string, unknown>) {
      h.calls.push({ fn, args });
      if (h.throws) throw new Error("transport exploded");
      if (h.error) return { data: null, error: { message: "boom" } };
      return { data: h.reply, error: null };
    },
  }),
}));

const { startMobileVerification, checkMobileVerification } = await import(
  "@/lib/waitlist/mobile-verification-server"
);

const ENTRY = "11111111-1111-4111-8111-111111111111";
const STORED = "647-555-1234";
let provider: FakeMobileVerificationProvider;

beforeEach(() => {
  h.calls = [];
  h.reply = "verified";
  h.error = false;
  h.throws = false;
  provider = new FakeMobileVerificationProvider();
});

const start = (storedPhone: string | null = STORED) =>
  startMobileVerification({ entryId: ENTRY, storedPhone }, provider);

const check = (code: string, storedPhone: string | null = STORED) =>
  checkMobileVerification({ entryId: ENTRY, storedPhone, code }, provider);

describe("a challenge is addressed to the ROW, never to the request", () => {
  it("starts for a stored mobile", async () => {
    expect(await start()).toEqual({ ok: true });
  });

  it("refuses when the row holds no mobile", async () => {
    expect(await start(null)).toEqual({ ok: false, code: "no_destination" });
  });

  it("refuses a stored value that cannot be addressed", async () => {
    // A legacy row holding "n/a" or a short landline. Guessing a country code
    // for it would start a challenge to somebody else entirely.
    expect(await start("n/a")).toEqual({ ok: false, code: "no_destination" });
    expect(await start("12345")).toEqual({ ok: false, code: "no_destination" });
  });

  it("maps a provider refusal, rate limit and outage to distinct codes", async () => {
    provider.scriptStart("refused");
    expect(await start()).toEqual({ ok: false, code: "not_proved" });
    provider.scriptStart("rate_limited");
    expect(await start()).toEqual({ ok: false, code: "rate_limited" });
    provider.scriptStart("unavailable");
    expect(await start()).toEqual({ ok: false, code: "unavailable" });
  });
});

describe("only the provider's approval writes anything", () => {
  it("a WRONG code performs zero verification write", async () => {
    await start();
    expect(await check("999999")).toEqual({ ok: false, code: "not_proved" });
    expect(h.calls).toEqual([]);
  });

  it("a code with no live challenge performs zero write", async () => {
    // `check` before `start`. The fake refuses because nothing was challenged;
    // the point is that Hone does not treat a submitted code as self-proving.
    expect(await check(FAKE_VERIFICATION_CODE)).toEqual({ ok: false, code: "not_proved" });
    expect(h.calls).toEqual([]);
  });

  it("a REJECTED proof (wrong, expired, consumed) performs zero write", async () => {
    await start();
    provider.scriptCheck("rejected");
    expect(await check(FAKE_VERIFICATION_CODE)).toEqual({ ok: false, code: "not_proved" });
    expect(h.calls).toEqual([]);
  });

  it("an UNAVAILABLE provider performs zero write", async () => {
    await start();
    provider.scriptCheck("unavailable");
    expect(await check(FAKE_VERIFICATION_CODE)).toEqual({ ok: false, code: "unavailable" });
    expect(h.calls).toEqual([]);
  });

  it("a RATE LIMITED check performs zero write", async () => {
    await start();
    provider.scriptCheck("rate_limited");
    expect(await check(FAKE_VERIFICATION_CODE)).toEqual({ ok: false, code: "rate_limited" });
    expect(h.calls).toEqual([]);
  });

  it("an empty code performs zero write and never reaches the provider", async () => {
    // COUNTED, not assumed. A first version of this test only checked the
    // outcome, and deleting the guard entirely still passed it -- the fake
    // rejects "" on its own. The guard exists so a blank submission is not spent
    // as a provider attempt against a rate limit, so the count is the assertion.
    let asked = 0;
    const counting: MobileVerificationProvider = {
      start: (d) => provider.start(d),
      check: (d, code) => {
        asked += 1;
        return provider.check(d, code);
      },
    };
    await startMobileVerification({ entryId: ENTRY, storedPhone: STORED }, counting);
    expect(
      await checkMobileVerification({ entryId: ENTRY, storedPhone: STORED, code: "   " }, counting),
    ).toEqual({ ok: false, code: "not_proved" });
    expect(asked, "the provider was asked about a blank code").toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("an unaddressable stored number refuses the CHECK too, not just the start", async () => {
    // The refusal has to exist on both entry points. Covering it only on `start`
    // left `check`'s early return untested, and a mutation that turned it into a
    // success went unnoticed.
    expect(await check(FAKE_VERIFICATION_CODE, null)).toEqual({
      ok: false,
      code: "no_destination",
    });
    expect(await check(FAKE_VERIFICATION_CODE, "n/a")).toEqual({
      ok: false,
      code: "no_destination",
    });
    expect(h.calls).toEqual([]);
  });

  it("a provider that THROWS performs zero write", async () => {
    const exploding = {
      start: async () => "started" as const,
      check: async () => {
        throw new Error("network");
      },
    };
    const out = await checkMobileVerification(
      { entryId: ENTRY, storedPhone: STORED, code: "123456" },
      exploding as never,
    );
    expect(out).toEqual({ ok: false, code: "unavailable" });
    expect(h.calls).toEqual([]);
  });
});

describe("an UNRECOGNIZED provider outcome is an outage, never a rejection", () => {
  // `not_proved` is a statement about the PERSON'S CODE and only `rejected` earns
  // it. An earlier revision ended `check` with a catch-all `!== "approved"` ->
  // `not_proved`, which was right for today's four-value union and wrong for the
  // two cases that will actually occur: a real adapter returning a status this
  // module does not map (Twilio Verify has more than four), or a fifth
  // non-approval outcome added later. Both would have told someone their proof was
  // rejected when nothing evaluated it.

  const withCheck = (value: unknown): MobileVerificationProvider =>
    ({
      start: async () => "started",
      check: async () => value,
    }) as never;

  it("an unmapped provider status is unavailable, not not_proved", async () => {
    for (const bogus of ["pending", "canceled", "max_attempts_reached", "APPROVED", "", null]) {
      const out = await checkMobileVerification(
        { entryId: ENTRY, storedPhone: STORED, code: "123456" },
        withCheck(bogus),
      );
      expect(out, `outcome ${String(bogus)} was misreported`).toEqual({
        ok: false,
        code: "unavailable",
      });
    }
    expect(h.calls, "an unrecognized outcome reached the promoting command").toEqual([]);
  });

  it("`rejected` is the ONLY outcome that earns not_proved", async () => {
    expect(
      await checkMobileVerification(
        { entryId: ENTRY, storedPhone: STORED, code: "123456" },
        withCheck("rejected"),
      ),
    ).toEqual({ ok: false, code: "not_proved" });
    expect(h.calls).toEqual([]);
  });

  it("a near-miss on the approval string cannot promote", async () => {
    // Guards the one direction that matters: only the exact value writes.
    for (const near of ["approve", "approved ", " approved", "Approved"]) {
      const out = await checkMobileVerification(
        { entryId: ENTRY, storedPhone: STORED, code: "123456" },
        withCheck(near),
      );
      expect(out, `${JSON.stringify(near)} was treated as approval`).toEqual({
        ok: false,
        code: "unavailable",
      });
    }
    expect(h.calls).toEqual([]);
  });

  it("start and check agree about unknown outcomes", async () => {
    // The rule `start` documented is now the rule both paths follow.
    const p = withCheck("who_knows");
    const started = await startMobileVerification({ entryId: ENTRY, storedPhone: STORED }, {
      start: async () => "who_knows",
      check: async () => "unavailable",
    } as never);
    expect(started).toEqual({ ok: false, code: "unavailable" });
    expect(
      await checkMobileVerification({ entryId: ENTRY, storedPhone: STORED, code: "1" }, p),
    ).toEqual({ ok: false, code: "unavailable" });
  });
});

describe("an approved proof promotes exactly this row's stored mobile", () => {
  it("calls the one command with the entry and the value AS STORED", async () => {
    await start();
    expect(await check(FAKE_VERIFICATION_CODE)).toEqual({ ok: true, verified: true });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].fn).toBe("mark_waitlist_mobile_verified");
    expect(h.calls[0].args.p_entry_id).toBe(ENTRY);
    // AS STORED, not canonicalized: the command compares exactly, so sending
    // "+16475551234" here would refuse every real proof.
    expect(h.calls[0].args.p_expected_phone).toBe(STORED);
  });

  it("never sends a verification instant — the database supplies it", async () => {
    await start();
    await check(FAKE_VERIFICATION_CODE);
    const keys = Object.keys(h.calls[0].args).join(",");
    expect(keys).not.toMatch(/verified_at|timestamp|now/i);
    expect(Object.keys(h.calls[0].args)).toEqual(["p_entry_id", "p_expected_phone"]);
  });

  it("a proof for phone A cannot verify a row storing phone B", async () => {
    // The row moved under us, or the caller resolved the wrong entry. The
    // command answers `phone_mismatch` and no standing is claimed.
    await start();
    h.reply = "phone_mismatch";
    expect(await check(FAKE_VERIFICATION_CODE)).toEqual({ ok: false, code: "no_destination" });
  });

  it("a retry after success is idempotent", async () => {
    await start();
    h.reply = "already_verified";
    expect(await check(FAKE_VERIFICATION_CODE)).toEqual({ ok: true, verified: true });
  });

  it("an unknown command result is an outage, never a refusal", async () => {
    await start();
    h.reply = "some_new_code";
    expect(await check(FAKE_VERIFICATION_CODE)).toEqual({ ok: false, code: "unavailable" });
  });

  it("a command error or throw writes nothing and asks for a retry", async () => {
    await start();
    h.error = true;
    expect(await check(FAKE_VERIFICATION_CODE)).toEqual({ ok: false, code: "unavailable" });
    provider.reset();
    await start();
    h.error = false;
    h.throws = true;
    expect(await check(FAKE_VERIFICATION_CODE)).toEqual({ ok: false, code: "unavailable" });
  });
});

describe("THE DEFAULT PROVIDER PROVES NOTHING — no injection, no verification", () => {
  // THE GAP THAT LET A REAL DEFECT THROUGH. Every other test in this file injects
  // a provider explicitly, so nothing ever exercised the default -- and the
  // default was the FAKE, which reports `started` without sending and approves
  // the exported constant FAKE_VERIFICATION_CODE. An unconfigured production
  // deployment calling these helpers with no second argument would have promoted
  // a number to verified with no possession proof behind it.
  //
  // These tests call the real entry points with NO provider argument, which is
  // exactly how a future route in B2b-2 will call them by default.

  it("start is unavailable, not started", async () => {
    expect(await startMobileVerification({ entryId: ENTRY, storedPhone: STORED })).toEqual({
      ok: false,
      code: "unavailable",
    });
  });

  it("the well-known fake code proves NOTHING and writes NOTHING", async () => {
    expect(
      await checkMobileVerification({
        entryId: ENTRY,
        storedPhone: STORED,
        code: FAKE_VERIFICATION_CODE,
      }),
    ).toEqual({ ok: false, code: "unavailable" });
    expect(h.calls, "the service-role command was called without a possession proof").toEqual([]);
  });

  it("NO code reaches an approval by default — swept, not sampled", async () => {
    for (const code of [FAKE_VERIFICATION_CODE, "000000", "123456", "999999", "0"]) {
      const out = await checkMobileVerification({ entryId: ENTRY, storedPhone: STORED, code });
      expect(out, `code ${code} was not refused by default`).toEqual({
        ok: false,
        code: "unavailable",
      });
    }
    expect(h.calls).toEqual([]);
  });

  it("the resolver itself never hands back something that can approve", async () => {
    // Asserted on the resolver, so a future edit that swaps the default back is
    // caught here even if no entry point happens to be exercised.
    const p = resolveMobileVerificationProvider();
    expect(await p.start({ e164: "+16475551234" })).toBe("unavailable");
    expect(await p.check({ e164: "+16475551234" }, FAKE_VERIFICATION_CODE)).toBe("unavailable");
  });
});

describe("the module cannot be asked who a phone belongs to", () => {
  it("exposes no phone-only entry point", () => {
    // A "start verification for this number" function would be a membership
    // oracle: a caller who learns a challenge was accepted has learned the
    // number is on a waitlist. Both entry points require an already-resolved
    // entry id, and this asserts the shape rather than trusting the prose.
    const src = readFileSync(
      path.join(__dirname, "../../../lib/waitlist/mobile-verification-server.ts"),
      "utf8",
    );
    const exported = [...src.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
    expect(exported.sort()).toEqual(["checkMobileVerification", "startMobileVerification"]);
    // Every exported entry point takes the target type, which carries entryId.
    for (const fn of exported) {
      const sig = src.slice(src.indexOf(`export async function ${fn}(`)).slice(0, 220);
      expect(sig, fn).toMatch(/MobileVerificationTarget/);
    }
  });

  it("emits no logs at all, so none can carry a code or a full number", () => {
    const src = readFileSync(
      path.join(__dirname, "../../../lib/waitlist/mobile-verification-server.ts"),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    for (const pattern of [/console\./, /logEvent\(/, /logError\(/]) {
      expect(code, String(pattern)).not.toMatch(pattern);
    }
  });
});

describe("send eligibility: consent and no STOP decide, verification is optional (D4(2))", () => {
  const V = "2026-09-27T10:00:00.000Z";
  const C = "2026-09-27T10:05:00.000Z";

  it("verification WITHOUT consent is ineligible", () => {
    expect(
      prospectMayReceiveSms({ mobile_verified_at: V, sms_consent_at: null, sms_opted_out_at: null }),
    ).toBe(false);
  });

  it("consent WITHOUT verification is eligible (Roadmap v1.25)", () => {
    expect(
      prospectMayReceiveSms({ mobile_verified_at: null, sms_consent_at: C, sms_opted_out_at: null }),
    ).toBe(true);
  });

  it("verification AND consent but OPTED OUT is ineligible", () => {
    // B2a made the opt-out reachable for a prospect; verifying a mobile must
    // never resurrect sendability for someone who said STOP.
    expect(
      prospectMayReceiveSms({ mobile_verified_at: V, sms_consent_at: C, sms_opted_out_at: V }),
    ).toBe(false);
  });

  it("verification adds nothing to the decision", () => {
    expect(
      prospectMayReceiveSms({ mobile_verified_at: V, sms_consent_at: C, sms_opted_out_at: null }),
    ).toBe(true);
  });

  it("nothing in this slice clears an opt-out", () => {
    const src = readFileSync(
      path.join(__dirname, "../../../lib/waitlist/mobile-verification-server.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/sms_opted_out_at/);
    expect(src).not.toMatch(/sms_consent/);
  });
});
