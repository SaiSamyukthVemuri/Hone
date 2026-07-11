import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  closePool,
  seedSession,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// Amendment path — PostgREST NAMED-ARGUMENT invocation shape (migration 0120).
//
// Why this file exists SEPARATELY from clinical-corrections.db.test.ts:
// that suite calls the RPC with POSITIONAL notation —
//   select * from public.amend_finalized_session($1,$2,$3,$4,$5,$6::jsonb)
// but the browser path does NOT. The server action calls
//   supabase.rpc("amend_finalized_session", { p_session_id, ..., p_structured_addition: null })
// which PostgREST compiles to NAMED-argument notation —
//   select * from public.amend_finalized_session(p_session_id => $1, ...)
// against the `authenticated` role. Named-arg resolution is a DISTINCT code
// path: it fails (function-does-not-exist / ambiguous-overload, surfaced by
// PostgREST as PGRST202/404) if any argument NAME drifts from the deployed
// signature or a second overload makes the call ambiguous — a failure the
// positional test cannot catch. This suite exercises exactly that shape, as
// the authenticated practitioner, against the real migrated function.
//
// Scope note: this runs through Postgres named-arg resolution + the
// `authenticated` EXECUTE grant + RLS (the layer where the prior silent
// failure would live). It does not traverse the HTTP/Kong hop; the browser
// leg is covered by e2e/clinical-amendment.spec.ts.
// ===========================================================================

afterAll(async () => {
  await closePool();
});

async function seedFinalized(): Promise<{
  studio: SeededStudio;
  sessionId: string;
  snapV1: string;
}> {
  const studio = await seedStudio("amend-named");
  await adminQuery(
    "update public.studios set clinical_finalization_enabled=true, clinical_corrections_enabled=true where id=$1",
    [studio.studioId],
  );
  const { sessionId, blockId } = await seedSession(studio);
  await adminQuery(
    "insert into public.electrolysis_entries (id, session_id, area, block_id) values ($1,$2,'chin',$3)",
    [randomUUID(), sessionId, blockId],
  );
  const fin = await userQuery(
    studio.userId,
    "select * from public.finalize_session($1,$2)",
    [sessionId, 1],
  );
  return { studio, sessionId, snapV1: fin.rows[0].snapshot_id as string };
}

// The EXACT named-argument call PostgREST issues for
// supabase.rpc("amend_finalized_session", { p_session_id, ... }).
async function amendNamed(
  userId: string,
  args: {
    p_session_id: string;
    p_applies_to_snapshot_id: string;
    p_amendment_type: string;
    p_reason: string;
    p_body: string | null;
    p_structured_addition: unknown;
  },
) {
  const r = await userQuery(
    userId,
    `select * from public.amend_finalized_session(
       p_session_id => $1,
       p_applies_to_snapshot_id => $2,
       p_amendment_type => $3,
       p_reason => $4,
       p_body => $5,
       p_structured_addition => $6::jsonb
     )`,
    [
      args.p_session_id,
      args.p_applies_to_snapshot_id,
      args.p_amendment_type,
      args.p_reason,
      args.p_body,
      args.p_structured_addition === null
        ? null
        : JSON.stringify(args.p_structured_addition),
    ],
  );
  return r.rows[0];
}

// The EXACT named-argument call for
// supabase.rpc("correct_finalized_session", { p_session_id, ... }).
async function correctNamed(
  userId: string,
  args: {
    p_session_id: string;
    p_expected_record_version: number;
    p_reason: string;
    p_payload: unknown;
  },
) {
  const r = await userQuery(
    userId,
    `select * from public.correct_finalized_session(
       p_session_id => $1,
       p_expected_record_version => $2,
       p_reason => $3,
       p_payload => $4::jsonb
     )`,
    [
      args.p_session_id,
      args.p_expected_record_version,
      args.p_reason,
      JSON.stringify(args.p_payload),
    ],
  );
  return r.rows[0];
}

