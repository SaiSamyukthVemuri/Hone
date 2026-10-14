import { beforeAll, describe, expect, it } from "vitest";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL } from "@/e2e/helpers/local-env";
import {
  adminQuery,
  asUser,
  seedStudio,
  type SeededStudio,
} from "@/tests/db/helpers/harness";

// ===========================================================================
// Migration 0204 — studio-owned NEW-CLIENT admission mode.
//
// What the migration claims
// -------------------------
// `studios.new_client_admission_mode` ('open' | 'waitlist' | 'closed') is the
// durable authority on whether a studio admits NEW clients. It has exactly one
// supported writer: `set_new_client_admission_mode(p_studio_id, p_mode)`. The
// browser supplies MODE INTENT ONLY; membership, owner role, the actor id and
// the timestamp are all re-derived inside the database.
//
// Two mechanisms carry that claim, and this file exercises both:
//
//   1. the COMMAND re-derives `auth.uid()`, refuses a non-owner, and resolves
//      an ACTIVE OWNER belonging to THIS studio as the audited actor;
//   2. the GUARD (`studios_admission_mode_guard`, BEFORE UPDATE on studios)
//      refuses any update that touches the three admission fields without a
//      transaction-local permit naming THIS studio.
//
// The guard is why an owner cannot simply PATCH the columns: RLS policy
// "studios: owners update" legitimately allows an owner to UPDATE their own
// studio row, so privilege alone does not protect these three fields.
//
// Why there is NO foreign key on the actor column
// -----------------------------------------------
// `new_client_admission_mode_set_by` is a bare `uuid`. A
// `references public.practitioners(id)` would add a SECOND relationship
// between `studios` and `practitioners`, and PostgREST resolves embeds by
// relationship: the fifteen existing `studio:studios(*)` call sites would all
// fail with PGRST201 "Could not embed because more than one relationship was
// found for 'practitioners' and 'studios'". That is exactly what CI run
// 36729106946 reported. The last test in this file is the regression: it
// EXERCISES the embed rather than grepping for the absence of a keyword.
//
// Negative control (run out-of-band, deliberately not committed as a test)
// -----------------------------------------------------------------------
// Adding `tmp_set_by_fk` on the isolated stack and reloading the PostgREST
// schema cache turned the embed below into HTTP 300 / PGRST201 naming both
// constraints, and turned tests/db/treatment-plan-close-authority.db.test.ts
// red with CI's exact message; dropping it restored HTTP 200 and 10/10. The
// control is not committed because it mutates the schema and depends on a
// `notify pgrst, 'reload schema'` race, which would be flaky in CI.
// ===========================================================================

const REST = `${E2E_SUPABASE_URL}/rest/v1`;
const SERVICE_HEADERS = {
  apikey: E2E_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
};

const ADMISSION_COLUMNS = [
  "new_client_admission_mode",
  "new_client_admission_mode_set_at",
  "new_client_admission_mode_set_by",
] as const;

type StoredAdmission = {
  mode: string;
  set_at: string | null;
  set_by: string | null;
};

async function readAdmission(studioId: string): Promise<StoredAdmission> {
  const { rows } = await adminQuery(
    `select new_client_admission_mode        as mode,
            new_client_admission_mode_set_at as set_at,
            new_client_admission_mode_set_by as set_by
       from public.studios
      where id = $1`,
    [studioId],
  );
  expect(rows).toHaveLength(1);
  return rows[0] as StoredAdmission;
}

