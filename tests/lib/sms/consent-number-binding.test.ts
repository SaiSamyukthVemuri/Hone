import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { passesConsentGate } from "@/lib/sms/consent-gate";
import { CONSENT_PHONE_UNKNOWN, readClientConsentPhone } from "@/lib/sms/consent-phone-read";
import { stampPublicBookingConsent } from "@/lib/booking/public-consent-stamp";

// A consent is for the number it was given for. The gate, the fail-closed reader, the fresh-consent stamp and the wiring of
// every caller that builds the client object for a send.

const studio = { id: "s1", send_confirmation_sms: true, send_24h_sms_reminders: true, send_2h_sms_reminders: true };
const gate = (client: { phone: string | null; sms_consent_at: string | null; sms_consent_phone: string | null; sms_opted_out_at: string | null }) =>
  passesConsentGate({ studio, client, smsType: "confirmation" });
const base = { phone: "+14165550100", sms_consent_at: "2026-09-01T10:00:00Z", sms_consent_phone: "+14165550100" as string | null, sms_opted_out_at: null };

describe("the consent gate binds consent to the number", () => {
  it("passes when the bound number is the number the client holds, however it is typed", () => {
    expect(gate(base)).toEqual({ ok: true, normalizedPhone: "+14165550100" });
    expect(gate({ ...base, phone: "(416) 555-0100" }).ok).toBe(true);
  });
  it("refuses a bound consent when the client's number is a different one", () => {
    expect(gate({ ...base, phone: "+14165550199" })).toEqual({ ok: false, reason: "consent_for_other_number" });
  });
  it("allows a legacy consent (no bound number) as before", () => {
    expect(gate({ ...base, sms_consent_phone: null }).ok).toBe(true);
  });
  it("refuses the no-number marker and the unknown marker for every destination", () => {
    expect(gate({ ...base, sms_consent_phone: "-" })).toEqual({ ok: false, reason: "consent_for_other_number" });
    expect(gate({ ...base, sms_consent_phone: CONSENT_PHONE_UNKNOWN }).ok).toBe(false);
  });
  it("the earlier refusals keep their order: opt-out, then no consent, then an unusable number", () => {
    expect(gate({ ...base, sms_opted_out_at: "2026-09-02T00:00:00Z", sms_consent_phone: "+14165550199" })).toEqual({ ok: false, reason: "client_opted_out" });
    expect(gate({ ...base, sms_consent_at: null })).toEqual({ ok: false, reason: "client_no_consent" });
    expect(gate({ ...base, phone: "abc" })).toEqual({ ok: false, reason: "invalid_phone" });
  });
});

type Row = { data: unknown; error: unknown } | "throw";
const fakeAdmin = (result: Row) =>
  ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (result === "throw") throw new Error("boom");
            return result;
          },
        }),
      }),
    }),
  }) as never;

describe("readClientConsentPhone fails closed", () => {
  it("returns null with no consent, whatever else is true", async () => {
    expect(await readClientConsentPhone(fakeAdmin("throw"), "c1", null)).toBeNull();
  });
  it("returns the marker when the client is unknown, the row is missing, the read errors or throws", async () => {
    expect(await readClientConsentPhone(fakeAdmin({ data: null, error: null }), null, "t")).toBe("-");
    expect(await readClientConsentPhone(fakeAdmin({ data: null, error: null }), "c1", "t")).toBe("-");
    expect(await readClientConsentPhone(fakeAdmin({ data: null, error: { code: "x" } }), "c1", "t")).toBe("-");
    expect(await readClientConsentPhone(fakeAdmin("throw"), "c1", "t")).toBe("-");
  });
  it("returns the stored number, or null for a legacy consent", async () => {
    expect(await readClientConsentPhone(fakeAdmin({ data: { sms_consent_phone: "+14165550100" }, error: null }), "c1", "t")).toBe("+14165550100");
    expect(await readClientConsentPhone(fakeAdmin({ data: { sms_consent_phone: null }, error: null }), "c1", "t")).toBeNull();
  });
});

