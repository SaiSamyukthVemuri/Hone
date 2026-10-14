import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL } from "@/e2e/helpers/local-env";
import { adminQuery, closePool, seedStudio } from "@/tests/db/helpers/harness";
import { lookupPhoneWideSuppression } from "@/lib/sms/phone-suppression-lookup";
import { readClientSuppressionCandidates } from "@/lib/sms/suppression-candidates";

// ===========================================================================
// THE PHONE-WIDE STOP READ, PAST A REAL POSTGREST ROW LIMIT
// (Codex P1 4234615485)
// ===========================================================================
//
// The local stack's PostgREST runs with max_rows = 1000, as every Hone stack
// does (supabase/config.toml). A single read of more rows answers 200 with the
// first 1,000 and NO error, so a STOP outside that window reads as "not opted
// out". This seeds 1,050 opted-out clients and proves, against the real API:
// - the premise: one read is silently capped at 1,000;
// - the complete reader returns every row;
// - the lookup finds a STOP the capped window left out.
// The unit tests (tests/lib/sms/phone-suppression-lookup.test.ts) cover the
// failure paths. Seeded rows are removed afterwards.

// supabase-js requires a global WebSocket at construction; Node 20 has none and
// this test opens no realtime channel (the same stub other DB tests use).
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const SEEDED = 1050;
const ROW_LIMIT = 1000;
let studioId = "";
let outsideWindow = "";

const service = () => createClient(E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

beforeAll(async () => {
  ({ studioId } = await seedStudio("stop-read-row-limit"));
  // A fictional prefix no other test uses: +1 999 555 0001 … 1050.
  await adminQuery(
    `insert into public.clients (studio_id, name, phone, sms_opted_out_at)
     select $1, 'Row limit ' || i, '+1999555' || lpad(i::text, 4, '0'), now()
       from generate_series(1, ${SEEDED}) as i`,
    [studioId],
  );
});

afterAll(async () => {
  await adminQuery(`delete from public.clients where studio_id = $1`, [studioId]);
  await closePool();
});

describe("phone-wide STOP read past the API's row limit", () => {
  it("premise: one read of more than 1,000 opted-out rows answers 200 with exactly 1,000, and no error", async () => {
    const { data, error } = await service()
      .from("clients")
      .select("id, phone")
      .not("phone", "is", null)
      .not("sms_opted_out_at", "is", null);
    expect(error).toBeNull();
    expect(data).toHaveLength(ROW_LIMIT);
    const returned = new Set((data ?? []).map((r) => r.phone as string));
    const seeded = (
      await adminQuery(`select phone from public.clients where studio_id = $1 and sms_opted_out_at is not null`, [studioId])
    ).rows.map((r) => r.phone as string);
    expect(seeded).toHaveLength(SEEDED);
    outsideWindow = seeded.find((phone) => !returned.has(phone)) ?? "";
    expect(outsideWindow, "a seeded STOP number outside the capped window").not.toBe("");
  });

  it("the complete reader returns every opted-out row, past the limit", async () => {
    const read = await readClientSuppressionCandidates(service(), { optedOutOnly: true });
    expect(read.ok).toBe(true);
    const phones = new Set(read.ok ? read.candidates.map((c) => c.phone) : []);
    const seeded = (await adminQuery(`select phone from public.clients where studio_id = $1`, [studioId])).rows
      .map((r) => r.phone as string | null)
      .filter((p): p is string => p !== null);
    expect(seeded.every((phone) => phones.has(phone))).toBe(true);
  });

  it("the lookup finds the STOP the capped window left out", async () => {
    expect(outsideWindow).not.toBe("");
    expect(await lookupPhoneWideSuppression(service(), outsideWindow)).toEqual({ ok: true, suppressed: true });
  });
});