describe("0204 new-client admission mode — one writer, DB-derived evidence", () => {
  let A: SeededStudio;
  let B: SeededStudio;

  beforeAll(async () => {
    // seedStudio gives one ACTIVE OWNER practitioner backed by a local
    // auth.users row, which is what the command resolves as the actor.
    A = await seedStudio("ncm-admission-a");
    B = await seedStudio("ncm-admission-b");
  });

  // -- the guard: the three fields are unreachable by direct UPDATE ---------
  //
  // Each case runs in its OWN asUser transaction, so no permit armed by an
  // earlier legitimate command can leak into it, and asUser rolls back on
  // throw. Every case reads the row before and after, so it proves "refused
  // AND unchanged" rather than merely "threw".

  for (const column of ADMISSION_COLUMNS) {
    it(`refuses a direct owner PATCH of ${column}`, async () => {
      const before = await readAdmission(A.studioId);

      const value =
        column === "new_client_admission_mode"
          ? "'closed'"
          : column === "new_client_admission_mode_set_at"
            ? "now()"
            : `'${A.practitionerId}'::uuid`;

      await expect(
        asUser(A.userId, (query) =>
          query(
            `update public.studios set ${column} = ${value} where id = $1`,
            [A.studioId],
          ),
        ),
      ).rejects.toThrow(/exactly one writer/);

      expect(await readAdmission(A.studioId)).toEqual(before);
    });
  }

  it("refuses a FORGED combined patch that sets mode, set_at and set_by together", async () => {
    const before = await readAdmission(A.studioId);

    await expect(
      asUser(A.userId, (query) =>
        query(
          `update public.studios
              set new_client_admission_mode        = 'open',
                  new_client_admission_mode_set_at = now(),
                  new_client_admission_mode_set_by = $2
            where id = $1`,
          [A.studioId, A.practitionerId],
        ),
      ),
    ).rejects.toThrow(/exactly one writer/);

    expect(await readAdmission(A.studioId)).toEqual(before);
  });

  it("a studio-A permit cannot mutate studio B", async () => {
    const before = await readAdmission(B.studioId);

    // Run as B's OWN owner, so RLS permits the UPDATE and the only thing
    // standing between the caller and B's admission fields is the guard's
    // permit comparison. The permit names A; the row is B.
    await expect(
      asUser(B.userId, async (query) => {
        await query(
          "select set_config('hone.admission_mode_studio_id', $1, true)",
          [A.studioId],
        );
        return query(
          "update public.studios set new_client_admission_mode = 'closed' where id = $1",
          [B.studioId],
        );
      }),
    ).rejects.toThrow(/exactly one writer/);

    expect(await readAdmission(B.studioId)).toEqual(before);
  });

  it("leaves an ordinary studios UPDATE untouched", async () => {
    const renamed = `ncm guard passthrough ${A.studioId.slice(0, 8)}`;
    const before = await readAdmission(A.studioId);

    const result = await asUser(A.userId, (query) =>
      query("update public.studios set name = $2 where id = $1", [
        A.studioId,
        renamed,
      ]),
    );
    expect(result.rowCount).toBe(1);

    const { rows } = await adminQuery(
      "select name from public.studios where id = $1",
      [A.studioId],
    );
    expect(rows[0].name).toBe(renamed);
    // The guard early-returns when no admission field is distinct, so the
    // audit evidence must be exactly as it was.
    expect(await readAdmission(A.studioId)).toEqual(before);
  });

  // -- the command: the one supported writer -------------------------------

  it("the owner command succeeds and records DB-derived actor and timestamp", async () => {
    const { rows: clock } = await adminQuery("select now() as before");
    const dbBefore = new Date(clock[0].before as string).getTime();

    const result = await asUser(A.userId, (query) =>
      query("select * from public.set_new_client_admission_mode($1, $2)", [
        A.studioId,
        "waitlist",
      ]),
    );

    expect(result.rows).toHaveLength(1);
    const returned = result.rows[0] as {
      outcome: string;
      mode: string;
      set_at: string;
    };
    expect(returned.outcome).toBe("ok");
    expect(returned.mode).toBe("waitlist");

    const stored = await readAdmission(A.studioId);
    expect(stored.mode).toBe("waitlist");

    // ACTOR: the caller never supplied a practitioner id. The command resolved
    // it from auth.uid(), and it must be an ACTIVE OWNER of THIS studio.
    expect(stored.set_by).toBe(A.practitionerId);
    const { rows: actor } = await adminQuery(
      `select studio_id, active, role
         from public.practitioners
        where id = $1`,
      [stored.set_by],
    );
    expect(actor).toHaveLength(1);
    expect(actor[0].studio_id).toBe(A.studioId);
    expect(actor[0].active).toBe(true);
    expect(actor[0].role).toBe("owner");

    // TIMESTAMP: the command takes no timestamp parameter. The stored value is
    // the one it returned, and it sits on the DATABASE clock.
    expect(stored.set_at).not.toBeNull();
    const storedAt = new Date(stored.set_at as string).getTime();
    expect(new Date(returned.set_at).getTime()).toBe(storedAt);
    const { rows: after } = await adminQuery("select now() as now");
    expect(storedAt).toBeGreaterThanOrEqual(dbBefore);
    expect(storedAt).toBeLessThanOrEqual(
      new Date(after[0].now as string).getTime(),
    );
  });

  it("refuses a caller who is not an owner of the target studio", async () => {
    const before = await readAdmission(B.studioId);

    // A's owner is a legitimate owner — of A, not of B.
    const result = await asUser(A.userId, (query) =>
      query("select * from public.set_new_client_admission_mode($1, $2)", [
        B.studioId,
        "closed",
      ]),
    );
    expect(result.rows[0].outcome).toBe("not_authorized");
    expect(result.rows[0].mode).toBeNull();

    expect(await readAdmission(B.studioId)).toEqual(before);
  });

  it("refuses an unknown mode without touching the row", async () => {
    const before = await readAdmission(A.studioId);

    const result = await asUser(A.userId, (query) =>
      query("select * from public.set_new_client_admission_mode($1, $2)", [
        A.studioId,
        "paused",
      ]),
    );
    expect(result.rows[0].outcome).toBe("invalid_mode");

    expect(await readAdmission(A.studioId)).toEqual(before);
  });

  // -- the regression that CI run 36729106946 demanded ---------------------

  it("0204 creates no second practitioners<->studios relationship", async () => {
    const { rows } = await adminQuery(
      `select conname
         from pg_constraint
        where contype = 'f'
          and (   (conrelid = 'public.studios'::regclass
                   and confrelid = 'public.practitioners'::regclass)
               or (conrelid = 'public.practitioners'::regclass
                   and confrelid = 'public.studios'::regclass))
        order by conname`,
    );
    expect(rows.map((r) => r.conname)).toEqual(["practitioners_studio_id_fkey"]);

    // The actor column still exists, and it is still a bare uuid.
    const { rows: col } = await adminQuery(
      `select data_type
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'studios'
          and column_name = 'new_client_admission_mode_set_by'`,
    );
    expect(col).toHaveLength(1);
    expect(col[0].data_type).toBe("uuid");
  });

  it("PostgREST still resolves the studio:studios(*) embed on practitioners", async () => {
    // The exact shape the fifteen existing call sites use. With a second
    // relationship present this returns HTTP 300 / PGRST201 instead.
    const response = await fetch(
      `${REST}/practitioners?select=*,studio:studios(*)&id=eq.${A.practitionerId}`,
      { headers: SERVICE_HEADERS },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{
      id: string;
      studio: { id: string } | null;
    }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].studio?.id).toBe(A.studioId);
  });
});
