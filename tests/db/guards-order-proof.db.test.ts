import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminTx,
  closePool,
  seedStudio,
  type SeededStudio,
  type UserQuery,
} from "./helpers/harness";

// GUARDS-ORDER-PROOF (closes PEER-1153 F3). Runs ONLY inside the rehearsal
// workflow (.github/workflows/guards-order-rehearsal.yml), against a database
// that was built at exactly 0212, had BOTH window guards installed, and then had
// 0213-0246 applied in order. It is skipped everywhere else (the ordinary DB
// lane's database has no guards), and the workflow fails if it did not run.
const ON = process.env.HONE_GUARDS_ORDER_PROOF === "1";
const d = ON ? describe : describe.skip;

let a: SeededStudio;

beforeAll(async () => {
  if (ON) a = await seedStudio("gorder");
});
afterAll(async () => {
  await closePool();
});

const ROLLBACK = new Error("rollback");
type Role = "authenticated" | "service_role";
type Ctx = { q: UserQuery; as: <R>(role: Role, userId: string | null, run: (q: UserQuery) => Promise<R>) => Promise<R> };
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
async function state(q: UserQuery, sql: string, params: unknown[] = []): Promise<string | null> {
  await q("savepoint probe");
  try {
    await q(sql, params);
    await q("release savepoint probe");
    return null;
  } catch (error) {
    await q("rollback to savepoint probe");
    return (error as { code?: string }).code ?? "no-code";
  }
}

const FILE = "hone-export-harness-gorder-2026-10-25.zip";
const GOVERNED = `select public.record_studio_export_audit_governed($1,$2,$3,$4,$5::text[],$6::jsonb) as ok`;
const exportArgs = () => [a.practitionerId, a.userId, a.studioId, FILE, ["clients.csv", "manifest.json", "README.txt"], JSON.stringify({ clients: 1 })];
const count = async (q: UserQuery, where: string) =>
  (await q(`select count(*)::int n from public.audit_logs where studio_id = $1 and ${where}`, [a.studioId])).rows[0].n as number;

d("after 0246 with both window guards installed BEFORE 0213", () => {
  it("the chain really reached 0246 and 0242 is in force (so this is the post-S1 schema)", async () => {
    await sandbox(async ({ q }) => {
      const r = await q(
        `select
           (select count(*)::int from information_schema.columns where table_schema='public' and table_name='client_intake_forms' and column_name='questionnaire_snapshot') as c0246,
           to_regprocedure('public.record_studio_export_audit_governed(uuid,uuid,uuid,text,text[],jsonb)') is not null as governed,
           has_table_privilege('authenticated','public.audit_logs','INSERT') as member_insert`,
      );
      expect(r.rows[0]).toEqual({ c0246: 1, governed: true, member_insert: false });
    });
  });

  it("both guards are still installed: exactly one function and one enabled trigger each", async () => {
    await sandbox(async ({ q }) => {
      const r = await q(
        `select t.tgname, t.tgenabled, t.tgrelid::regclass::text as rel
           from pg_trigger t
          where t.tgname in ('clients_00_pause_archive_trg','audit_logs_00_pause_export_trg') and not t.tgisinternal
          order by t.tgname`,
      );
      expect(r.rows).toEqual([
        { tgname: "audit_logs_00_pause_export_trg", tgenabled: "O", rel: "audit_logs" },
        { tgname: "clients_00_pause_archive_trg", tgenabled: "O", rel: "clients" },
      ]);
      const f = await q(`select count(*)::int n from pg_proc where pronamespace='public'::regnamespace and proname in ('pause_client_archive_guard','pause_studio_export_guard')`);
      expect(f.rows[0].n).toBe(2);
    });
  });

  it("archive is refused (55000) and the client is unchanged", async () => {
    await sandbox(async ({ q, as }) => {
      const c = await as("authenticated", a.userId, (uq) =>
        state(uq, `update public.clients set archived_at = now(), archived_by = $1 where id = $2 and studio_id = $3`, [a.practitionerId, a.clientId, a.studioId]),
      );
      expect(c).toBe("55000");
      expect((await q("select archived_at from public.clients where id = $1", [a.clientId])).rows[0].archived_at).toBeNull();
    });
  });

  it("unarchive is refused (55000) too", async () => {
    await sandbox(async ({ q, as }) => {
      await q("update public.clients set archived_at = now(), archived_by = $1 where id = $2", [a.practitionerId, a.clientId]);
      const c = await as("authenticated", a.userId, (uq) =>
        state(uq, `update public.clients set archived_at = null, archived_by = null where id = $1 and studio_id = $2`, [a.clientId, a.studioId]),
      );
      expect(c).toBe("55000");
      expect((await q("select archived_at from public.clients where id = $1", [a.clientId])).rows[0].archived_at).not.toBeNull();
    });
  });

  it("the governed export command errors (55000) and writes no row; so does a direct service_role insert", async () => {
    await sandbox(async ({ q, as }) => {
      expect(await as("service_role", null, (sq) => state(sq, GOVERNED, exportArgs()))).toBe("55000");
      expect(
        await as("service_role", null, (sq) =>
          state(sq, `insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata) values ($1,$2,'studio_export','studio',$1,'{}'::jsonb)`, [a.studioId, a.practitionerId]),
        ),
      ).toBe("55000");
      expect(await count(q, "action = 'studio_export'")).toBe(0);
    });
  });

  it("the other audit writes still record: the governed archive command and a service_role non-export insert", async () => {
    await sandbox(async ({ q, as }) => {
      const before = await count(q, "true");
      const archive = await as("service_role", null, (sq) =>
        sq("select public.record_client_archive_audit_governed($1,$2,$3,$4,true,$5) as ok", [a.practitionerId, a.userId, a.studioId, a.clientId, new Date().toISOString()]),
      );
      expect(archive.rows[0].ok).toBe(true);
      const direct = await as("service_role", null, (sq) =>
        state(sq, `insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata) values ($1,$2,'client_unarchived','client',$3,'{}'::jsonb)`, [a.studioId, a.practitionerId, a.clientId]),
      );
      expect(direct).toBeNull();
      expect(await count(q, "true")).toBe(before + 2);
    });
  });

  it("owner and service_role writes to the client are not paused (the archive guard is browser-role only)", async () => {
    await sandbox(async ({ q, as }) => {
      const r = await as("service_role", null, (sq) =>
        sq(`update public.clients set archived_at = now(), archived_by = $1 where id = $2 and studio_id = $3`, [a.practitionerId, a.clientId, a.studioId]),
      );
      expect(r.rowCount).toBe(1);
    });
  });
});
