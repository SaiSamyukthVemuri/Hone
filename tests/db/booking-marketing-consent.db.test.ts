import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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
// consent=true and consent=false, referencing a REAL appointment (FK), and
// stays studio-scoped under RLS.

let a: SeededStudio;
let b: SeededStudio;

// Distinct day per appointment so two appointments never overlap (the
// no_overlapping_active_appointments_per_studio exclusion constraint, 0029).
let apptSlot = 0;
async function seedAppointment(studio: SeededStudio): Promise<string> {
  const id = randomUUID();
  const day = String(1 + apptSlot++).padStart(2, "0"); // 2030-03-01, -02, ...
  const start = `2030-03-${day}T10:00:00Z`;
  const end = `2030-03-${day}T11:00:00Z`;
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, starts_at, ends_at, duration_minutes,
        buffer_minutes_snapshot, blocked_ends_at)
     values ($1, $2, $3, $4, $5, 60, 0, $5)`,
    [id, studio.studioId, studio.clientId, start, end],
  );
  return id;
}

async function insertBuilt(studio: SeededStudio, consent: boolean) {
  const appointmentId = await seedAppointment(studio);
  const row = buildBookingMarketingConsentRow({
    studioId: studio.studioId,
    appointmentId,
    clientId: studio.clientId,
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
  await insertBuilt(a, true);
  await insertBuilt(a, false);
});

afterAll(async () => {
  await closePool();
});

describe("booking_tracking_consents: built row persists (true + false)", () => {
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
