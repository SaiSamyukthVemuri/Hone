import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  adminQuery,
  adminTx,
  asRole,
  closePool,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// Practitioner-assisted intake — the DATABASE half, on the REAL migrated
// local database.
//
// 0243 retires blind authenticated/service-role protected writes. Authorized
// assisted/public answers use the existing service-only CAS command; current
// server actions still resolve the caller/tenant and client-owned boundaries.
// Direct notes/review/link metadata remains governed by the existing RLS and
// terminal rules. The protected-write trigger runs after those frozen guards.
//
// Only non-clinical placeholder answers are used.

let A: SeededStudio;
let B: SeededStudio;

const PROV_KEY = "practitioner_assisted_entry";

function provenance(practitionerId: string, name: string) {
  return {
    mode: "practitioner_assisted",
    version: "v1",
    started_at: "2026-08-07T10:00:00.000Z",
    started_by: { practitioner_id: practitionerId, display_name: name },
    last_updated_at: "2026-08-07T10:05:00.000Z",
    last_updated_by: { practitioner_id: practitionerId, display_name: name },
  };
}

async function seedIntake(
  studio: SeededStudio,
  state: "in_progress" | "submitted" | "reviewed",
  responses: Record<string, unknown> = { q: "draft" },
): Promise<string> {
  const id = randomUUID();
  if (state === "in_progress") {
    await adminQuery(
      `insert into public.client_intake_forms (id, studio_id, client_id, status, responses)
       values ($1, $2, $3, 'in_progress', $4::jsonb)`,
      [id, studio.studioId, studio.clientId, JSON.stringify(responses)],
    );
  } else if (state === "submitted") {
    await adminQuery(
      `insert into public.client_intake_forms (id, studio_id, client_id, status, responses, submitted_at)
       values ($1, $2, $3, 'submitted', $4::jsonb, now())`,
      [id, studio.studioId, studio.clientId, JSON.stringify(responses)],
    );
  } else {
    await adminQuery(
      `insert into public.client_intake_forms (id, studio_id, client_id, status, responses, submitted_at, reviewed_at, reviewed_by)
       values ($1, $2, $3, 'reviewed', $4::jsonb, now(), now(), $5)`,
      [
        id,
        studio.studioId,
        studio.clientId,
        JSON.stringify(responses),
        studio.practitionerId,
      ],
    );
  }
  return id;
}

async function storedResponses(id: string): Promise<Record<string, unknown>> {
  const r = await adminQuery(
    `select responses from public.client_intake_forms where id = $1`,
    [id],
  );
  return r.rows[0].responses as Record<string, unknown>;
}

beforeAll(async () => {
  A = await seedStudio("assisted-a");
  B = await seedStudio("assisted-b");
});
afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
describe("1. authorized assisted entry uses the governed draft command", () => {
  it("writes questionnaire answers AND the reserved provenance key", async () => {
    const id = await seedIntake(A, "in_progress");
    const merged = {
      q: "draft",
      legal_name: "Dana Reyes",
      [PROV_KEY]: provenance(A.practitionerId, "Chloe Baca"),
    };
    const res = await adminTx(async (q) => {
      await q("set local role service_role");
      return q("select * from public.write_intake_revision($1,$2,$3,0,$4::jsonb,2,'save','{}'::jsonb)",
        [id, A.studioId, A.clientId, JSON.stringify(merged)]);
    });
    expect(res.rows).toEqual([{ outcome: "saved", new_revision: "1" }]);

    const stored = await storedResponses(id);
    expect(stored.legal_name).toBe("Dana Reyes");
    expect(stored[PROV_KEY]).toMatchObject({
      mode: "practitioner_assisted",
      started_by: { practitioner_id: A.practitionerId },
    });
  });

  it("the updated_at concurrency token really moves on every write", async () => {
    // The assisted action's optimistic-concurrency predicate is only
    // meaningful if the 0015 trigger actually bumps updated_at.
    const id = await seedIntake(A, "in_progress");
    const before = await adminQuery(
      `select updated_at from public.client_intake_forms where id = $1`,
      [id],
    );
    await userQuery(
      A.userId,
      `update public.client_intake_forms set practitioner_notes = 'Allowed note' where id = $1`,
      [id],
    );
    const after = await adminQuery(
      `select updated_at from public.client_intake_forms where id = $1`,
      [id],
    );
    expect(
      new Date(after.rows[0].updated_at).getTime(),
    ).toBeGreaterThan(new Date(before.rows[0].updated_at).getTime());
  });

  it("a stale updated_at predicate matches zero rows", async () => {
    const id = await seedIntake(A, "in_progress");
    const first = await adminQuery(
      `select updated_at from public.client_intake_forms where id = $1`,
      [id],
    );
    const staleToken = first.rows[0].updated_at;
    // Someone else writes.
    await userQuery(
      A.userId,
      `update public.client_intake_forms set practitioner_notes = 'Other note' where id = $1`,
      [id],
    );
    // Our write, carrying the token we last saw, must now match nothing.
    const res = await userQuery(
      A.userId,
      `update public.client_intake_forms
          set practitioner_notes = 'Stale note'
        where id = $1 and updated_at = $2
        returning id`,
      [id, staleToken],
    );
    expect(res.rowCount).toBe(0);
    const { rows: [stored] } = await adminQuery("select practitioner_notes, responses from public.client_intake_forms where id=$1", [id]);
    expect(stored.practitioner_notes).toBe("Other note");
    expect(stored.responses).toEqual({ q: "draft" });
  });
});

