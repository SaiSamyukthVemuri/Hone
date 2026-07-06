import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { buildBookingMarketingConsentRow } from "@/lib/booking/marketing-consent";

// Proves the row the booking action builds (buildBookingMarketingConsentRow)
// actually persists into booking_tracking_consents (migration 0106), for both
// consent=true and consent=false, and stays studio-scoped under RLS.

let a: SeededStudio;
let b: SeededStudio;

async function insertBuilt(studioId: string, consent: boolean, apptId: string) {
  const row = buildBookingMarketingConsentRow({
    studioId,
    appointmentId: apptId,
    clientId: null,
    consent,
  });
  await adminQuery(
    `insert into public.booking_tracking_consents
       (studio_id, appointment_id, client_id, marketing_analytics_consent, consent_text_version, consent_source)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      row.studio_id,
      row.appointment_id,
      row.client_id,
      row.marketing_analytics_consent,
      row.consent_text_version,
      row.consent_source,
    ],
  );
}

beforeAll(async () => {
  a = await seedStudio("bmc-a");
  b = await seedStudio("bmc-b");
  await insertBuilt(a.studioId, true, "11111111-1111-1111-1111-111111111111");
  await insertBuilt(a.studioId, false, "22222222-2222-2222-2222-222222222222");
});

afterAll(async () => {
  await closePool();
});

describe("booking_tracking_consents — built row persists (true + false)", () => {
  it("stores consent=true and consent=false with the fixed version + source", async () => {
    const { rows } = await adminQuery(
      `select marketing_analytics_consent, consent_text_version, consent_source
       from public.booking_tracking_consents
       where studio_id = $1 order by marketing_analytics_consent desc`,
      [a.studioId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].marketing_analytics_consent).toBe(true);
    expect(rows[1].marketing_analytics_consent).toBe(false);
    for (const r of rows) {
      expect(r.consent_text_version).toBe("marketing_analytics_v1");
      expect(r.consent_source).toBe("public_booking");
    }
  });

  it("is studio-scoped: another studio sees none of studio A's consent (RLS)", async () => {
    const res = await asUser(b.userId, (q) =>
      q(`select * from public.booking_tracking_consents where studio_id = $1`, [a.studioId]),
    );
    expect(res.rowCount).toBe(0);
  });

  it("the table exposes only consent bookkeeping columns (no email/phone/clinical)", async () => {
    const { rows } = await adminQuery(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='booking_tracking_consents'`,
    );
    const cols = rows.map((r) => r.column_name);
    for (const forbidden of ["email", "phone", "name", "notes", "intake", "contraindication", "body_area", "photo"]) {
      expect(cols.some((c: string) => c.includes(forbidden))).toBe(false);
    }
  });
});
