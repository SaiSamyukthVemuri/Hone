import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  seedSession,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// IDOR / BOLA — object-reference authorization, proved behaviourally
// ===========================================================================
//
// The existing per-feature suites prove their own command in isolation, and
// most of them drive it through `adminQuery` — the service-role connection,
// which BYPASSES RLS and never exercises the actor gate at all. This file
// asks the two cross-cutting questions instead, as a real `authenticated`
// caller:
//
//   1. Which SECURITY DEFINER functions can a browser role reach at all?
//   2. When a caller substitutes an identifier they are not entitled to —
//      another tenant's, or the right tenant's WRONG PARENT — does the
//      command refuse AND leave zero rows changed?
//
// Case C (same studio, wrong client) is the one RLS cannot close on its own:
// every row involved is inside the caller's own tenant, so a studio-scoped
// policy admits all of them. Only an explicit parent predicate refuses.
//
// Everything here runs against the LOCAL stack through the standard harness,
// which refuses any non-localhost connection string.

type Studio = SeededStudio;

let A: Studio;   // the acting tenant
let B: Studio;   // the foreign tenant
let aSession: string;
let aSecondClient: string;
let aImage: string;
let bSession: string;
let bImage: string;
let bAppointment: string;

async function seedImage(studio: Studio, clientId: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.treatment_images
       (id, studio_id, client_id, storage_path, content_type, size_bytes)
     values ($1, $2, $3, $4, 'image/jpeg', 1024)`,
    [id, studio.studioId, clientId, `${studio.studioId}/${clientId}/${id}.jpg`],
  );
  return id;
}

async function seedCompletedAppointment(studio: Studio): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, practitioner_id, starts_at, ends_at,
        duration_minutes, buffer_minutes_snapshot, blocked_ends_at, status)
     values ($1, $2, $3, $4,
             now() - interval '2 hours', now() - interval '1 hour',
             60, 0, now() - interval '1 hour', 'completed')`,
    [id, studio.studioId, studio.clientId, studio.practitionerId],
  );
  return id;
}

beforeAll(async () => {
  A = await seedStudio("idor-a");
  B = await seedStudio("idor-b");

  aSession = (await seedSession(A)).sessionId;
  bSession = (await seedSession(B)).sessionId;

  // A SECOND client inside studio A. This is the whole point of case C:
  // both clients are legitimately visible to the same practitioner.
  aSecondClient = randomUUID();
  await adminQuery(
    `insert into public.clients (id, studio_id, name) values ($1, $2, 'A Second Client')`,
    [aSecondClient, A.studioId],
  );

  aImage = await seedImage(A, A.clientId);
  bImage = await seedImage(B, B.clientId);
  bAppointment = await seedCompletedAppointment(B);
});

afterAll(async () => {
  await closePool();
});

