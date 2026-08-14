import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// Exercises migration 0106 against the REAL migrated DB: RLS studio isolation,
// the uniqueness/dedup constraints, and the claim_conversion_delivery RPC.
// (No tracking is enabled and nothing is sent, this is schema-only.)

let a: SeededStudio;
let b: SeededStudio;

beforeAll(async () => {
  a = await seedStudio("mkt-a");
  b = await seedStudio("mkt-b");
  // Studio A configures a Meta provider (admin/service-role write).
  await adminQuery(
    `insert into public.studio_tracking_providers
       (studio_id, provider, enabled, browser_tag_id, server_token_secret_ref)
     values ($1, 'meta', true, 'PX_A', 'META_CAPI_TOKEN')`,
    [a.studioId],
  );
});

afterAll(async () => {
  await closePool();
});

describe("studio_tracking_providers: RLS isolation + uniqueness", () => {
  it("a studio member sees their own provider config", async () => {
    const res = await asUser(a.userId, (q) =>
      q(`select provider, enabled from public.studio_tracking_providers where studio_id = $1`, [a.studioId]),
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].provider).toBe("meta");
  });

  it("another studio CANNOT read studio A's provider config (RLS)", async () => {
    const res = await asUser(b.userId, (q) =>
      q(`select * from public.studio_tracking_providers where studio_id = $1`, [a.studioId]),
    );
    expect(res.rowCount).toBe(0);
  });

  it("another studio CANNOT insert config for studio A (RLS with check)", async () => {
    await expect(
      asUser(b.userId, (q) =>
        q(`insert into public.studio_tracking_providers (studio_id, provider) values ($1, 'ga4')`, [a.studioId]),
      ),
    ).rejects.toThrow();
  });

  it("unique(studio_id, provider) blocks a duplicate provider row", async () => {
    await expect(
      adminQuery(`insert into public.studio_tracking_providers (studio_id, provider) values ($1, 'meta')`, [a.studioId]),
    ).rejects.toThrow();
  });

  it("provider + consent_mode checks reject bad values", async () => {
    await expect(
      adminQuery(`insert into public.studio_tracking_providers (studio_id, provider) values ($1, 'facebook')`, [b.studioId]),
    ).rejects.toThrow();
    await expect(
      adminQuery(`insert into public.studio_tracking_providers (studio_id, provider, consent_mode) values ($1, 'meta', 'none')`, [b.studioId]),
    ).rejects.toThrow();
  });
});

describe("conversion_event_deliveries: dedup + claim RPC + RLS", () => {
  it("claim_conversion_delivery returns true once, then false (deterministic dedup)", async () => {
    const first = await adminQuery(
      `select public.claim_conversion_delivery($1, 'meta', 'booking_confirmed', 'hone_booking_evt1') as won`,
      [a.studioId],
    );
    expect(first.rows[0].won).toBe(true);
    const second = await adminQuery(
      `select public.claim_conversion_delivery($1, 'meta', 'booking_confirmed', 'hone_booking_evt1') as won`,
      [a.studioId],
    );
    expect(second.rows[0].won).toBe(false);
  });

  it("unique(studio_id, provider, event_id) blocks a duplicate delivery row", async () => {
    await expect(
      adminQuery(
        `insert into public.conversion_event_deliveries (studio_id, provider, internal_event_name, event_id, status)
         values ($1, 'meta', 'booking_confirmed', 'hone_booking_evt1', 'sent')`,
        [a.studioId],
      ),
    ).rejects.toThrow();
  });

  it("status check rejects an unknown status", async () => {
    await expect(
      adminQuery(
        `insert into public.conversion_event_deliveries (studio_id, provider, internal_event_name, event_id, status)
         values ($1, 'meta', 'booking_confirmed', 'evt_bad', 'delivered')`,
        [a.studioId],
      ),
    ).rejects.toThrow();
  });

  it("another studio cannot read studio A's deliveries (RLS)", async () => {
    const res = await asUser(b.userId, (q) =>
      q(`select * from public.conversion_event_deliveries where studio_id = $1`, [a.studioId]),
    );
    expect(res.rowCount).toBe(0);
  });
});

describe("booking_tracking_consents: studio-scoped", () => {
  beforeAll(async () => {
    await adminQuery(
      `insert into public.booking_tracking_consents
         (studio_id, marketing_analytics_consent, consent_text_version, consent_source)
       values ($1, true, 'v1', 'public_booking')`,
      [a.studioId],
    );
  });

  it("consent_source check rejects an unknown source", async () => {
    await expect(
      adminQuery(
        `insert into public.booking_tracking_consents (studio_id, marketing_analytics_consent, consent_text_version, consent_source)
         values ($1, true, 'v1', 'random_site')`,
        [b.studioId],
      ),
    ).rejects.toThrow();
  });

  it("a studio member sees only their own consent rows; another studio sees none", async () => {
    const own = await asUser(a.userId, (q) =>
      q(`select marketing_analytics_consent from public.booking_tracking_consents where studio_id = $1`, [a.studioId]),
    );
    expect(own.rowCount).toBe(1);
    const cross = await asUser(b.userId, (q) =>
      q(`select * from public.booking_tracking_consents where studio_id = $1`, [a.studioId]),
    );
    expect(cross.rowCount).toBe(0);
  });
});