// ---------------------------------------------------------------------------
describe("2. the client-owned submission boundary is enforced by the DATABASE", () => {
  it("an authenticated member CANNOT move an intake to submitted", async () => {
    const id = await seedIntake(A, "in_progress");
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'submitted', submitted_at = now()
          where id = $1 returning id`,
        [id],
      ),
    ).rejects.toThrow(/Only the client can submit their own intake/i);

    const row = await adminQuery(
      `select status, submitted_at from public.client_intake_forms where id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe("in_progress");
    expect(row.rows[0].submitted_at).toBeNull();
  });

  it("...not even while writing legitimate assisted answers in the same statement", async () => {
    const id = await seedIntake(A, "in_progress");
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set responses = $2::jsonb, status = 'submitted', submitted_at = now()
          where id = $1 returning id`,
        [id, JSON.stringify({ legal_name: "Dana" })],
      ),
    ).rejects.toThrow(/Only the client can submit their own intake/i);
    const row = await adminQuery(
      `select status from public.client_intake_forms where id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe("in_progress");
  });

  it("a member cannot attach review metadata to a draft either", async () => {
    const id = await seedIntake(A, "in_progress");
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set reviewed_by = $2, reviewed_at = now()
          where id = $1 returning id`,
        [id, A.practitionerId],
      ),
    ).rejects.toThrow(/Review metadata can only be recorded/i);
  });
});

// ---------------------------------------------------------------------------
describe("3. assisted answers and provenance freeze with the record", () => {
  for (const state of ["submitted", "reviewed"] as const) {
    it(`a ${state} intake's responses cannot be rewritten by a member`, async () => {
      const original = {
        legal_name: "Dana Reyes",
        [PROV_KEY]: provenance(A.practitionerId, "Chloe Baca"),
      };
      const id = await seedIntake(A, state, original);
      await expect(
        userQuery(
          A.userId,
          `update public.client_intake_forms
              set responses = $2::jsonb
            where id = $1 returning id`,
          [id, JSON.stringify({ legal_name: "Rewritten" })],
        ),
      ).rejects.toThrow(/Submitted intake answers are immutable/i);

      const stored = await storedResponses(id);
      expect(stored.legal_name).toBe("Dana Reyes");
      expect(stored[PROV_KEY]).toMatchObject({
        started_by: { practitioner_id: A.practitionerId },
      });
    });

    it(`a ${state} intake's provenance cannot be quietly re-attributed`, async () => {
      const original = {
        [PROV_KEY]: provenance(A.practitionerId, "Chloe Baca"),
      };
      const id = await seedIntake(A, state, original);
      const forged = { [PROV_KEY]: provenance(B.practitionerId, "Someone Else") };
      await expect(
        userQuery(
          A.userId,
          `update public.client_intake_forms set responses = $2::jsonb where id = $1 returning id`,
          [id, JSON.stringify(forged)],
        ),
      ).rejects.toThrow(/Submitted intake answers are immutable/i);
      const stored = await storedResponses(id);
      expect(
        (stored[PROV_KEY] as Record<string, unknown>).started_by,
      ).toMatchObject({ display_name: "Chloe Baca" });
    });
  }
});

