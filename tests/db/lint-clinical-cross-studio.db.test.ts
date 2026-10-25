import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  seedMember,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// LINT-CLINICAL: cross-studio proof for the authenticated SECURITY DEFINER
// clinical commands the Supabase linter flags (OPS 20261025T0029Z, Privacy).
// ===========================================================================
//
// Every function below is SECURITY DEFINER and executable by `authenticated`,
// so it bypasses RLS and must re-establish the tenant boundary itself. For each
// one this file proves, with synthetic data only:
//
//   POSITIVE CONTROL  a member of studio A, using A's ids, succeeds AND the
//                     data snapshot changes (so a refusal below is not the
//                     harness being broken, and the snapshot is able to see a
//                     write). Run for an OWNER and for a plain PRACTITIONER.
//   CROSS-STUDIO      the same member with studio B's ids (and, where the
//                     function takes a caller-supplied studio id, both
//                     `p_studio_id = B` and `p_studio_id = A`) is refused with
//                     that function's own refusal shape, and the snapshot of
//                     BOTH studios is byte-identical afterwards: a thrown error
//                     alone proves nothing about a write that happened first.
//   NO MEMBERSHIP     an authenticated user with no practitioners row anywhere
//                     (the structural stand-in for a receptionist, who is a
//                     studio_receptionists row, never a practitioners row) is
//                     refused on A's OWN ids, with no write.
//   ANON / SERVICE    anon and service_role are refused on A's own ids.
//
// No role distinction is asserted between owner and practitioner: the product
// lets every ACTIVE practitioner chart (HON-44 shares clinical notes across
// providers), and the owner-only rules (finance, price, pinned-caution delete)
// belong to other functions.

const CHECK_VIOLATION = "23514";

type Ids = {
  studio: SeededStudio;
  sessionId: string;
  blockId: string;
  entryId: string;
  imageId: string;
  planId: string;
};

type Expect =
  | { kind: "raise"; code?: string; message?: RegExp }
  | { kind: "null" }
  | { kind: "descriptor-not-found" };

type Call = { label: string; sql: string; params: unknown[]; expect: Expect };

type Case = {
  fn: string;
  /** A succeeding call by a member of `own`'s studio, on its own ids. */
  positive: (own: Ids) => { sql: string; params: unknown[] };
  /** Refusals: `foreign` is the OTHER studio. The FIRST one is also the refusal an outsider gets. */
  refused: (own: Ids, foreign: Ids) => Call[];
  /** Read-only functions never change the snapshot; a positive control checks the result instead. */
  readOnly?: boolean;
  /** Extra check of the positive result (e.g. an id, not NULL). */
  verify?: (rows: Array<Record<string, unknown>>) => void;
};

let A: SeededStudio;
let B: SeededStudio;
let aMember: { userId: string; practitionerId: string };
let bMember: { userId: string; practitionerId: string };
let outsider: { userId: string };
let aIds: Ids;
let bIds: Ids;

async function fixture(studio: SeededStudio): Promise<Ids> {
  const { sessionId, blockId } = await seedSession(studio);
  const entry = await adminQuery(
    `insert into public.electrolysis_entries (session_id, block_id, area, mode)
     values ($1,$2,'x','thermo') returning id`,
    [sessionId, blockId],
  );
  const imageId = randomUUID();
  await adminQuery(
    `insert into public.treatment_images (id, studio_id, client_id, storage_path, content_type, size_bytes)
     values ($1,$2,$3,$4,'image/png',10)`,
    [imageId, studio.studioId, studio.clientId, `${studio.studioId}/${studio.clientId}/${imageId}.png`],
  );
  const plan = await adminQuery(
    `insert into public.treatment_plans (studio_id, client_id, status, name)
     values ($1,$2,'active','synthetic plan') returning id`,
    [studio.studioId, studio.clientId],
  );
  return {
    studio,
    sessionId,
    blockId,
    entryId: entry.rows[0].id as string,
    imageId,
    planId: plan.rows[0].id as string,
  };
}

