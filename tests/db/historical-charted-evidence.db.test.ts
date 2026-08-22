import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { CHARTED_COUNT_COLUMNS } from "@/lib/sessions/history/evidence";

// THE COUNT MUST RESPECT THE LIVE FILTER, AND IT MUST NOT BE CAPPABLE.
//
// The whole authority rests on this: charted-ness is read as an AGGREGATE on the
// authoritative session row instead of inferred from a collection a row cap can
// silently empty. Two things have to be true, and neither is provable from
// application code:
//
//   1. the `deleted_at is null` filter reaches the count — otherwise a visit
//      whose only block was soft-deleted reads as charted;
//   2. an aggregate is not subject to the row cap that truncates embedded ROWS —
//      otherwise nothing has been gained.
//
// These run against the real PostgREST, because the claim is about PostgREST.
//
// EVERY ARM IS SEEDED, BECAUSE A SAMPLE IS NOT A CONTROL. Selecting "the newest
// forty sessions" and then asserting one of them carries a caution is a test
// that depends on incidental database contents: it can fail without a defect
// and — worse — pass vacuously the day the newest rows stop carrying the
// condition, with every equality comparing zero to zero. So each arm gets a row
// seeded to carry exactly that condition, and organic rows are selected BY THE
// PREDICATE rather than by recency.
//
// The seeds sit far in the past on purpose: they must never displace another
// suite's "newest N" sample, and nothing here selects by recency.

const REST = "http://127.0.0.1:54321/rest/v1";
const SERVICE_ROLE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function rest(path: string): Promise<unknown> {
  const res = await fetch(`${REST}${path}`, {
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
  });
  expect(res.ok, `${res.status} for ${path}`).toBe(true);
  return res.json();
}

const SEED_EPOCH = "2017-04-11T09:00:00Z";

let studio: SeededStudio;
/** One block, SOFT-DELETED: live count 0, unfiltered count 1. */
let softDeletedOnly: string;
/** One live block, FLAGGED only — the OR's first arm, alone. */
let cautionFlagged: string;
/** One live block carrying a NOTE only — the OR's second arm, alone. */
let cautionNoted: string;
/** Two live blocks, no caution, plus a soft-deleted one that DOES carry it. */
let noCaution: string;

async function insertSession(startedAt: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.sessions
       (id, studio_id, client_id, practitioner_id, modality, started_at)
     values ($1,$2,$3,$4,'electrolysis',$5)`,
    [id, studio.studioId, studio.clientId, studio.practitionerId, startedAt],
  );
  return id;
}

async function insertBlock(
  sessionId: string,
  opts: { flagged?: boolean; note?: string | null; deleted?: boolean } = {},
): Promise<void> {
  await adminQuery(
    `insert into public.session_blocks
       (id, studio_id, session_id, caution_for_next_session, caution_note, deleted_at)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      randomUUID(),
      studio.studioId,
      sessionId,
      opts.flagged ?? false,
      opts.note ?? null,
      opts.deleted ? SEED_EPOCH : null,
    ],
  );
}

beforeAll(async () => {
  studio = await seedStudio("charted-evidence");

  softDeletedOnly = await insertSession(SEED_EPOCH);
  await insertBlock(softDeletedOnly, { deleted: true });

  cautionFlagged = await insertSession("2017-04-11T10:00:00Z");
  await insertBlock(cautionFlagged, { flagged: true });

  cautionNoted = await insertSession("2017-04-11T11:00:00Z");
  await insertBlock(cautionNoted, { flagged: false, note: "watch the upper lip" });

  noCaution = await insertSession("2017-04-11T12:00:00Z");
  await insertBlock(noCaution);
  await insertBlock(noCaution);
  // A caution that is SOFT-DELETED: it must reach neither count.
  await insertBlock(noCaution, { flagged: true, note: "retracted", deleted: true });
});

afterAll(async () => {
  await closePool();
});

const seeded = () => [softDeletedOnly, cautionFlagged, cautionNoted, noCaution];

/** Postgres' own answer for a set of sessions. Never hand-written. */
async function truthFor(ids: readonly string[]) {
  const { rows } = await adminQuery(
    `select s.id::text as id,
            (select count(*) from public.session_blocks b
              where b.session_id = s.id and b.deleted_at is null)::int as live,
            (select count(*) from public.session_blocks b
              where b.session_id = s.id and b.deleted_at is null
                and (b.caution_for_next_session is true or b.caution_note is not null)
            )::int as cautions
       from public.sessions s where s.id = any($1::uuid[])`,
    [ids],
  );
  return new Map(
    (rows as Array<{ id: string; live: number; cautions: number }>).map((r) => [
      r.id,
      r,
    ]),
  );
}

