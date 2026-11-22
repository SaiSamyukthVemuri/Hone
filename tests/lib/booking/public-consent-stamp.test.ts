import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { stampPublicBookingConsent } from "@/lib/booking/public-consent-stamp";

// G3 / 0211 follow-up (Codex P2 on #827): two overlapping public bookings for
// one unconsented client. The table is in memory and an UPDATE applies its
// filters atomically, as PostgreSQL does, so the race is reproduced rather
// than assumed. The 0211 guard itself is exercised for real in
// tests/db/client-sms-permission-guard.db.test.ts.

type Row = { id: string; sms_consent_at: string | null; sms_consent_source: string | null; sms_opted_out_at: string | null };

function fakeAdmin(row: Row, opts: { updateError?: boolean; readError?: boolean; throws?: boolean } = {}) {
  const calls: Array<{ op: string; filters: Array<[string, string, unknown]> }> = [];
  const admin = {
    from(table: string) {
      expect(table).toBe("clients");
      if (opts.throws) throw new Error("boom");
      const filters: Array<[string, string, unknown]> = [];
      let op = "select";
      let payload: Partial<Row> = {};
      const matches = () =>
        filters.every(([kind, col, v]) => (kind === "eq" || kind === "is" ? row[col as keyof Row] === v : true));
      const q = {
        update(p: Partial<Row>) {
          op = "update";
          payload = p;
          return q;
        },
        select() {
          if (op === "update") {
            calls.push({ op, filters: [...filters] });
            if (opts.updateError) return Promise.resolve({ data: null, error: { code: "23514" } });
            if (!matches()) return Promise.resolve({ data: [], error: null });
            Object.assign(row, payload);
            return Promise.resolve({ data: [{ sms_consent_at: row.sms_consent_at }], error: null });
          }
          return q;
        },
        eq(col: string, v: unknown) {
          filters.push(["eq", col, v]);
          return q;
        },
        is(col: string, v: unknown) {
          filters.push(["is", col, v]);
          return q;
        },
        maybeSingle() {
          calls.push({ op: "read", filters: [...filters] });
          if (opts.readError) return Promise.resolve({ data: null, error: { code: "57014" } });
          return Promise.resolve({
            data: matches() ? { sms_consent_at: row.sms_consent_at, sms_opted_out_at: row.sms_opted_out_at } : null,
            error: null,
          });
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

const fresh = (): Row => ({ id: "c1", sms_consent_at: null, sms_consent_source: null, sms_opted_out_at: null });
const T1 = "2026-10-12T10:00:00.000Z";
const T2 = "2026-10-12T10:00:00.400Z";

describe("stampPublicBookingConsent", () => {
  it("an unconsented client: stamped, as public_booking", async () => {
    const row = fresh();
    const { admin, calls } = fakeAdmin(row);
    expect(await stampPublicBookingConsent(admin, "c1", T1)).toEqual({ result: "stamped", smsConsentAt: T1, smsOptedOutAt: null });
    expect(row).toMatchObject({ sms_consent_at: T1, sms_consent_source: "public_booking" });
    // The write is conditional: never a re-time, never over a STOP.
    expect(calls[0].filters).toEqual([
      ["eq", "id", "c1"],
      ["is", "sms_consent_at", null],
      ["is", "sms_opted_out_at", null],
    ]);
  });

  it("THE RACE: two overlapping bookings: one stamps, the other adopts the winner's consent; nothing is re-timed", async () => {
    const row = fresh();
    const { admin } = fakeAdmin(row);
    const [a, b] = await Promise.all([
      stampPublicBookingConsent(admin, "c1", T1),
      stampPublicBookingConsent(admin, "c1", T2),
    ]);
    expect(a).toEqual({ result: "stamped", smsConsentAt: T1, smsOptedOutAt: null });
    expect(b).toEqual({ result: "already_recorded", smsConsentAt: T1, smsOptedOutAt: null });
    expect(row.sms_consent_at).toBe(T1);
  });

  it("a STOP that landed meanwhile: no consent written, and the opt-out is adopted", async () => {
    const row = { ...fresh(), sms_opted_out_at: T1 };
    const { admin } = fakeAdmin(row);
    expect(await stampPublicBookingConsent(admin, "c1", T2)).toEqual({
      result: "already_recorded",
      smsConsentAt: null,
      smsOptedOutAt: T1,
    });
    expect(row.sms_consent_at).toBeNull();
  });

  it("a database error, on the write or the re-read, is reported, never thrown", async () => {
    expect(await stampPublicBookingConsent(fakeAdmin(fresh(), { updateError: true }).admin, "c1", T1)).toEqual({
      result: "error",
      code: "23514",
    });
    const raced = { ...fresh(), sms_consent_at: T1 };
    expect(await stampPublicBookingConsent(fakeAdmin(raced, { readError: true }).admin, "c1", T2)).toEqual({
      result: "error",
      code: "57014",
    });
    expect(await stampPublicBookingConsent(fakeAdmin(fresh(), { throws: true }).admin, "c1", T1)).toEqual({
      result: "error",
      code: null,
    });
  });
});

describe("the public booking action uses it", () => {
  const src = readFileSync("app/book/[slug]/actions.ts", "utf8");
  it("stamps an existing client's consent only through stampPublicBookingConsent", () => {
    expect(src).toContain("stampPublicBookingConsent(admin, existingClient.id,");
    expect(src).not.toMatch(/sms_consent_at:\s*nowIso/);
  });
  it("adopts both the consent and the opt-out the stamp reports", () => {
    expect(src).toContain("clientSmsConsentAt = stamp.smsConsentAt;");
    expect(src).toContain("clientSmsOptedOutAt = stamp.smsOptedOutAt;");
  });
});