// ---------------------------------------------------------------------------
describe("4. cross-studio isolation", () => {
  it("a member of another studio cannot write a draft's responses", async () => {
    const id = await seedIntake(A, "in_progress");
    const res = await userQuery(
      B.userId,
      `update public.client_intake_forms
          set responses = '{"legal_name":"Injected"}'::jsonb
        where id = $1 returning id`,
      [id],
    );
    expect(res.rowCount).toBe(0);
    const stored = await storedResponses(id);
    expect(stored).not.toHaveProperty("legal_name");
  });

  it("a member of another studio cannot even read it", async () => {
    const id = await seedIntake(A, "in_progress");
    const res = await userQuery(
      B.userId,
      `select id from public.client_intake_forms where id = $1`,
      [id],
    );
    expect(res.rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("5. direct runtime provenance forgery is refused", () => {
  it("a member cannot directly write provenance naming a colleague", async () => {
    // The approved amendment explicitly retires this old direct-write path.
    // Legitimate server-derived provenance is exercised through CAS above.
    const id = await seedIntake(A, "in_progress");
    const colleague = await adminQuery(
      `select id, display_name from public.practitioners
        where studio_id = $1 limit 1`,
      [A.studioId],
    );
    const forged = {
      [PROV_KEY]: provenance(colleague.rows[0].id, "Not Actually Them"),
    };
    await expect(userQuery(A.userId,
      `update public.client_intake_forms set responses = $2::jsonb where id = $1 returning id`,
      [id, JSON.stringify(forged)],
    )).rejects.toMatchObject({ code: "42501" });
    expect(await storedResponses(id)).toEqual({ q: "draft" });
  });
});


// 0243 command-level concurrency/ACL proof. Prepared only: requires the
// composed 0243 chain and a separately granted paired isolated DB target.
describe("0243 public/assisted revision and atomic profile boundary", () => {
  const command = "select * from public.write_intake_revision($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb)";
  function parameters(id: string, revision: string, operation = "save", responses: Record<string, unknown> = {}, profile: Record<string, unknown> = {}, studio = A.studioId, client = A.clientId) {
    return [id, studio, client, revision, JSON.stringify(responses), operation === "save" ? 1 : 5, operation, JSON.stringify(profile)];
  }
  async function write(args: unknown[]) {
    return adminTx(async (q) => { await q("set local role service_role"); return (await q(command, args)).rows[0]; });
  }
  it.each(["anon", "authenticated"] as const)("%s cannot invoke the privileged writer", async (role) => {
    const id = await seedIntake(A, "in_progress");
    await expect(asRole(role, (q) => q(command, parameters(id, "0")))).rejects.toMatchObject({ code: "42501" });
  });
  it.each([["save", "save"], ["save", "submit"], ["submit", "submit"]])(
    "two %s/%s requests with one snapshot have exactly one winner", async (first, second) => {
      const id = await seedIntake(A, "in_progress");
      const results = await Promise.all([
        write(parameters(id, "0", first, { legal_name: "Public A" })),
        write(parameters(id, "0", second, { legal_name: "Public B" })),
      ]);
      expect(results.filter((r) => ["saved", "submitted"].includes(r.outcome))).toHaveLength(1);
      expect(results.filter((r) => ["conflict", "terminal"].includes(r.outcome))).toHaveLength(1);
      const { rows: [row] } = await adminQuery("select revision::text, responses from public.client_intake_forms where id=$1", [id]);
      expect(row.revision).toBe("1");
      expect(["Public A", "Public B"]).toContain(row.responses.legal_name);
    },
  );
  it("a prior assisted write invalidates the public snapshot, and a stale assisted write cannot overwrite it", async () => {
    const id = await seedIntake(A, "in_progress");
    expect((await write(parameters(id, "0", "save", { legal_name: "Assisted" }))).outcome).toBe("saved");
    expect((await write(parameters(id, "0", "save", { legal_name: "Stale public" }))).outcome).toBe("conflict");
    expect((await write(parameters(id, "1", "save", { legal_name: "Current public" }))).outcome).toBe("saved");
    expect((await write(parameters(id, "1", "save", { legal_name: "Stale assisted" }))).outcome).toBe("conflict");
    expect((await storedResponses(id)).legal_name).toBe("Current public");
  });
  // Intentionally blocks closure until the direct-writer boundary is governed.
  // The earlier case proves direct-before-CAS invalidation, not this reverse
  // ordering. Do not mark this expected failure green or weaken preservation.
  it("a stale authenticated direct response update cannot overwrite a governed CAS winner", async () => {
    const id = await seedIntake(A, "in_progress", { legal_name: "Original draft" });
    const initial = await userQuery(A.userId,
      "select revision::text, responses from public.client_intake_forms where id=$1 and studio_id=$2",
      [id, A.studioId]);
    expect(initial.rows).toHaveLength(1);
    const stale = initial.rows[0] as { revision: string; responses: Record<string, unknown> };
    expect(stale.revision).toBe("0");

    const governedAnswers = { legal_name: "Governed winner" };
    const winner = await write(parameters(id, stale.revision, "save", governedAnswers));
    expect(winner).toEqual({ outcome: "saved", new_revision: "1" });

    // Model the existing blind whole-map writer: correct tenant, authenticated
    // member and draft status, but no expected-revision predicate.
    const direct = await userQuery(A.userId,
      "update public.client_intake_forms set responses=$3::jsonb where id=$1 and studio_id=$2 and status='in_progress' returning id",
      [id, A.studioId, JSON.stringify({ ...stale.responses, legal_name: "Stale direct draft" })],
    ).then(
      (result) => ({ refused: result.rowCount === 0, writtenRows: result.rowCount }),
      () => ({ refused: true, writtenRows: 0 }),
    );
    // Always read back before asserting so a failure records the real clobber
    // and revision advance, rather than stopping at the UPDATE's success.
    const { rows: [stored] } = await adminQuery(
      "select revision::text, responses from public.client_intake_forms where id=$1", [id]);
    expect({ direct, responses: stored.responses, revision: stored.revision }).toEqual({
      direct: expect.objectContaining({ refused: true }),
      responses: governedAnswers,
      revision: winner.new_revision,
    });
  });

  it("a rolled-back old public service-role submit cannot replace a current CAS winner after248", async () => {
    const id = await seedIntake(A, "in_progress", { legal_name: "Old public editor" });
    const { rows: [stale] } = await adminTx(async q => {
      await q("set local role service_role");
      return q("select revision::text,responses from public.client_intake_forms where id=$1 and studio_id=$2", [id,A.studioId]);
    });
    expect(stale).toEqual({ revision: "0", responses: { legal_name: "Old public editor" } });
    const answers = { legal_name: "Current CAS winner" };
    expect(await write(parameters(id, stale.revision, "save", answers)))
      .toEqual({ outcome: "saved", new_revision: "1" });

    // Model the pre-CAS public server artifact: service-role, correct tenant,
    // draft predicate, whole-map answers + submitted status/time, no revision.
    // Its transaction commits if mistakenly permitted, so a broken guard
    // produces a real clobber diagnostic rather than a rolled-back false pass.
    const direct = await adminTx(async q => {
      await q("set local role service_role");
      expect((await q("select current_user as role")).rows[0].role).toBe("service_role");
      return q(`update public.client_intake_forms
        set responses=$3::jsonb,status='submitted',submitted_at=now()
        where id=$1 and studio_id=$2 and status='in_progress' returning id`,
        [id,A.studioId,JSON.stringify({ ...stale.responses, legal_name: "Stale rollback submission" })]);
    }).then(
      result => ({ writtenRows: result.rowCount, code: null, message: null }),
      error => ({ writtenRows: 0, code: error.code, message: error.message }),
    );
    // Read first even if the old writer was incorrectly admitted.
    const { rows: [stored] } = await adminQuery(
      "select responses,status,submitted_at,revision::text from public.client_intake_forms where id=$1", [id]);
    expect({ direct, stored }).toEqual({
      direct: { writtenRows: 0, code: "42501", message: "Protected intake changes require the governed revision command." },
      stored: { responses: answers, status: "in_progress", submitted_at: null, revision: "1" },
    });
    // Already-dispatched detached profile callbacks are not exercised or
    // prevented by this denial: serving/rollback artifacts still need drain.
  });

  it("pins the actual definer/invoker owner, role graph and effective command ACL", async () => {
    const { rows: [context] } = await adminQuery(`
      select w.proowner::text as writer_owner, g.proowner::text as guard_owner,
        w.prosecdef as writer_definer, g.prosecdef as guard_definer,
        w.proconfig as writer_config, g.proconfig as guard_config
      from pg_catalog.pg_proc w, pg_catalog.pg_proc g
      where w.oid='public.write_intake_revision(uuid,uuid,uuid,bigint,jsonb,integer,text,jsonb)'::regprocedure
        and g.oid='public.advance_intake_revision()'::regprocedure`);
    expect(context.writer_owner).toBe(context.guard_owner);
    expect(context.writer_definer).toBe(true); expect(context.guard_definer).toBe(false);
    expect(context.writer_config).toEqual(['search_path=""']);
    expect(context.guard_config).toEqual(['search_path=""']);
    // Role metadata is authoritative here. SET ROLE in this harness would
    // still have a postgres session_user and could falsely appear permitted.
    const { rows } = await adminQuery(`select r.rolname,
      pg_catalog.pg_has_role(r.oid,w.proowner,'MEMBER') as is_owner_member,
      pg_catalog.pg_has_role(r.oid,w.proowner,'SET') as can_assume_owner,
      pg_catalog.has_function_privilege(r.oid,w.oid,'EXECUTE') as can_execute
      from pg_catalog.pg_roles r, pg_catalog.pg_proc w
      where r.rolname in ('anon','authenticated','service_role','authenticator')
        and w.oid='public.write_intake_revision(uuid,uuid,uuid,bigint,jsonb,integer,text,jsonb)'::regprocedure`);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.can_assume_owner === false)).toBe(true);
    expect(rows.every((row) => row.is_owner_member === false)).toBe(true);
    for (const role of ['anon','authenticated','service_role']) {
      expect(rows.find((row) => row.rolname === role)?.can_execute).toBe(role === 'service_role');
    }
    const { rows: delegates } = await adminQuery(`select p.oid::regprocedure::text as signature
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prosecdef
        and p.oid<>'public.write_intake_revision(uuid,uuid,uuid,bigint,jsonb,integer,text,jsonb)'::regprocedure
        and p.prosrc ~* '(^|[^a-z0-9_])client_intake_forms([^a-z0-9_]|$)'
      and (
        p.oid = pg_catalog.to_regprocedure('public.receptionist_client_contacts(pg_catalog.uuid,pg_catalog.text,pg_catalog.int4)')
        and p.proowner = (select w.proowner from pg_catalog.pg_proc w where w.oid='public.write_intake_revision(uuid,uuid,uuid,bigint,jsonb,integer,text,jsonb)'::regprocedure) and p.provolatile = 's' and p.prokind = 'f'
        and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
        and p.proconfig = array['search_path=pg_catalog, pg_temp']::text[]
        and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') = '4ad10247566c4186a5c03d12180c2946ae05919fcc75f4145e5a8566ada9ff6a'
        and exists (
          select 1 from pg_catalog.pg_proc helper
          where helper.oid = pg_catalog.to_regprocedure('public.receptionist_actor_id(pg_catalog.uuid)')
            and helper.proowner = p.proowner and helper.prosecdef
            and helper.provolatile = 's' and helper.prokind = 'f'
            and helper.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'sql')
            and helper.proconfig = array['search_path=pg_catalog, pg_temp']::text[]
            and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(helper.prosrc, 'UTF8')), 'hex') = 'cf6256e2abdaaa6c319b17b26b22da159ab1017d5b2970676695961bdd9af7b4'
            and not pg_catalog.has_function_privilege('anon', helper.oid, 'EXECUTE')
            and not pg_catalog.has_function_privilege('authenticated', helper.oid, 'EXECUTE')
            and not pg_catalog.has_function_privilege('service_role', helper.oid, 'EXECUTE')
            and not exists (
              select 1 from pg_catalog.aclexplode(coalesce(helper.proacl, pg_catalog.acldefault('f', helper.proowner))) a
              where a.privilege_type = 'EXECUTE' and a.grantee <> helper.proowner
            )
        )
        and pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
        and not exists (
          select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
          where a.privilege_type = 'EXECUTE' and (a.grantee not in
            (p.proowner, (select r.oid from pg_catalog.pg_roles r where r.rolname = 'authenticated'))
            or (a.grantee <> p.proowner and a.is_grantable))
        )
      ) is not true
        and (pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE')
          or pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')
          or pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE'))`);
    expect(delegates).toEqual([]);
  });

  it("additive0243 keeps legacy writes available and invalidates stale CAS before later0248 closure", async () => {
    const id = await seedIntake(A, "in_progress");
    const migration = readFileSync("supabase/migrations/0243_intake_revision_cas_and_profile_sync.sql", "utf8");
    const start = migration.indexOf("create function public.advance_intake_revision()");
    const additiveGuard = migration.slice(start, migration.indexOf("\n$$;", start) + 4)
      .replace("create function", "create or replace function");
    await adminTx(async q => {
      await q("savepoint additive_phase");
      try {
        // Simulate only the earlier additive function inside a rolled-back
        // catalog savepoint. No migration-history rows or frozen SQL change.
        await q(additiveGuard);
        await q("set local role authenticated");
        await q("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: A.userId, role: "authenticated" })]);
        const { rows: [legacy] } = await q("update public.client_intake_forms set responses=$2::jsonb,revision=999 where id=$1 returning revision::text,responses",
          [id, JSON.stringify({ legal_name: "Legacy additive writer" })]);
        expect(legacy).toEqual({ revision: "1", responses: { legal_name: "Legacy additive writer" } });
        await q("set local role service_role");
        const command = "select * from public.write_intake_revision($1,$2,$3,$4,$5::jsonb,1,'save','{}'::jsonb)";
        const { rows: [stale] } = await q(command, [id,A.studioId,A.clientId,0,JSON.stringify({ legal_name: "Stale CAS" })]);
        expect(stale).toEqual({ outcome: "conflict", new_revision: null });
        expect((await q("select responses from public.client_intake_forms where id=$1", [id])).rows[0].responses).toEqual(legacy.responses);
        const { rows: [fresh] } = await q(command, [id,A.studioId,A.clientId,1,JSON.stringify({ legal_name: "Fresh CAS" })]);
        expect(fresh).toEqual({ outcome: "saved", new_revision: "2" });
      } finally {
        await q("rollback to savepoint additive_phase");
      }
      // The exact final guard and original row are restored, not dropped.
      await expect(q("select 1")).resolves.toBeDefined();
    });
    expect((await adminQuery("select revision::text,responses from public.client_intake_forms where id=$1", [id])).rows[0])
      .toEqual({ revision: "0", responses: { q: "draft" } });
  });

  it.each(["unknown delegate", "changed reviewed body", "changed transitive helper", "delegate grant option", "writer grant option"] as const)("the actual migration preflight refuses %s", async (change) => {
    const migration = readFileSync("supabase/migrations/0248_intake_protected_write_enforcement.sql", "utf8");
    const preflight = migration.slice(migration.lastIndexOf("do $$"), migration.lastIndexOf("\ncommit;"));
    await adminTx(async (q) => {
      // Positive actual full-chain context first; mutants live only inside
      // this transaction/savepoint and cannot alter another test's catalog.
      await q(preflight);
      await q("savepoint delegate_negative");
      try {
        if (change === "unknown delegate") {
          await q(`create function public.test_0243_unreviewed_intake_reader() returns bigint
            language sql stable security definer set search_path='' as
            'select count(*) from public.client_intake_forms'`);
          await q("grant execute on function public.test_0243_unreviewed_intake_reader() to authenticated");
        } else if (change === "delegate grant option") {
          await q("grant execute on function public.receptionist_client_contacts(uuid,text,integer) to authenticated with grant option");
        } else if (change === "writer grant option") {
          await q("grant execute on function public.write_intake_revision(uuid,uuid,uuid,bigint,jsonb,integer,text,jsonb) to service_role with grant option");
        } else {
          const signature = change === "changed transitive helper"
            ? "public.receptionist_actor_id(uuid)" : "public.receptionist_client_contacts(uuid,text,integer)";
          const { rows: [row] } = await q("select pg_catalog.pg_get_functiondef($1::regprocedure) as definition", [signature]);
          const changed = row.definition.replace("AS $function$", "AS $function$\n-- Unreviewed source change.");
          expect(changed).not.toBe(row.definition);
          await q(changed);
        }
        await expect(q(preflight)).rejects.toMatchObject({
          code: "P0001", message: change === "writer grant option"
            ? "Unsafe intake revision command privileges." : "Unexpected callable intake definer requires review.",
        });
      } finally {
        await q("rollback to savepoint delegate_negative");
      }
      await q(preflight);
    });
  });

  it.each(["authenticated", "service_role"] as const)("%s cannot forge protected writes with a counter, claim or caller setting", async (role) => {
    const id = await seedIntake(A, "in_progress");
    await expect(asRole(role, async (q) => {
      await q("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: A.userId, role: "postgres" })]);
      await q("select set_config('hone.intake_revision_writer','true',true)");
      return q("update public.client_intake_forms set responses=$2::jsonb,revision=999 where id=$1", [id, JSON.stringify({ legal_name: "Forged direct" })]);
    })).rejects.toMatchObject({ code: "42501" });
    const { rows: [row] } = await adminQuery("select revision::text,responses from public.client_intake_forms where id=$1", [id]);
    expect(row).toEqual({ revision: "0", responses: { q: "draft" } });
  });

  it.each(["authenticated", "service_role"] as const)("%s cannot directly change protected draft fields", async (role) => {
    const patches = ["responses='{\"legal_name\":\"Direct\"}'::jsonb", "current_step=2", "submitted_at=now()"];
    for (const patch of patches) {
      const id = await seedIntake(A, "in_progress");
      await expect(asRole(role, async (q) => {
        await q("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: A.userId, role })]);
        return q(`update public.client_intake_forms set ${patch} where id=$1`, [id]);
      })).rejects.toMatchObject({ code: "42501" });
    }
  });

  it.each([
    ["submitted", "in_progress", "42501"], ["reviewed", "in_progress", "42501"],
    ["reviewed", "submitted", "42501"], ["in_progress", "reviewed", "23514"],
  ] as const)("service role cannot reset %s -> %s and re-enter CAS", async (before, after, expectedCode) => {
    const id = await seedIntake(A, before);
    await expect(asRole("service_role", (q) => q(
      "update public.client_intake_forms set status=$2 where id=$1", [id, after],
    ))).rejects.toMatchObject({
      code: expectedCode,
      message: expectedCode === "23514"
        ? "An intake can only be marked reviewed after the client submits it."
        : "Protected intake changes require the governed revision command.",
    });
    const { rows: [row] } = await adminQuery("select status,revision::text,responses from public.client_intake_forms where id=$1", [id]);
    expect(row).toEqual({ status: before, revision: "0", responses: { q: "draft" } });
    if (before !== "in_progress") expect((await write(parameters(id, "0", "save", { q: "Must not reopen" }))).outcome).toBe("terminal");
  });

  it.each(["authenticated", "service_role"] as const)("%s keeps notes/link/no-op status writes and revision invalidation", async (role) => {
    for (const status of ["in_progress", "submitted", "reviewed"] as const) {
      const id = await seedIntake(A, status);
      await asRole(role, async (q) => {
        await q("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: A.userId, role })]);
        const { rows: [row] } = await q("update public.client_intake_forms set practitioner_notes='Allowed note',intake_link_send_count=1,status=$2,revision=999 where id=$1 returning revision::text,responses,status", [id, status]);
        expect(row).toEqual({ revision: "1", responses: { q: "draft" }, status });
      });
    }
  });

  it("wrong studio/client refuses without a revision or a write", async () => {
    const id = await seedIntake(A, "in_progress");
    expect(await write(parameters(id, "0", "save", {}, {}, B.studioId))).toEqual({ outcome: "not_available", new_revision: null });
    expect(await write(parameters(id, "0", "save", {}, {}, A.studioId, B.clientId))).toEqual({ outcome: "not_available", new_revision: null });
    expect((await storedResponses(id)).q).toBe("draft");
  });
  it("only the submit winner appends allergies once and preserves current nonempty profile fields", async () => {
    const id = await seedIntake(A, "in_progress");
    await adminQuery("update public.clients set allergies='Practitioner latest', pronouns='They', emergency_contact_phone='Existing' where id=$1", [A.clientId]);
    const args = parameters(id, "0", "submit", { legal_name: "Submitted" }, { allergy_text: "Intake contribution", pronouns: "Different", emergency_contact_phone: "Different" });
    expect((await write(args)).outcome).toBe("submitted");
    expect((await write(args)).outcome).toBe("terminal");
    const { rows: [client] } = await adminQuery("select allergies,pronouns,emergency_contact_phone from public.clients where id=$1", [A.clientId]);
    expect(client.pronouns).toBe("They"); expect(client.emergency_contact_phone).toBe("Existing");
    expect(client.allergies).toContain("Practitioner latest");
    expect(client.allergies.split("Intake contribution")).toHaveLength(2);
  });
  it("invalid profile date rolls back both the submitted transition and new answers", async () => {
    const id = await seedIntake(A, "in_progress");
    await adminQuery("update public.clients set date_of_birth=null where id=$1", [A.clientId]);
    await expect(write(parameters(id, "0", "submit", { legal_name: "Must rollback" }, { date_of_birth: "not-a-date" }))).rejects.toBeTruthy();
    const { rows: [row] } = await adminQuery("select status,revision::text,submitted_at,responses from public.client_intake_forms where id=$1", [id]);
    expect(row.status).toBe("in_progress"); expect(row.revision).toBe("0"); expect(row.submitted_at).toBeNull(); expect(row.responses.q).toBe("draft");
  });
  it("waits for a concurrent profile edit, then merges the latest locked values", async () => {
    const id = await seedIntake(A, "in_progress");
    let held!: () => void; let release!: () => void; let identified!: () => void;
    const locked = new Promise<void>((r) => { held = r; });
    const unlock = new Promise<void>((r) => { release = r; });
    const pidReady = new Promise<void>((r) => { identified = r; });
    let pid = 0;
    const editor = adminTx(async (q) => {
      await q("update public.clients set allergies='Concurrent practitioner', address='Current address' where id=$1", [A.clientId]);
      held(); await unlock;
    });
    await locked;
    const submit = adminTx(async (q) => {
      await q("set local role service_role"); pid = (await q("select pg_backend_pid() as pid")).rows[0].pid; identified();
      return (await q(command, parameters(id, "0", "submit", {}, { allergy_text: "New intake", address: "Stale address" }))).rows[0];
    });
    await pidReady;
    try {
      await expect.poll(async () => (await adminQuery("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]?.wait_event_type, { timeout: 5000 }).toBe("Lock");
    } finally { release(); }
    await editor;
    expect((await submit).outcome).toBe("submitted");
    const { rows: [client] } = await adminQuery("select allergies,address from public.clients where id=$1", [A.clientId]);
    expect(client.address).toBe("Current address");
    expect(client.allergies).toContain("Concurrent practitioner"); expect(client.allergies).toContain("New intake");
  });
});