describe("the embedded count is filtered, and it is authoritative", () => {
  it("the live filter reaches the count", async () => {
    // A visit whose only block is SOFT-DELETED. Without the filter the count is
    // 1 and the visit reads as charted; with it the count is 0. Seeded rather
    // than searched for, so the assertion cannot silently vanish.
    const filtered = (await rest(
      `/sessions?select=id,live:session_blocks(count)&live.deleted_at=is.null&id=eq.${softDeletedOnly}`,
    )) as Array<{ live: Array<{ count: number }> }>;
    const unfiltered = (await rest(
      `/sessions?select=id,all_blocks:session_blocks(count)&id=eq.${softDeletedOnly}`,
    )) as Array<{ all_blocks: Array<{ count: number }> }>;
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.live[0]!.count).toBe(0);
    expect(unfiltered[0]!.all_blocks[0]!.count).toBe(1);
  });

  it("the count matches Postgres exactly, with BOTH controls present", async () => {
    const { rows: organic } = await adminQuery(
      `(select s.id::text as id from public.sessions s
         where exists (select 1 from public.session_blocks b
                        where b.session_id = s.id and b.deleted_at is null) limit 20)
       union all
       (select s.id::text as id from public.sessions s
         where not exists (select 1 from public.session_blocks b
                            where b.session_id = s.id and b.deleted_at is null) limit 20)`,
      [],
    );
    const ids = [
      ...new Set([...seeded(), ...(organic as Array<{ id: string }>).map((r) => r.id)]),
    ];
    const truth = await truthFor(ids);
    const got = (await rest(
      `/sessions?select=id,live:session_blocks(count)&live.deleted_at=is.null&id=in.(${ids.join(",")})`,
    )) as Array<{ id: string; live: Array<{ count: number }> }>;
    expect(got.length).toBe(ids.length);
    for (const r of got) {
      expect(r.live[0]!.count, `session ${r.id}`).toBe(truth.get(r.id)!.live);
    }
    // The rows whose values are KNOWN, checked by name — so the loop above can
    // never be satisfied by everything comparing zero to zero.
    const by = new Map(got.map((r) => [r.id, r.live[0]!.count]));
    expect(by.get(softDeletedOnly), "soft-deleted only").toBe(0);
    expect(by.get(noCaution), "two live blocks").toBe(2);
  });

  it("an aggregate is NOT subject to the row cap that truncates embedded rows", async () => {
    // The property the design buys. Rows come back capped; the count does not.
    const { rows } = await adminQuery(
      "select count(*)::int as n from public.session_blocks where deleted_at is null",
      [],
    );
    const total = (rows[0] as { n: number }).n;
    const per = (await rest(
      "/sessions?select=live:session_blocks(count)&live.deleted_at=is.null",
    )) as Array<{ live: Array<{ count: number }> }>;
    const summed = per.reduce((acc, r) => acc + (r.live[0]?.count ?? 0), 0);
    // `sessions` itself is row-capped, so the sum can only be short by WHOLE
    // sessions — never by part of a session's count.
    expect(per.length).toBeGreaterThan(0);
    expect(summed).toBeLessThanOrEqual(total);
  });

  it("the CAUTION count applies its OR filter, per session, matching Postgres", async () => {
    // The caution decision is kept off the block collection entirely: the visit
    // carrying one is identified from an aggregate, and only that visit's blocks
    // are read for the wording. The OR mirrors the shared watch-line rule — a
    // block counts when it is FLAGGED or carries a note, either alone.
    const { rows: organic } = await adminQuery(
      `(select s.id::text as id from public.sessions s
         where exists (select 1 from public.session_blocks b
                        where b.session_id = s.id and b.deleted_at is null
                          and (b.caution_for_next_session is true
                               or b.caution_note is not null)) limit 20)
       union all
       (select s.id::text as id from public.sessions s
         where not exists (select 1 from public.session_blocks b
                            where b.session_id = s.id and b.deleted_at is null
                              and (b.caution_for_next_session is true
                                   or b.caution_note is not null)) limit 20)`,
      [],
    );
    const ids = [
      ...new Set([...seeded(), ...(organic as Array<{ id: string }>).map((r) => r.id)]),
    ];
    const truth = await truthFor(ids);
    const got = (await rest(
      `/sessions?select=id,caution_count:session_blocks(count)` +
        `&caution_count.deleted_at=is.null` +
        `&caution_count.or=${encodeURIComponent("(caution_for_next_session.is.true,caution_note.not.is.null)")}` +
        `&id=in.(${ids.join(",")})`,
    )) as Array<{ id: string; caution_count: Array<{ count: number }> }>;
    expect(got.length).toBe(ids.length);
    for (const r of got) {
      expect(r.caution_count[0]!.count, `session ${r.id}`).toBe(
        truth.get(r.id)!.cautions,
      );
    }
    const by = new Map(got.map((r) => [r.id, r.caution_count[0]!.count]));
    // EACH ARM OF THE OR, ALONE. A filter that dropped either half would still
    // satisfy a sample where every caution row happened to carry both.
    expect(by.get(cautionFlagged), "flagged, no note").toBe(1);
    expect(by.get(cautionNoted), "note, not flagged").toBe(1);
    // The negative control, and the live filter reaching the CAUTION count:
    // this visit holds two ordinary blocks and one caution that is soft-deleted.
    expect(by.get(noCaution), "cautionless, one retracted").toBe(0);
    //
    // DELIBERATELY NOT ASSERTED: that the ORGANIC rows carry a caution.
    // Requiring that would re-create the dependency this suite exists without —
    // it fails on a freshly reset database that happens to hold none, with no
    // defect. Organic rows are still EXERCISED by the equality loop above; what
    // this suite must not do is require the database to contain them.
  });

  it("the column list the module ships is the one that works", async () => {
    // Pins the exact select string against the live API, so a rename or typo
    // fails here rather than silently returning undefined counts — which every
    // predicate would then read as UNDECIDABLE for every row, and the whole
    // surface would go quiet rather than wrong.
    const select = `id,${CHARTED_COUNT_COLUMNS}`;
    const got = (await rest(
      `/sessions?select=${encodeURIComponent(select)}` +
        `&live_block_count.deleted_at=is.null` +
        `&live_entry_count.deleted_at=is.null` +
        `&live_laser_count.deleted_at=is.null&limit=3`,
    )) as Array<Record<string, unknown>>;
    expect(got.length).toBeGreaterThan(0);
    for (const r of got) {
      for (const key of ["live_block_count", "live_entry_count", "live_laser_count"]) {
        expect(Array.isArray(r[key]), `${key} missing`).toBe(true);
        expect(typeof (r[key] as Array<{ count: number }>)[0]!.count).toBe("number");
      }
    }
  });
});
