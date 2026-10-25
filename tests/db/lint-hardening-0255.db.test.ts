import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  adminTx,
  closePool,
  seedStudio,
  type SeededStudio,
  type UserQuery,
} from "./helpers/harness";

// 0255 LINT hardening: regression and behaviour proof at the 0255 schema.
// Synthetic studios only. Each describe maps to one part of the migration.

let a: SeededStudio;
let b: SeededStudio;

beforeAll(async () => {
  a = await seedStudio("lint0255a");
  b = await seedStudio("lint0255b");
  for (const s of [a, b]) {
    await adminQuery(
      `insert into public.studio_availability_default (studio_id, day_of_week, is_open, open_time, close_time)
       values ($1, 1, true, '09:00', '17:00')`,
      [s.studioId],
    );
  }
});

afterAll(async () => {
  await closePool();
});

const ROLLBACK = new Error("rollback");
type Ctx = {
  q: UserQuery;
  as: <R>(role: "anon" | "authenticated" | "service_role", userId: string | null, run: (q: UserQuery) => Promise<R>) => Promise<R>;
};
/** One transaction as postgres, always rolled back; `as()` runs a block as a browser role. */
async function sandbox<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  let out!: T;
  try {
    await adminTx(async (q) => {
      const ctx: Ctx = {
        q,
        as: async (role, userId, run) => {
          await q(`set local role ${role}`);
          await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(userId ? { sub: userId, role } : { role })]);
          try {
            return await run(q);
          } finally {
            await q("reset role");
          }
        },
      };
      out = await fn(ctx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return out;
}

/** Run a statement that is expected to fail, inside a savepoint; returns {code, message} or null. */
async function failure(q: UserQuery, sql: string, params: unknown[] = []): Promise<{ code: string; message: string } | null> {
  await q("savepoint probe");
  try {
    await q(sql, params);
    await q("release savepoint probe");
    return null;
  } catch (error) {
    await q("rollback to savepoint probe");
    const e = error as { code?: string; message?: string };
    return { code: e.code ?? "no-code", message: e.message ?? "" };
  }
}

const PINNED_13 = [
  "set_updated_at",
  "reject_payment_consents_mutation",
  "reject_payment_audit_mutation",
  "set_updated_at_now",
  "treatment_plan_stages_set_studio_id",
  "client_personal_notes_set_studio_id",
  "tg_client_portal_messages_set_updated_at",
  "tg_client_portal_message_replies_set_updated_at",
  "tg_consent_form_templates_set_updated_at",
  "tg_client_payment_methods_set_updated_at",
  "payment_charge_attempts_touch_updated_at",
  "enforce_treatment_image_integrity",
  "tg_studio_tracking_providers_set_updated_at",
];
const TRIGGER_FUNCTIONS = [
  "snapshot_appointment_buffer()",
  "handle_new_user()",
  "enforce_appointment_buffer()",
  "guard_scoped_recurring_rule_capacity()",
  "studios_admission_mode_guard()",
];
const PREDICATES = ["is_studio_member(uuid)", "is_studio_owner(uuid)", "session_is_visible(uuid)"];

describe("1. search_path is pinned on the 13 invoker trigger functions", () => {
  it("every one is SECURITY INVOKER with search_path = pg_catalog, pg_temp", async () => {
    const { rows } = await adminQuery(
      `select p.proname, p.prosecdef, p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1)`,
      [PINNED_13],
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([...PINNED_13].sort());
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(false);
      expect(r.proconfig, r.proname).toContain("search_path=pg_catalog, pg_temp");
    }
  });

  it("no SECURITY INVOKER trigger function in public is left without a pinned search_path (new ones fail here)", async () => {
    const { rows } = await adminQuery(
      `select p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f' and not p.prosecdef
          and p.prorettype = 'trigger'::regtype
          and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        order by 1`,
    );
    expect(rows.map((r) => r.proname)).toEqual([]);
  });

  it("the pinned functions still work for a browser role: the studio stamp and updated_at triggers fire", async () => {
    await sandbox(async ({ q, as }) => {
      // BEFORE INSERT client_personal_notes_set_studio_id stamps studio_id from the client
      // (it reads public.clients under the pinned search_path).
      const second = await q(`insert into public.clients (studio_id, name) values ($1, 'Second Client') returning id`, [a.studioId]);
      await as("authenticated", a.userId, (uq) =>
        uq(`insert into public.client_personal_notes (client_id, personal_notes) values ($1, 'first')`, [second.rows[0].id]),
      );
      const stamped = await q(`select studio_id from public.client_personal_notes where client_id = $1`, [second.rows[0].id]);
      expect(stamped.rows[0].studio_id).toBe(a.studioId);

      // BEFORE UPDATE set_updated_at bumps updated_at; the row starts in the year 2000.
      await q(
        `insert into public.client_personal_notes (client_id, studio_id, personal_notes, updated_at) values ($1, $2, 'old', '2000-01-01')`,
        [a.clientId, a.studioId],
      );
      await as("authenticated", a.userId, (uq) =>
        uq(`update public.client_personal_notes set personal_notes = 'new' where client_id = $1`, [a.clientId]),
      );
      const bumped = await q(`select updated_at > '2001-01-01' as moved from public.client_personal_notes where client_id = $1`, [a.clientId]);
      expect(bumped.rows[0].moved).toBe(true);
    });
  });
});

describe("2. trigger functions carry no browser-role or PUBLIC EXECUTE", () => {
  it.each(TRIGGER_FUNCTIONS)("%s: not executable by anon, authenticated or PUBLIC; service_role keeps it", async (sig) => {
    const { rows } = await adminQuery(
      `select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as authenticated,
              has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_role,
              (select count(*) from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE')::int as public_grants`,
      [`public.${sig}`],
    );
    expect(rows[0]).toEqual({ anon: false, authenticated: false, service_role: true, public_grants: 0 });
  });

  it("the appointment buffer trigger still fires for a browser role on the appointments row path it guards (catalog: trigger present and enabled)", async () => {
    const { rows } = await adminQuery(
      `select t.tgname, t.tgenabled from pg_trigger t
        where t.tgrelid = 'public.appointments'::regclass and not t.tgisinternal
          and t.tgname = 'appointments_snapshot_buffer_trg'`,
    );
    expect(rows).toEqual([{ tgname: "appointments_snapshot_buffer_trg", tgenabled: "O" }]);
  });
});

describe("3. RLS predicates: anon cannot execute them, and no anonymous flow depended on that", () => {
  it.each(PREDICATES)("%s: anon and PUBLIC cannot execute; authenticated and service_role can", async (sig) => {
    const { rows } = await adminQuery(
      `select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as authenticated,
              has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_role`,
      [`public.${sig}`],
    );
    expect(rows[0]).toEqual({ anon: false, authenticated: true, service_role: true });
  });

  it("no policy that applies to anon or PUBLIC in public calls a predicate (catalog)", async () => {
    const { rows } = await adminQuery(
      `select c.relname, pol.polname
         from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and (pol.polroles = array[0]::oid[] or (select oid from pg_roles where rolname = 'anon') = any(pol.polroles))
          and lower(coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), ''))
              ~ '(^|[^a-z_])(is_studio_member|is_studio_owner|session_is_visible)\\('
        order by 1, 2`,
    );
    expect(rows).toEqual([]);
  });

  it("every policy that called a predicate is still in force for authenticated (retargeted, not dropped)", async () => {
    const { rows } = await adminQuery(
      `select c.relname, pol.polname
         from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and (select oid from pg_roles where rolname = 'authenticated') = any(pol.polroles)
          and c.relname = any($1)`,
      [["studio_availability_default", "studio_blockouts", "studio_timed_blocks", "payment_charge_attempts", "service_practitioners"]],
    );
    const tables = new Set(rows.map((r) => r.relname));
    for (const t of ["studio_availability_default", "studio_blockouts", "studio_timed_blocks", "payment_charge_attempts", "service_practitioners"]) {
      expect(tables.has(t), t).toBe(true);
    }
  });

  it.each([
    "manual_fee_charge_attempts", "ops_alerts", "payment_charge_attempts", "service_practitioners",
    "studio_availability_default", "studio_availability_overrides", "studio_blockouts",
    "studio_calendar_reservations", "studio_recurring_break_occurrences", "studio_recurring_break_rules", "studio_timed_blocks",
  ])("anon reading %s is unchanged: zero rows, never a function-permission error", async (table) => {
    await sandbox(async ({ as }) => {
      await as("anon", null, async (uq) => {
        const err = await failure(uq, `select count(*)::int n from public.${table}`);
        if (err) {
          expect(err.message).not.toMatch(/function/i);
          expect(err.message).toMatch(/permission denied for table/i);
        } else {
          const { rows } = await uq(`select count(*)::int n from public.${table}`);
          expect(rows[0].n).toBe(0);
        }
      });
    });
  });

  it("positive control: authenticated owners read exactly their own studio's availability, through the predicate", async () => {
    await sandbox(async ({ as }) => {
      const own = await as("authenticated", a.userId, (uq) =>
        uq(`select studio_id from public.studio_availability_default where studio_id = any($1)`, [[a.studioId, b.studioId]]),
      );
      expect(own.rows.map((r) => r.studio_id)).toEqual([a.studioId]);
    });
  });

  it("the predicates still answer correctly for authenticated callers", async () => {
    await sandbox(async ({ as }) => {
      const r = await as("authenticated", a.userId, (uq) =>
        uq(`select public.is_studio_member($1) m, public.is_studio_owner($1) o, public.is_studio_member($2) other`, [a.studioId, b.studioId]),
      );
      expect(r.rows[0]).toEqual({ m: true, o: true, other: false });
    });
  });

  it("anon calling a predicate is now refused (42501), where it used to answer false", async () => {
    await sandbox(async ({ as }) => {
      await as("anon", null, async (uq) => {
        const err = await failure(uq, `select public.is_studio_member($1)`, [a.studioId]);
        expect(err?.code).toBe("42501");
      });
    });
  });
});

describe("4. waitlist and demo_requests are anonymous INSERT-only and validated", () => {
  const WAITLIST = `insert into public.waitlist (email, source) values ($1, $2)`;
  const DEMO = `insert into public.demo_requests (name, email, practice_name, location, practice_type, practitioner_count, current_tool, notes)
                values ($1, $2, 'Synthetic Practice', 'Toronto', 'laser', '2-5', 'paper', 'hello')`;

  it("anon and authenticated can insert a valid row exactly as the server actions do", async () => {
    await sandbox(async ({ q, as }) => {
      for (const [role, user] of [["anon", null], ["authenticated", a.userId]] as const) {
        await as(role, user, async (uq) => {
          expect(await failure(uq, WAITLIST, [`wl-${role}@example.test`, "landing"])).toBeNull();
          expect(await failure(uq, DEMO, [`Name ${role}`, `demo-${role}@example.test`])).toBeNull();
        });
      }
      // Defaults apply before the policy check: status 'new' and source 'landing' with no value supplied.
      await as("anon", null, async (uq) => {
        expect(await failure(uq, `insert into public.waitlist (email) values ('default-source@example.test')`)).toBeNull();
      });
      const rows = await q(`select count(*)::int n from public.waitlist where email like '%@example.test'`);
      expect(rows.rows[0].n).toBe(3);
    });
  });

  it.each(["waitlist", "demo_requests"])("anon and authenticated hold INSERT and nothing else on %s", async (table) => {
    const { rows } = await adminQuery(
      `select r.rolname,
              has_table_privilege(r.rolname, 'public.${table}', 'INSERT') as ins,
              has_table_privilege(r.rolname, 'public.${table}', 'SELECT') as sel,
              has_table_privilege(r.rolname, 'public.${table}', 'UPDATE') as upd,
              has_table_privilege(r.rolname, 'public.${table}', 'DELETE') as del,
              has_table_privilege(r.rolname, 'public.${table}', 'TRUNCATE') as trunc,
              has_any_column_privilege(r.rolname, 'public.${table}', 'SELECT') as colsel
         from pg_roles r where r.rolname in ('anon', 'authenticated') order by 1`,
    );
    for (const r of rows) {
      expect(r, `${r.rolname} on ${table}`).toMatchObject({ ins: true, sel: false, upd: false, del: false, trunc: false, colsel: false });
    }
  });

  it("anonymous SELECT, UPDATE and DELETE are refused at the privilege layer (42501), not by an empty RLS result", async () => {
    await sandbox(async ({ as }) => {
      await as("anon", null, async (uq) => {
        for (const sql of [
          `select email from public.waitlist`,
          `select name from public.demo_requests`,
          `update public.waitlist set practice_name = 'x'`,
          `update public.demo_requests set status = 'contacted'`,
          `delete from public.waitlist`,
          `delete from public.demo_requests`,
        ]) {
          expect((await failure(uq, sql))?.code, sql).toBe("42501");
        }
      });
    });
  });

  it("an insert with RETURNING needs SELECT, so it is refused: the form must stay RETURN-free", async () => {
    await sandbox(async ({ as }) => {
      await as("anon", null, async (uq) => {
        expect((await failure(uq, `insert into public.waitlist (email) values ('returning@example.test') returning id`))?.code).toBe("42501");
      });
    });
  });

  it("service_role (the admin console) still reads and updates both tables", async () => {
    await sandbox(async ({ q, as }) => {
      await q(`insert into public.demo_requests (name, email) values ('Admin Read', 'admin-read@example.test')`);
      const read = await as("service_role", null, (sq) => sq(`select status from public.demo_requests where email = 'admin-read@example.test'`));
      expect(read.rows[0].status).toBe("new");
      const upd = await as("service_role", null, (sq) => sq(`update public.demo_requests set status = 'contacted' where email = 'admin-read@example.test'`));
      expect(upd.rowCount).toBe(1);
      const wl = await as("service_role", null, (sq) => sq(`select count(*)::int n from public.waitlist`));
      expect(typeof wl.rows[0].n).toBe("number");
    });
  });

  it.each([
    ["not an email", "plainaddress"],
    ["whitespace in the local part", "a b@example.test"],
    ["two at-signs", "a@@example.test"],
    ["no dot after the at-sign", "a@example"],
    ["longer than 254", `${"a".repeat(250)}@example.test`],
  ])("a malformed email is refused by the CHECK (23514): %s", async (_label, email) => {
    await sandbox(async ({ as }) => {
      await as("anon", null, async (uq) => {
        expect((await failure(uq, WAITLIST, [email, "landing"]))?.code).toBe("23514");
        expect((await failure(uq, DEMO, ["Name", email]))?.code).toBe("23514");
      });
    });
  });

  it("oversized free text is refused by the CHECK (23514)", async () => {
    await sandbox(async ({ as }) => {
      await as("anon", null, async (uq) => {
        expect((await failure(uq, `insert into public.waitlist (email, practice_name) values ('long@example.test', $1)`, ["p".repeat(301)]))?.code).toBe("23514");
        expect((await failure(uq, `insert into public.demo_requests (name, email, notes) values ('N', 'n@example.test', $1)`, ["n".repeat(5001)]))?.code).toBe("23514");
        expect((await failure(uq, `insert into public.demo_requests (name, email) values ($1, 'n2@example.test')`, ["x".repeat(201)]))?.code).toBe("23514");
        expect((await failure(uq, `insert into public.demo_requests (name, email) values ('', 'n3@example.test')`))?.code).toBe("23514");
      });
    });
  });

  it("the policy, not just the constraints, bounds what a form may write: no foreign source or status", async () => {
    await sandbox(async ({ as }) => {
      await as("anon", null, async (uq) => {
        expect((await failure(uq, WAITLIST, ["policy@example.test", "partner-import"]))?.code).toBe("42501");
        expect((await failure(uq, `insert into public.demo_requests (name, email, status) values ('N', 'p@example.test', 'contacted')`))?.code).toBe("42501");
      });
    });
  });

  it("the constraints are NOT VALID by design (existing rows are not scanned) and still bind new rows", async () => {
    const { rows } = await adminQuery(
      `select conrelid::regclass::text as tbl, conname, convalidated
         from pg_constraint
        where conname in ('waitlist_email_format_chk', 'waitlist_field_length_chk', 'demo_requests_email_format_chk', 'demo_requests_field_length_chk')
        order by conname`,
    );
    expect(rows.map((r) => [r.conname, r.convalidated])).toEqual([
      ["demo_requests_email_format_chk", false],
      ["demo_requests_field_length_chk", false],
      ["waitlist_email_format_chk", false],
      ["waitlist_field_length_chk", false],
    ]);
  });

  it("no insert policy on either table is the literal true any more", async () => {
    const { rows } = await adminQuery(
      `select c.relname, pg_get_expr(pol.polwithcheck, pol.polrelid) as chk
         from pg_policy pol join pg_class c on c.oid = pol.polrelid
        where c.relname in ('waitlist', 'demo_requests') and pol.polcmd = 'a'`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.chk, r.relname).not.toBe("true");
  });
});

describe("5. what 0255 deliberately does not change", () => {
  it("business RPC grants are untouched: a sample of authenticated and service_role commands keeps its EXECUTE", async () => {
    const { rows } = await adminQuery(
      `select has_function_privilege('authenticated', 'public.start_session(uuid, text, uuid, integer, uuid)', 'EXECUTE') as start_session,
              has_function_privilege('authenticated', 'public.record_appointment_settlement(uuid, uuid, text, integer, text, boolean)', 'EXECUTE') as settle,
              has_function_privilege('service_role', 'public.record_client_archive_audit_governed(uuid, uuid, uuid, uuid, boolean, text)', 'EXECUTE') as governed,
              has_function_privilege('anon', 'public.record_client_archive_audit_governed(uuid, uuid, uuid, uuid, boolean, text)', 'EXECUTE') as governed_anon`,
    );
    expect(rows[0]).toEqual({ start_session: true, settle: true, governed: true, governed_anon: false });
  });

  it("btree_gist stays in public and rls_auto_enable is never referenced by the migration", async () => {
    const ext = await adminQuery(`select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'btree_gist'`);
    expect(ext.rows[0].nspname).toBe("public");
  });
});