/** One hash over every row the clinical commands can touch, for both studios. */
async function snapshot(): Promise<string> {
  const r = await adminQuery(
    `with s as (select id from public.sessions where studio_id = any($1::uuid[]))
     select md5(coalesce(string_agg(t, '|' order by t), '')) as h from (
       select 'S:' || x::text as t from public.sessions x where x.studio_id = any($1::uuid[])
       union all select 'B:' || x::text from public.session_blocks x where x.studio_id = any($1::uuid[])
       union all select 'A:' || x::text from public.session_block_areas x where x.studio_id = any($1::uuid[])
       union all select 'E:' || x::text from public.electrolysis_entries x where x.session_id in (select id from s)
       union all select 'L:' || x::text from public.laser_entries x where x.session_id in (select id from s)
       union all select 'U:' || x::text from public.session_audit x where x.session_id in (select id from s)
       union all select 'I:' || x::text from public.treatment_images x where x.studio_id = any($1::uuid[])
       union all select 'P:' || x::text from public.treatment_plans x where x.studio_id = any($1::uuid[])
       union all select 'C:' || x::text from public.clients x where x.studio_id = any($1::uuid[])
     ) q`,
    [[A.studioId, B.studioId]],
  );
  return r.rows[0].h as string;
}

type Outcome =
  | { threw: { code?: string; message: string } }
  | { rows: Array<Record<string, unknown>> };

async function attempt(userId: string, sql: string, params: unknown[]): Promise<Outcome> {
  try {
    const r = await asUser(userId, (q) => q(sql, params));
    return { rows: r.rows as Array<Record<string, unknown>> };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { threw: { code: err.code, message: String(err.message ?? "") } };
  }
}

const firstValue = (rows: Array<Record<string, unknown>>) =>
  rows.length === 0 ? null : (Object.values(rows[0])[0] ?? null);

function assertRefusal(label: string, outcome: Outcome, expected: Expect) {
  if (expected.kind === "raise") {
    expect("threw" in outcome, `${label}: must be refused, got ${JSON.stringify(outcome)}`).toBe(true);
    if ("threw" in outcome) {
      if (expected.code) expect(outcome.threw.code, `${label}: ${outcome.threw.message}`).toBe(expected.code);
      if (expected.message) expect(outcome.threw.message, label).toMatch(expected.message);
    }
  } else if (expected.kind === "null") {
    expect("rows" in outcome, `${label}: must return NULL, not raise: ${JSON.stringify(outcome)}`).toBe(true);
    if ("rows" in outcome) expect(firstValue(outcome.rows), label).toBeNull();
  } else {
    expect("rows" in outcome, `${label}: ${JSON.stringify(outcome)}`).toBe(true);
    if ("rows" in outcome) {
      const d = firstValue(outcome.rows) as { eligible?: boolean; reason?: string } | null;
      expect(d, label).toMatchObject({ eligible: false, reason: "target" });
    }
  }
}

beforeAll(async () => {
  A = await seedStudio("lintclin-a");
  B = await seedStudio("lintclin-b");
  aMember = await seedMember(A, "lintclin-a-pract");
  bMember = await seedMember(B, "lintclin-b-pract");
  const u = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [u, `lintclin-none-${u.slice(0, 8)}@harness.local`]);
  outsider = { userId: u };
  aIds = await fixture(A);
  bIds = await fixture(B);
  expect(bMember.userId).not.toBe(aMember.userId);
});
afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
// Argument shapes (copied from the existing per-migration tests, so the
// positive controls are valid calls).
// ---------------------------------------------------------------------------

const J = (v: unknown) => JSON.stringify(v);
const REASON = "synthetic removal reason";

const CREATE_BLOCK_SQL = `select * from public.create_block_with_entry(
  $1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,$15::jsonb,
  $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`;
const createBlockParams = (session: string, client: string) => [
  session, client, J({ block_name: "Main", mode: "thermo" }), J({}), J([]), true, "chin", ["chin"],
  null, null, "thermo", 1, null, null, J([]), null, null, null, null, null, null, null, null, null, null, null,
];