describe("the fresh-consent stamp is a compare-and-set on the bound number", () => {
  const recorder = () => {
    const calls: string[] = [];
    const chain: Record<string, unknown> = {};
    const fn = (name: string) => (...a: unknown[]) => {
      calls.push(`${name}:${a.map(String).join(",")}`);
      return chain;
    };
    for (const n of ["update", "eq", "is"]) chain[n] = fn(n);
    chain.select = () => Promise.resolve({ data: [{ sms_consent_at: "t" }], error: null });
    return { admin: { from: () => chain } as never, calls };
  };
  it("a first consent still requires no existing consent", async () => {
    const r = recorder();
    expect((await stampPublicBookingConsent(r.admin, "c1", "T")).result).toBe("stamped");
    expect(r.calls).toContain("is:sms_consent_at,null");
    expect(r.calls.some((c) => c.startsWith("eq:sms_consent_phone"))).toBe(false);
  });
  it("a replacement goes through the replacement function with the bound number and the wording version, never a plain update", async () => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const admin = {
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return Promise.resolve({ data: true, error: null });
      },
      from: () => {
        throw new Error("a replacement must not write the table directly");
      },
    };
    const r = await stampPublicBookingConsent(admin as never, "c1", "T", "+14165550100", "booking_sms_v2");
    expect(r.result).toBe("stamped");
    expect(calls).toEqual([{ fn: "replace_client_sms_consent", args: { p_client_id: "c1", p_bound_phone: "+14165550100", p_consent_at: "T", p_text_version: "booking_sms_v2" } }]);
  });
  it("no row replaced (false) falls through to adopting what is on record", async () => {
    const admin = {
      rpc: () => Promise.resolve({ data: false, error: null }),
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { sms_consent_at: "X", sms_opted_out_at: null }, error: null }) }) }) }),
    };
    expect(await stampPublicBookingConsent(admin as never, "c1", "T", "+14165550100")).toEqual({ result: "already_recorded", smsConsentAt: "X", smsOptedOutAt: null });
  });
});

describe("every sender of a text carries the bound number (source contracts)", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  // Per path: the client object handed to the gate carries a value for sms_consent_phone that is read from the row (never a literal), and the row is
  // selected with the column. The type requirement (the next test) is the compile-time pin; these assert each path's actual wiring.
  const handed = (src: string) => [...src.matchAll(/\bsms_consent_phone:\s*([^,\n}]+)/g)].map((m) => m[1].trim()).filter((v) => !/^(string|null)\b/.test(v));
  const notLiteral = (vals: string[]) => vals.length > 0 && vals.every((v) => !/^(null|undefined|["'`])/.test(v));
  const paths: [string, number][] = [
    ["app/book/[slug]/actions.ts", 1],
    ["app/reschedule/[token]/actions.ts", 1],
    ["app/portal/rebook-actions.ts", 1],
    ["app/(app)/calendar/actions.ts", 2],
  ];
  for (const [f, n] of paths) {
    it(`${f} selects the column and hands the row's value to the gate (${n} call${n > 1 ? "s" : ""})`, () => {
      const src = read(f);
      expect(src).toMatch(/\.select\("[^"]*sms_consent_phone[^"]*"\)/);
      const v = handed(src);
      expect(v.length, f).toBeGreaterThanOrEqual(n);
      expect(notLiteral(v), `${f}: ${v.join(" | ")}`).toBe(true);
    });
  }
  it("the public booking reads the bound number fresh before building the confirmation client", () => {
    const src = read("app/book/[slug]/actions.ts");
    expect(src.indexOf("readClientConsentPhone(admin, clientId, clientSmsConsentAt)")).toBeGreaterThan(0);
    expect(src.indexOf("readClientConsentPhone(admin, clientId, clientSmsConsentAt)")).toBeLessThan(src.indexOf("sms_consent_phone: clientSmsConsentPhone"));
  });
  it("the cron selects the column at both its queries, and sendReminder hands its client straight to the gate", () => {
    expect(read("app/api/cron/appointment-reminders/route.ts")).toMatch(/client:clients\([^)]*sms_consent_phone/);
    expect(read("lib/cron/reminder-candidate-query.ts")).toMatch(/client:clients!inner\([^)]*sms_consent_phone/);
    expect(read("lib/sms/send-appointment.ts")).toMatch(/passesConsentGate\(\{\s*studio: args\.studio,\s*client: args\.client,/);
  });
  it("the gate input requires the field, so a caller that omits it does not compile", () => {
    expect(read("lib/sms/consent-gate.ts")).toMatch(/Pick<Client, "phone" \| "sms_consent_at" \| "sms_consent_phone" \| "sms_opted_out_at">/);
    expect(read("lib/sms/send-appointment.ts").match(/"sms_consent_at" \| "sms_consent_phone"/g)?.length).toBe(2);
  });
  it("the public booking refuses consent with a number that cannot receive texts before any write, and re-stamps only against the number on file", () => {
    const s = read("app/book/[slug]/actions.ts");
    expect(s.indexOf("smsConsent && normalizePhoneForSms(phone) === null")).toBeGreaterThan(0);
    expect(s.indexOf("smsConsent && normalizePhoneForSms(phone) === null")).toBeLessThan(s.indexOf("limitPublicBooking({"));
    expect(s).toMatch(/consentIsForOtherNumber/);
    expect(s).toMatch(/submittedDigits === storedDigits/);
  });
  it("the edit screen tells staff that changing a consenting client's number pauses their texts", () => {
    expect(read("app/(app)/clients/[id]/edit/page.tsx")).toMatch(/texts to them stop until they confirm the new number/);
  });
});