describe("amend_finalized_session — named-arg (PostgREST) invocation", () => {
  it("the browser's named-arg payload (incl p_structured_addition => null) resolves and inserts exactly one amendment + one audit event, leaving the original untouched", async () => {
    const { studio, sessionId, snapV1 } = await seedFinalized();
    const before = await adminQuery(
      "select record_version, current_snapshot_id, (select content_hash from public.clinical_record_snapshots where id=$1) as h, (select count(*)::int from public.clinical_record_snapshots where session_id=$2) as n from public.sessions where id=$2",
      [snapV1, sessionId],
    );

    const row = await amendNamed(studio.userId, {
      p_session_id: sessionId,
      p_applies_to_snapshot_id: snapV1,
      p_amendment_type: "late_note",
      p_reason: "forgot the post-care advice",
      p_body: "advised aloe + no sun 48h",
      p_structured_addition: null,
    });

    // The RPC returns the new amendment id + a content hash.
    expect(row.amendment_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);

    // Exactly one amendment row for this session, and it is the returned id.
    const amendments = await adminQuery(
      "select id, amendment_type, applies_to_snapshot_id from public.clinical_record_amendments where session_id=$1",
      [sessionId],
    );
    expect(amendments.rowCount).toBe(1);
    expect(amendments.rows[0].id).toBe(row.amendment_id);
    expect(amendments.rows[0].amendment_type).toBe("late_note");
    expect(amendments.rows[0].applies_to_snapshot_id).toBe(snapV1);

    // Exactly one clinical audit event, tagged 'amendment' and linked to the row.
    const events = await adminQuery(
      "select operation_type, amendment_id, snapshot_id from public.clinical_audit_events where session_id=$1 and operation_type='amendment'",
      [sessionId],
    );
    expect(events.rowCount).toBe(1);
    expect(events.rows[0].amendment_id).toBe(row.amendment_id);
    expect(events.rows[0].snapshot_id).toBe(snapV1);

    // The original is completely unchanged: version, pointer, v1 hash, snapshot count.
    const after = await adminQuery(
      "select record_version, current_snapshot_id, (select content_hash from public.clinical_record_snapshots where id=$1) as h, (select count(*)::int from public.clinical_record_snapshots where session_id=$2) as n from public.sessions where id=$2",
      [snapV1, sessionId],
    );
    expect(after.rows[0].record_version).toBe(before.rows[0].record_version);
    expect(after.rows[0].current_snapshot_id).toBe(before.rows[0].current_snapshot_id);
    expect(after.rows[0].h).toBe(before.rows[0].h);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("a business rule violation surfaces as a raise through the SAME named-arg shape (e.g. blank reason)", async () => {
    const { studio, sessionId, snapV1 } = await seedFinalized();
    await expect(
      amendNamed(studio.userId, {
        p_session_id: sessionId,
        p_applies_to_snapshot_id: snapV1,
        p_amendment_type: "late_note",
        p_reason: "   ",
        p_body: "something",
        p_structured_addition: null,
      }),
    ).rejects.toThrow();
    // No amendment persisted from the rejected call.
    const amendments = await adminQuery(
      "select count(*)::int as n from public.clinical_record_amendments where session_id=$1",
      [sessionId],
    );
    expect(amendments.rows[0].n).toBe(0);
  });
});

describe("correct_finalized_session — named-arg (PostgREST) invocation", () => {
  it("the browser's named-arg payload creates version N+1 atomically and repoints the session", async () => {
    const { studio, sessionId, snapV1 } = await seedFinalized();
    const v1hash = (
      await adminQuery(
        "select content_hash from public.clinical_record_snapshots where id=$1",
        [snapV1],
      )
    ).rows[0].content_hash;

    const row = await correctNamed(studio.userId, {
      p_session_id: sessionId,
      p_expected_record_version: 1,
      p_reason: "typo in the note",
      p_payload: { session: { session_notes: "corrected note" } },
    });

    expect(row.new_version).toBe(2);
    expect(row.snapshot_id).toMatch(/^[0-9a-f-]{36}$/);

    const s = await adminQuery(
      "select record_version, current_snapshot_id from public.sessions where id=$1",
      [sessionId],
    );
    expect(s.rows[0].record_version).toBe(2);
    expect(s.rows[0].current_snapshot_id).toBe(row.snapshot_id);

    // v1 snapshot content is frozen — the correction never rewrote history.
    const v1after = (
      await adminQuery(
        "select content_hash from public.clinical_record_snapshots where id=$1",
        [snapV1],
      )
    ).rows[0].content_hash;
    expect(v1after).toBe(v1hash);
  });
});