const PASS_SQL = `select * from public.add_electrolysis_pass(
  $1,$2,$3,$4::jsonb,$5,$6::text[],$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,
  $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`;
const passParams = (session: string, client: string, block: string) => [
  session, client, block, J({ block_name: "Main" }), "jaw", ["jaw"], null, null, "thermo", null, null, 1, null, null,
  J([]), null, null, null, null, null, null, null, null, null, null, null,
];

const UPDATE_SQL = `select * from public.update_block_with_entry(
  $1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11::text[],$12,$13,$14,$15,$16,$17,$18::jsonb,
  $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`;
const updateParams = (session: string, client: string, block: string, withEntry: boolean, entry: string | null, extra: unknown) => [
  session, client, block, J({}), J(extra), J([]), null, withEntry, entry, withEntry ? "x" : null,
  withEntry ? ["x"] : null, null, null, withEntry ? "thermo" : null, withEntry ? 1 : null, null, null,
  J([]), null, null, null, null, null, null, null, null, null, null, null,
];

const AREAS = J([{ area: "Cheeks", laterality: "left" }]);
const newId = () => randomUUID();

const CASES: Case[] = [
  {
    fn: "create_treatment_image_metadata",
    positive: (o) => {
      const id = newId();
      return {
        sql: "select * from public.create_treatment_image_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        params: [id, o.studio.clientId, null, null, "treatment-images", `${o.studio.studioId}/${o.studio.clientId}/${id}.jpg`, "photo.jpg", "image/jpeg", 10],
      };
    },
    refused: (o, f) => {
      const sql = "select * from public.create_treatment_image_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)";
      const idB = newId();
      const idC = newId();
      return [
        { label: "B's client", sql, params: [idB, f.studio.clientId, null, null, "treatment-images", `${f.studio.studioId}/${f.studio.clientId}/${idB}.jpg`, "photo.jpg", "image/jpeg", 10], expect: { kind: "raise", code: CHECK_VIOLATION } },
        { label: "A's client with B's session", sql, params: [idC, o.studio.clientId, f.sessionId, null, "treatment-images", `${o.studio.studioId}/${o.studio.clientId}/${idC}.jpg`, "photo.jpg", "image/jpeg", 10], expect: { kind: "raise", code: CHECK_VIOLATION } },
      ];
    },
  },
  {
    fn: "archive_treatment_image",
    verify: (rows) => expect(firstValue(rows), "the NULL-shaped refusal must be distinguishable from success").not.toBeNull(),
    positive: (o) => ({ sql: "select * from public.archive_treatment_image($1,$2)", params: [o.imageId, o.studio.clientId] }),
    refused: (_o, f) => [{ label: "B's image", sql: "select * from public.archive_treatment_image($1,$2)", params: [f.imageId, f.studio.clientId], expect: { kind: "null" } }],
  },
  {
    fn: "set_treatment_image_note",
    verify: (rows) => expect(firstValue(rows), "the NULL-shaped refusal must be distinguishable from success").not.toBeNull(),
    positive: (o) => ({ sql: "select * from public.set_treatment_image_note($1,$2,$3)", params: [o.imageId, o.studio.clientId, "synthetic note"] }),
    refused: (_o, f) => [{ label: "B's image", sql: "select * from public.set_treatment_image_note($1,$2,$3)", params: [f.imageId, f.studio.clientId, "forged note"], expect: { kind: "null" } }],
  },
  {
    fn: "create_laser_entry",
    positive: (o) => ({ sql: "select * from public.create_laser_entry($1,$2,$3,$4,$5::jsonb,$6)", params: [o.sessionId, o.studio.clientId, "Chin", 1, J({ watts: 1 }), "synthetic"] }),
    refused: (_o, f) => [{ label: "B's session", sql: "select * from public.create_laser_entry($1,$2,$3,$4,$5::jsonb,$6)", params: [f.sessionId, f.studio.clientId, "Chin", 1, J({}), "forged"], expect: { kind: "raise", code: CHECK_VIOLATION } }],
  },
  {
    fn: "add_electrolysis_pass",
    positive: (o) => ({ sql: PASS_SQL, params: passParams(o.sessionId, o.studio.clientId, o.blockId) }),
    refused: (o, f) => [
      { label: "B's session", sql: PASS_SQL, params: passParams(f.sessionId, f.studio.clientId, f.blockId), expect: { kind: "raise", code: CHECK_VIOLATION } },
      { label: "A's session with B's block", sql: PASS_SQL, params: passParams(o.sessionId, o.studio.clientId, f.blockId), expect: { kind: "raise", code: CHECK_VIOLATION } },
    ],
  },
  {
    fn: "create_block_with_entry",
    positive: (o) => ({ sql: CREATE_BLOCK_SQL, params: createBlockParams(o.sessionId, o.studio.clientId) }),
    refused: (_o, f) => [{ label: "B's session", sql: CREATE_BLOCK_SQL, params: createBlockParams(f.sessionId, f.studio.clientId), expect: { kind: "raise", code: CHECK_VIOLATION } }],
  },
  {
    fn: "update_block_with_entry",
    positive: (o) => ({ sql: UPDATE_SQL, params: updateParams(o.sessionId, o.studio.clientId, o.blockId, false, null, { block_name: "Edited" }) }),
    refused: (o, f) => [
      { label: "B's session and block", sql: UPDATE_SQL, params: updateParams(f.sessionId, f.studio.clientId, f.blockId, false, null, { block_name: "Forged" }), expect: { kind: "raise", code: CHECK_VIOLATION } },
      { label: "A's session with B's block", sql: UPDATE_SQL, params: updateParams(o.sessionId, o.studio.clientId, f.blockId, false, null, { block_name: "Forged" }), expect: { kind: "raise", code: CHECK_VIOLATION } },
      { label: "A's block with B's entry", sql: UPDATE_SQL, params: updateParams(o.sessionId, o.studio.clientId, o.blockId, true, f.entryId, {}), expect: { kind: "raise", code: CHECK_VIOLATION } },
    ],
  },
  {
    fn: "create_session_block_with_areas",
    positive: (o) => ({ sql: "select * from public.create_session_block_with_areas($1,$2,$3::jsonb,$4::jsonb)", params: [o.studio.studioId, o.sessionId, J({ primary_area: "Cheeks", side: "left" }), AREAS] }),
    refused: (o, f) => {
      const sql = "select * from public.create_session_block_with_areas($1,$2,$3::jsonb,$4::jsonb)";
      return [
        { label: "p_studio_id = B with B's session", sql, params: [f.studio.studioId, f.sessionId, J({}), AREAS], expect: { kind: "raise", message: /not authorized for studio/ } },
        { label: "p_studio_id = A with B's session", sql, params: [o.studio.studioId, f.sessionId, J({}), AREAS], expect: { kind: "raise", message: /not found in studio/ } },
      ];
    },
  },
  {
    fn: "update_session_block_with_areas",
    positive: (o) => ({ sql: "select * from public.update_session_block_with_areas($1,$2,$3,$4::jsonb,$5::jsonb)", params: [o.studio.studioId, o.sessionId, o.blockId, J({ primary_area: "Chin" }), AREAS] }),
    refused: (o, f) => {
      const sql = "select * from public.update_session_block_with_areas($1,$2,$3,$4::jsonb,$5::jsonb)";
      return [
        { label: "p_studio_id = B with B's session and block", sql, params: [f.studio.studioId, f.sessionId, f.blockId, J({ primary_area: "Forged" }), AREAS], expect: { kind: "raise", message: /not authorized for studio/ } },
        { label: "p_studio_id = A with B's session and block", sql, params: [o.studio.studioId, f.sessionId, f.blockId, J({ primary_area: "Forged" }), AREAS], expect: { kind: "raise", message: /not found in studio/ } },
        { label: "p_studio_id = A, A's session, B's block", sql, params: [o.studio.studioId, o.sessionId, f.blockId, J({ primary_area: "Forged" }), AREAS], expect: { kind: "raise", message: /not found in studio/ } },
      ];
    },
  },
  {
    fn: "soft_delete_session",
    positive: (o) => ({ sql: "select * from public.soft_delete_session($1,$2,$3)", params: [o.sessionId, o.studio.clientId, REASON] }),
    refused: (_o, f) => [{ label: "B's session", sql: "select * from public.soft_delete_session($1,$2,$3)", params: [f.sessionId, f.studio.clientId, REASON], expect: { kind: "raise", code: CHECK_VIOLATION } }],
  },
  {
    fn: "soft_delete_session_block",
    positive: (o) => ({ sql: "select * from public.soft_delete_session_block($1,$2,$3,$4)", params: [o.sessionId, o.studio.clientId, o.blockId, REASON] }),
    refused: (o, f) => [
      { label: "B's session and block", sql: "select * from public.soft_delete_session_block($1,$2,$3,$4)", params: [f.sessionId, f.studio.clientId, f.blockId, REASON], expect: { kind: "raise", code: CHECK_VIOLATION } },
      { label: "A's session with B's block", sql: "select * from public.soft_delete_session_block($1,$2,$3,$4)", params: [o.sessionId, o.studio.clientId, f.blockId, REASON], expect: { kind: "raise", code: CHECK_VIOLATION } },
    ],
  },
  {
    fn: "soft_delete_session_area",
    positive: (o) => ({ sql: "select * from public.soft_delete_session_area($1,$2,$3)", params: [o.sessionId, o.blockId, REASON] }),
    refused: (o, f) => [
      { label: "B's session and block", sql: "select * from public.soft_delete_session_area($1,$2,$3)", params: [f.sessionId, f.blockId, REASON], expect: { kind: "raise", code: CHECK_VIOLATION } },
      { label: "A's session with B's block", sql: "select * from public.soft_delete_session_area($1,$2,$3)", params: [o.sessionId, f.blockId, REASON], expect: { kind: "raise", code: CHECK_VIOLATION } },
    ],
  },
  {
    // 4-argument overload: the studio is DERIVED from the client.
    fn: "start_session(4)",
    positive: (o) => ({ sql: "select * from public.start_session($1,'electrolysis',null,0)", params: [o.studio.clientId] }),
    refused: (_o, f) => [{ label: "B's client", sql: "select * from public.start_session($1,'electrolysis',null,0)", params: [f.studio.clientId], expect: { kind: "raise", code: CHECK_VIOLATION } }],
  },
  {
    // 5-argument overload: the studio is CALLER-SUPPLIED.
    fn: "start_session(5)",
    positive: (o) => ({ sql: "select * from public.start_session($1,'electrolysis',null,0,$2)", params: [o.studio.clientId, o.studio.studioId] }),
    refused: (o, f) => [
      { label: "p_studio_id = B with B's client", sql: "select * from public.start_session($1,'electrolysis',null,0,$2)", params: [f.studio.clientId, f.studio.studioId], expect: { kind: "raise", code: CHECK_VIOLATION } },
      { label: "p_studio_id = A with B's client", sql: "select * from public.start_session($1,'electrolysis',null,0,$2)", params: [f.studio.clientId, o.studio.studioId], expect: { kind: "raise", code: CHECK_VIOLATION } },
    ],
  },
  {
    fn: "edit_session_started_at",
    positive: (o) => ({ sql: "select * from public.edit_session_started_at($1,$2,$3)", params: [o.sessionId, o.studio.clientId, new Date(Date.now() - 3_600_000).toISOString()] }),
    refused: (_o, f) => [{ label: "B's session", sql: "select * from public.edit_session_started_at($1,$2,$3)", params: [f.sessionId, f.studio.clientId, new Date(Date.now() - 7_200_000).toISOString()], expect: { kind: "raise", code: CHECK_VIOLATION } }],
  },
  {
    fn: "set_session_performer",
    positive: (o) => ({ sql: "select * from public.set_session_performer($1,$2,$3)", params: [o.sessionId, o.studio.clientId, o.studio.practitionerId] }),
    refused: (o, f) => [
      { label: "B's session", sql: "select * from public.set_session_performer($1,$2,$3)", params: [f.sessionId, f.studio.clientId, f.studio.practitionerId], expect: { kind: "raise", code: CHECK_VIOLATION } },
      { label: "A's session with B's practitioner", sql: "select * from public.set_session_performer($1,$2,$3)", params: [o.sessionId, o.studio.clientId, f.studio.practitionerId], expect: { kind: "raise", code: CHECK_VIOLATION } },
    ],
  },
  {
    fn: "set_session_treatment_plan",
    positive: (o) => ({ sql: "select * from public.set_session_treatment_plan($1,$2,$3)", params: [o.sessionId, o.studio.clientId, o.planId] }),
    refused: (o, f) => [
      { label: "B's session and plan", sql: "select * from public.set_session_treatment_plan($1,$2,$3)", params: [f.sessionId, f.studio.clientId, f.planId], expect: { kind: "raise", code: CHECK_VIOLATION } },
      { label: "A's session with B's plan", sql: "select * from public.set_session_treatment_plan($1,$2,$3)", params: [o.sessionId, o.studio.clientId, f.planId], expect: { kind: "raise", code: CHECK_VIOLATION } },
    ],
  },
  {
    fn: "set_session_aftercare_explained",
    positive: (o) => ({ sql: "select * from public.set_session_aftercare_explained($1,$2)", params: [o.sessionId, true] }),
    refused: (_o, f) => [{ label: "B's session", sql: "select * from public.set_session_aftercare_explained($1,$2)", params: [f.sessionId, true], expect: { kind: "raise", code: CHECK_VIOLATION } }],
  },
  {
    fn: "set_next_session_note",
    positive: (o) => ({ sql: "select * from public.set_next_session_note($1,$2,$3)", params: [o.sessionId, o.studio.clientId, "synthetic next-session note"] }),
    refused: (_o, f) => [{ label: "B's session", sql: "select * from public.set_next_session_note($1,$2,$3)", params: [f.sessionId, f.studio.clientId, "forged"], expect: { kind: "raise", code: CHECK_VIOLATION } }],
  },
  {
    fn: "whole_session_copy_source_descriptor",
    readOnly: true,
    positive: (o) => ({ sql: "select * from public.whole_session_copy_source_descriptor($1,$2)", params: [o.studio.studioId, DESCRIPTOR_TARGET.get(o.studio.studioId)] }),
    verify: (rows) => expect(firstValue(rows)).toMatchObject({ eligible: true }),
    refused: (o, f) => [
      { label: "p_studio_id = B with B's target", sql: "select * from public.whole_session_copy_source_descriptor($1,$2)", params: [f.studio.studioId, DESCRIPTOR_TARGET.get(f.studio.studioId)], expect: { kind: "raise", message: /not authorized/ } },
      { label: "p_studio_id = A with B's target", sql: "select * from public.whole_session_copy_source_descriptor($1,$2)", params: [o.studio.studioId, DESCRIPTOR_TARGET.get(f.studio.studioId)], expect: { kind: "descriptor-not-found" } },
    ],
  },
];