// -------------------------------------------------------------------------
// 1. THE REACHABLE SURFACE. Which SECURITY DEFINER functions can a browser
//    role execute? This is the census as a tripwire: a future migration that
//    forgets one of the four by-name revokes widens this set and fails here.
// -------------------------------------------------------------------------
describe("the browser-reachable SECURITY DEFINER surface", () => {
  // Directly callable (non-trigger) definer functions `anon` may EXECUTE.
  // Each is a membership predicate that resolves through auth.uid(), so for
  // an anonymous caller (auth.uid() IS NULL) it can only answer "no".
  const ANON_EXECUTABLE = [
    "is_studio_member",
    "is_studio_owner",
    "session_is_visible",
  ] as const;

  it("anon can execute ONLY the three auth.uid()-resolved predicates", async () => {
    const { rows } = await adminQuery(`
      select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prokind = 'f'
         and p.prosecdef
         and pg_get_function_result(p.oid) <> 'trigger'
         and has_function_privilege('anon', p.oid, 'EXECUTE')
       order by p.proname
    `);
    expect(rows.map((r: { proname: string }) => r.proname)).toEqual([
      ...ANON_EXECUTABLE,
    ]);
  });

  it("every one of them answers NO for an anonymous caller", async () => {
    await asRole("anon", async (query) => {
      const member = await query(`select public.is_studio_member($1) v`, [A.studioId]);
      const owner = await query(`select public.is_studio_owner($1) v`, [A.studioId]);
      const visible = await query(`select public.session_is_visible($1) v`, [aSession]);
      expect(member.rows[0].v).toBe(false);
      expect(owner.rows[0].v).toBe(false);
      expect(visible.rows[0].v).toBe(false);
    });
  });

  it("every authenticated-callable definer command resolves its actor from auth.uid()", async () => {
    // Transitive: a command may delegate the check to a helper
    // (assert_session_writable, session_actor_practitioner, is_studio_member,
    // own_practitioner_in_studio...). What must never exist is a command whose
    // authority comes ONLY from arguments the caller supplied.
    const { rows } = await adminQuery(`
      with recursive f as (
        select p.oid, p.proname, pg_get_functiondef(p.oid) as def
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prokind = 'f'
      ),
      direct as (select proname from f where def ~* 'auth\\.uid\\(\\)'),
      edges as (
        select c.proname as caller, t.proname as callee
          from f c join f t
            on t.proname <> c.proname
           and c.def ~* ('\\m(public\\.)?' || t.proname || '\\s*\\(')
      ),
      reach as (
        select proname from direct
        union
        select e.caller from edges e join reach r on r.proname = e.callee
      )
      select f.proname
        from f
        join pg_proc p on p.oid = f.oid
       where p.prosecdef
         and pg_get_function_result(p.oid) <> 'trigger'
         and has_function_privilege('authenticated', p.oid, 'EXECUTE')
         and f.proname not in (select proname from reach)
       order by f.proname
    `);
    expect(rows.map((r: { proname: string }) => r.proname)).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// 2. CASE E — DIFFERENT STUDIO. The caller is a legitimate, active owner of
//    studio A and submits studio B's identifiers.
// -------------------------------------------------------------------------
describe("case E — cross-tenant object substitution", () => {
  it("refuses to write a clinical note onto another tenant's session", async () => {
    await expect(
      userQuery(A.userId, `select public.set_next_session_note($1, $2, 'pwned')`, [
        bSession,
        B.clientId,
      ]),
    ).rejects.toThrow(/not found or not writable/i);

    const { rows } = await adminQuery(
      `select next_session_note from public.sessions where id = $1`,
      [bSession],
    );
    expect(rows[0].next_session_note).toBeNull();
  });

  it("refuses to soft-delete another tenant's session", async () => {
    await expect(
      userQuery(A.userId, `select public.soft_delete_session($1, $2, 'audit probe')`, [
        bSession,
        B.clientId,
      ]),
    ).rejects.toThrow();

    const { rows } = await adminQuery(
      `select deleted_at from public.sessions where id = $1`,
      [bSession],
    );
    expect(rows[0].deleted_at).toBeNull();
  });

  it("refuses to archive another tenant's treatment photo", async () => {
    const { rows } = await userQuery(
      A.userId,
      `select public.archive_treatment_image($1, $2) v`,
      [bImage, B.clientId],
    );
    // A generic NULL: never a distinguishable "exists but forbidden".
    expect(rows[0].v).toBeNull();

    const after = await adminQuery(
      `select deleted_at from public.treatment_images where id = $1`,
      [bImage],
    );
    expect(after.rows[0].deleted_at).toBeNull();
  });

  it("refuses to record a settlement against another tenant's appointment", async () => {
    await expect(
      userQuery(
        A.userId,
        `select * from public.record_appointment_settlement($1, $2, 'paid_cash', 5000, null, false)`,
        [B.studioId, bAppointment],
      ),
    ).rejects.toThrow();

    const { rows } = await adminQuery(
      `select count(*)::int c from public.appointment_settlements where appointment_id = $1`,
      [bAppointment],
    );
    expect(rows[0].c).toBe(0);
  });

  it("cannot even see the foreign tenant's rows through RLS", async () => {
    await asUser(A.userId, async (query) => {
      const s = await query(`select count(*)::int c from public.sessions where id = $1`, [bSession]);
      const c = await query(`select count(*)::int c from public.clients where id = $1`, [B.clientId]);
      const i = await query(`select count(*)::int c from public.treatment_images where id = $1`, [bImage]);
      expect(s.rows[0].c).toBe(0);
      expect(c.rows[0].c).toBe(0);
      expect(i.rows[0].c).toBe(0);
    });
  });
});

// -------------------------------------------------------------------------
// 3. CASE C / G / H — SAME STUDIO, WRONG PARENT. Every row below belongs to
//    the caller's own tenant, so RLS admits all of them. Only an explicit
//    parent predicate can refuse, which is exactly what is being proved.
// -------------------------------------------------------------------------
describe("case C — same studio, wrong client/parent", () => {
  it("baseline: the SAME command succeeds with the correct parent", async () => {
    await userQuery(A.userId, `select public.set_next_session_note($1, $2, 'legitimate')`, [
      aSession,
      A.clientId,
    ]);
    const { rows } = await adminQuery(
      `select next_session_note from public.sessions where id = $1`,
      [aSession],
    );
    expect(rows[0].next_session_note).toBe("legitimate");
  });

  it("refuses a charting write when the session belongs to a DIFFERENT client of the same studio", async () => {
    await expect(
      userQuery(A.userId, `select public.set_next_session_note($1, $2, 'misfiled')`, [
        aSession,
        aSecondClient, // forged parent, valid child, same tenant
      ]),
    ).rejects.toThrow(/does not belong to that client/i);

    const { rows } = await adminQuery(
      `select next_session_note from public.sessions where id = $1`,
      [aSession],
    );
    expect(rows[0].next_session_note).toBe("legitimate"); // unchanged
  });

  it("refuses the session price write under the wrong client", async () => {
    await expect(
      userQuery(A.userId, `select public.set_session_price($1, $2, 12345)`, [
        aSession,
        aSecondClient,
      ]),
    ).rejects.toThrow(/does not belong to that client/i);

    const { rows } = await adminQuery(
      `select price_paid_cents from public.sessions where id = $1`,
      [aSession],
    );
    expect(rows[0].price_paid_cents).toBeNull();
  });

  it("refuses to soft-delete a session under the wrong client", async () => {
    await expect(
      userQuery(A.userId, `select public.soft_delete_session($1, $2, 'wrong parent probe')`, [
        aSession,
        aSecondClient,
      ]),
    ).rejects.toThrow(/does not belong to that client/i);

    const { rows } = await adminQuery(
      `select deleted_at from public.sessions where id = $1`,
      [aSession],
    );
    expect(rows[0].deleted_at).toBeNull();
  });

  it("refuses to archive a treatment photo under the wrong client", async () => {
    const { rows } = await userQuery(
      A.userId,
      `select public.archive_treatment_image($1, $2) v`,
      [aImage, aSecondClient],
    );
    expect(rows[0].v).toBeNull();

    const after = await adminQuery(
      `select deleted_at from public.treatment_images where id = $1`,
      [aImage],
    );
    expect(after.rows[0].deleted_at).toBeNull();
  });

  it("refuses to write a photo note under the wrong client", async () => {
    const { rows } = await userQuery(
      A.userId,
      `select public.set_treatment_image_note($1, $2, 'misfiled note') v`,
      [aImage, aSecondClient],
    );
    expect(rows[0].v).toBeNull();

    const after = await adminQuery(
      `select practitioner_note from public.treatment_images where id = $1`,
      [aImage],
    );
    expect(after.rows[0].practitioner_note).toBeNull();
  });

  it("a clinical-note revision cannot supersede another client's note", async () => {
    // The app layer never validates supersedes_note_id; the 0126 trigger is
    // the only thing standing between a forged id and a cross-client link.
    const victim = randomUUID();
    await adminQuery(
      `insert into public.client_clinical_notes
         (id, studio_id, client_id, practitioner_id, kind, body)
       values ($1, $2, $3, $4, 'consultation', 'the other client''s note')`,
      [victim, A.studioId, aSecondClient, A.practitionerId],
    );

    await expect(
      userQuery(
        A.userId,
        `insert into public.client_clinical_notes
           (studio_id, client_id, practitioner_id, kind, body, supersedes_note_id)
         values ($1, $2, $3, 'consultation', 'hijack', $4)`,
        [A.studioId, A.clientId, A.practitionerId, victim],
      ),
    ).rejects.toThrow(/same client, studio, and kind/i);

    // The victim's note is still the live one: nothing supersedes it.
    const { rows } = await adminQuery(
      `select count(*)::int c from public.client_clinical_notes where supersedes_note_id = $1`,
      [victim],
    );
    expect(rows[0].c).toBe(0);
  });
});

// -------------------------------------------------------------------------
// 4. CASE B — NONEXISTENT IDENTIFIERS must be indistinguishable from
//    forbidden ones. An attacker must not be able to use the error channel
//    to confirm that another tenant's object exists.
// -------------------------------------------------------------------------
describe("case B — no error oracle", () => {
  it("a nonexistent session and a foreign session fail identically", async () => {
    const ghost = randomUUID();
    const ghostErr = await userQuery(A.userId, `select public.set_next_session_note($1,$2,'x')`, [
      ghost,
      A.clientId,
    ]).catch((e: Error) => e.message);
    const foreignErr = await userQuery(A.userId, `select public.set_next_session_note($1,$2,'x')`, [
      bSession,
      B.clientId,
    ]).catch((e: Error) => e.message);
    expect(foreignErr).toBe(ghostErr);
  });

  it("a nonexistent image and a foreign image both return a bare NULL", async () => {
    const ghost = await userQuery(
      A.userId,
      `select public.archive_treatment_image($1,$2) v`,
      [randomUUID(), A.clientId],
    );
    const foreign = await userQuery(
      A.userId,
      `select public.archive_treatment_image($1,$2) v`,
      [bImage, B.clientId],
    );
    expect(ghost.rows[0].v).toBeNull();
    expect(foreign.rows[0].v).toBeNull();
  });
});