/** studio id -> an EMPTY draft electrolysis target session that has an eligible earlier source. */
const DESCRIPTOR_TARGET = new Map<string, string>();

async function descriptorTarget(studio: SeededStudio): Promise<string> {
  const source = newId();
  const target = newId();
  await adminQuery(
    `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality, started_at)
     values ($1,$2,$3,$4,'electrolysis', now() - interval '2 days')`,
    [source, studio.studioId, studio.clientId, studio.practitionerId],
  );
  await adminQuery(
    `insert into public.session_blocks (id, studio_id, session_id, mode, primary_area)
     values ($1,$2,$3,'thermo','Chin')`,
    [newId(), studio.studioId, source],
  );
  await adminQuery(
    `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality)
     values ($1,$2,$3,$4,'electrolysis')`,
    [target, studio.studioId, studio.clientId, studio.practitionerId],
  );
  return target;
}

beforeAll(async () => {
  DESCRIPTOR_TARGET.set(A.studioId, await descriptorTarget(A));
  DESCRIPTOR_TARGET.set(B.studioId, await descriptorTarget(B));
});

// ---------------------------------------------------------------------------

describe("LINT-CLINICAL: the harness can see a write (non-vacuity of every refusal below)", () => {
  it("the snapshot changes when studio A's data changes and not otherwise", async () => {
    const before = await snapshot();
    expect(await snapshot()).toBe(before);
    await adminQuery(`update public.sessions set next_session_note = 'probe' where id = $1`, [aIds.sessionId]);
    expect(await snapshot()).not.toBe(before);
    await adminQuery(`update public.sessions set next_session_note = null where id = $1`, [aIds.sessionId]);
  });
});

describe.each(CASES)("LINT-CLINICAL $fn", (c) => {
  it.each([
    ["owner", () => A.userId],
    ["practitioner", () => aMember.userId],
  ])("POSITIVE CONTROL: an active %s of studio A succeeds on A's own ids and the data changes", async (_role, who) => {
    const own = await fixture(A);
    const before = await snapshot();
    const call = c.positive(own);
    const out = await attempt(who(), call.sql, call.params);
    expect("rows" in out, `positive control must succeed: ${JSON.stringify(out)}`).toBe(true);
    if (!("rows" in out)) return;
    // void-returning commands answer with one row holding an empty value, so
    // "a row came back" is the portable success signal; the NULL-returning
    // refusal shapes (image archive/note) additionally must return an id.
    expect(out.rows.length, "a positive control must return a row").toBeGreaterThanOrEqual(1);
    if (c.verify) c.verify(out.rows);
    if (!c.readOnly) expect(await snapshot(), "the positive control must write").not.toBe(before);
  });

  it.each([
    ["owner", () => A.userId],
    ["practitioner", () => aMember.userId],
  ])("CROSS-STUDIO: a %s of A using B's ids is refused with this function's own shape and NOTHING changes in either studio", async (_role, who) => {
    const calls = c.refused(aIds, bIds);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const before = await snapshot();
      const out = await attempt(who(), call.sql, call.params);
      assertRefusal(`${c.fn}: ${call.label}`, out, call.expect);
      expect(await snapshot(), `${c.fn}: ${call.label} changed data`).toBe(before);
    }
  });

  it("NO MEMBERSHIP (the receptionist stand-in): a user with no practitioners row is refused on A's OWN ids, with no write", async () => {
    const first = c.refused(aIds, bIds)[0];
    const own = c.positive(await fixture(A));
    const before = await snapshot();
    const out = await attempt(outsider.userId, own.sql, own.params);
    assertRefusal(`${c.fn}: outsider`, out, first.expect);
    expect(await snapshot(), `${c.fn}: outsider changed data`).toBe(before);
  });

  it.each([["anon" as const], ["service_role" as const]])("%s is refused on A's own ids", async (role) => {
    const own = c.positive(await fixture(A));
    const before = await snapshot();
    let threw: string | null = null;
    try {
      await asRole(role, (q) => q(own.sql, own.params));
    } catch (e) {
      threw = String((e as { message?: string }).message ?? e);
    }
    expect(threw, `${c.fn}: ${role} must be refused`).not.toBeNull();
    expect(await snapshot(), `${c.fn}: ${role} changed data`).toBe(before);
  });
});

describe("LINT-CLINICAL: B's data is also protected from B's own members' mistakes in A (symmetry)", () => {
  it("a member of B calling A's ids is refused and nothing changes", async () => {
    for (const c of CASES) {
      const calls = c.refused(bIds, aIds);
      const before = await snapshot();
      const out = await attempt(bMember.userId, calls[0].sql, calls[0].params);
      assertRefusal(`${c.fn}: B member on A ids`, out, calls[0].expect);
      expect(await snapshot(), `${c.fn}: B member changed data`).toBe(before);
    }
  });
});
