import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminTx,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
  type UserQuery,
} from "./helpers/harness";

// EXPORT-PAUSE-GUARD (OPS 1145Z). The #1124 window guard pauses archive and
// unarchive. Export had no database pause: before S1 the OLD app's direct
// audit_logs insert (settings/data/actions.ts:1283 at production 1efb2de9) is
// accepted by the 0001 member INSERT policy, and after S3 the governed command
// accepts it. This file proves the companion guard
// (fixtures/0242-pause-export-guard.up.sql) refuses an export audit row for
// BOTH builds, from `up` until `down`, and that both builds hand the ZIP out
// only AFTER the audit row commits (so a refused audit means no file).
//
// The schema under test is the #1035 chain (0246), where 0242 has already
// revoked the member INSERT. To reproduce the pre-0242 world the OLD app meets
// before S1, the sandbox re-creates the 0001 grant and policy for the duration
// of one rolled-back transaction ("emulate0001"); a control proves the old
// insert succeeds there without the guard, so the refusal is the guard's.
// Synthetic data only. Every probe is rolled back.

let a: SeededStudio;
let aMember: { userId: string; practitionerId: string };

const fixture = (name: string) =>
  readFileSync(path.resolve(__dirname, "fixtures", name), "utf8")
    .split("\n")
    .filter((line) => !/^(begin|commit);$/.test(line.trim()))
    .join("\n");
const EXPORT_UP = fixture("0242-pause-export-guard.up.sql");
const EXPORT_DOWN = fixture("0242-pause-export-guard.down.sql");
const ARCHIVE_UP = fixture("0242-pause-guard.up.sql");

beforeAll(async () => {
  a = await seedStudio("exporta");
  aMember = await seedMember(a, "exporta-member");
});

afterAll(async () => {
  await closePool();
});

const ROLLBACK = new Error("rollback");
type Role = "authenticated" | "service_role";
type Ctx = {
  q: UserQuery;
  as: <R>(role: Role, userId: string | null, run: (q: UserQuery) => Promise<R>) => Promise<R>;
};

async function sandbox<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  let out!: T;
  try {
    await adminTx(async (q) => {
      const ctx: Ctx = {
        q,
        as: async (role, userId, run) => {
          await q(`set local role ${role}`);
          await q("select set_config('request.jwt.claims', $1, true)", [
            JSON.stringify(userId ? { sub: userId, role } : { role }),
          ]);
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

/** SQLSTATE of a statement run inside a savepoint (null on success); the statement's effects are kept on success. */
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

/** The 0001 world: member INSERT on audit_logs with the 0001 policy shape. */
async function emulate0001(q: UserQuery): Promise<void> {
  await q("grant insert on table public.audit_logs to authenticated");
  await q(
    `create policy "emulate0001_members_insert" on public.audit_logs
       for insert to authenticated with check (public.is_studio_member(studio_id))`,
  );
}

const exportRows = async (q: UserQuery) =>
  (await q("select count(*)::int n from public.audit_logs where studio_id = $1 and action = 'studio_export'", [a.studioId])).rows[0].n as number;
const allRows = async (q: UserQuery) =>
  (await q("select count(*)::int n from public.audit_logs where studio_id = $1", [a.studioId])).rows[0].n as number;

// The OLD app's statement, as production 1efb2de9 sends it.
const OLD_EXPORT_INSERT = `insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
  values ($1, $2, 'studio_export', 'studio', $1, $3)`;
const OLD_EXPORT_META = JSON.stringify({ filename: "hone-export-harness-exporta-2026-10-25.zip", files: ["clients.csv", "manifest.json", "README.txt"], row_counts: { clients: 1 } });
const FILE = "hone-export-harness-exporta-2026-10-25.zip";
const GOVERNED = `select public.record_studio_export_audit_governed($1,$2,$3,$4,$5::text[],$6::jsonb) as ok`;
const governedArgs = (actor: string, user: string) => [
  actor, user, a.studioId, FILE, ["clients.csv", "manifest.json", "README.txt"], JSON.stringify({ clients: 1 }),
];
const OLD_ARCHIVE_UPDATE = `update public.clients set archived_at = $1, archived_by = $2
                             where id = $3 and studio_id = $4 and archived_at is null`;

describe("A. controls: without the guard both builds' export audit succeeds", () => {
  it("B-OLD (emulated 0001 grant+policy): the owner's direct studio_export insert is accepted", async () => {
    await sandbox(async ({ q, as }) => {
      await emulate0001(q);
      const c = await as("authenticated", a.userId, (uq) => state(uq, OLD_EXPORT_INSERT, [a.studioId, a.practitionerId, OLD_EXPORT_META]));
      expect(c).toBeNull();
      expect(await exportRows(q)).toBe(1);
    });
  });

  it("B-1035: the governed command returns true and writes exactly one row", async () => {
    await sandbox(async ({ q, as }) => {
      const ok = await as("service_role", null, (sq) => sq(GOVERNED, governedArgs(a.practitionerId, a.userId)));
      expect(ok.rows[0].ok).toBe(true);
      expect(await exportRows(q)).toBe(1);
    });
  });
});

describe("B. with the export guard UP, export is refused for both builds and nothing is written", () => {
  it("B-OLD: the direct browser-role insert is refused with 55000 (owner and member), no row", async () => {
    await sandbox(async ({ q, as }) => {
      await emulate0001(q);
      await q(EXPORT_UP);
      for (const [userId, actor] of [
        [a.userId, a.practitionerId],
        [aMember.userId, aMember.practitionerId],
      ] as const) {
        const c = await as("authenticated", userId, (uq) => state(uq, OLD_EXPORT_INSERT, [a.studioId, actor, OLD_EXPORT_META]));
        expect(c).toBe("55000");
      }
      expect(await exportRows(q)).toBe(0);
    });
  });

  it("B-1035: the governed command errors with 55000 instead of returning true, no row", async () => {
    await sandbox(async ({ q, as }) => {
      await q(EXPORT_UP);
      const c = await as("service_role", null, (sq) => state(sq, GOVERNED, governedArgs(a.practitionerId, a.userId)));
      expect(c).toBe("55000");
      expect(await exportRows(q)).toBe(0);
    });
  });

  it("the refusal is unconditional: service_role and the table owner cannot insert a studio_export row either", async () => {
    await sandbox(async ({ q, as }) => {
      await q(EXPORT_UP);
      expect(await as("service_role", null, (sq) => state(sq, OLD_EXPORT_INSERT, [a.studioId, a.practitionerId, OLD_EXPORT_META]))).toBe("55000");
      expect(await state(q, OLD_EXPORT_INSERT, [a.studioId, a.practitionerId, OLD_EXPORT_META])).toBe("55000");
      expect(await exportRows(q)).toBe(0);
    });
  });

  it("under 0242 itself (no emulation) the old insert is still refused first by the ACL (42501), guard or not", async () => {
    await sandbox(async ({ q, as }) => {
      await q(EXPORT_UP);
      const c = await as("authenticated", a.userId, (uq) => state(uq, OLD_EXPORT_INSERT, [a.studioId, a.practitionerId, OLD_EXPORT_META]));
      expect(c).toBe("42501");
    });
  });

  it("nothing else is refused: other audit actions still record, through the old policy and the governed archive command", async () => {
    await sandbox(async ({ q, as }) => {
      await emulate0001(q);
      await q(EXPORT_UP);
      const before = await allRows(q);
      const other = await as("authenticated", a.userId, (uq) =>
        state(
          uq,
          `insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
           values ($1, $2, 'client_unarchived', 'client', $3, '{}'::jsonb)`,
          [a.studioId, a.practitionerId, a.clientId],
        ),
      );
      expect(other).toBeNull();
      const archive = await as("service_role", null, (sq) =>
        sq("select public.record_client_archive_audit_governed($1,$2,$3,$4,true,$5) as ok", [a.practitionerId, a.userId, a.studioId, a.clientId, new Date().toISOString()]),
      );
      expect(archive.rows[0].ok).toBe(true);
      expect(await allRows(q)).toBe(before + 2);
      expect(await exportRows(q)).toBe(0);
    });
  });

  it("with BOTH guards up, archive and unarchive are still refused and export is still refused", async () => {
    await sandbox(async ({ q, as }) => {
      await emulate0001(q);
      await q(ARCHIVE_UP);
      await q(EXPORT_UP);
      const archive = await as("authenticated", a.userId, (uq) =>
        state(uq, OLD_ARCHIVE_UPDATE, [new Date().toISOString(), a.practitionerId, a.clientId, a.studioId]),
      );
      expect(archive).toBe("55000");
      expect(await as("authenticated", a.userId, (uq) => state(uq, OLD_EXPORT_INSERT, [a.studioId, a.practitionerId, OLD_EXPORT_META]))).toBe("55000");
      expect(await as("service_role", null, (sq) => state(sq, GOVERNED, governedArgs(a.practitionerId, a.userId)))).toBe("55000");
      expect(await exportRows(q)).toBe(0);
      expect((await q("select archived_at from public.clients where id = $1", [a.clientId])).rows[0].archived_at).toBeNull();
    });
  });
});

describe("C. down restores both builds", () => {
  it("after UP then DOWN the old insert (emulated 0001) and the governed command both succeed again", async () => {
    await sandbox(async ({ q, as }) => {
      await emulate0001(q);
      await q(EXPORT_UP);
      await q(EXPORT_DOWN);
      expect(await as("authenticated", a.userId, (uq) => state(uq, OLD_EXPORT_INSERT, [a.studioId, a.practitionerId, OLD_EXPORT_META]))).toBeNull();
      const ok = await as("service_role", null, (sq) => sq(GOVERNED, governedArgs(a.practitionerId, a.userId)));
      expect(ok.rows[0].ok).toBe(true);
      expect(await exportRows(q)).toBe(2);
    });
  });
});

const COUNTS = `
  select
    (select count(*)::int from pg_proc where proname = 'pause_studio_export_guard' and pronamespace = 'public'::regnamespace) as fn,
    (select count(*)::int from pg_trigger where tgname = 'audit_logs_00_pause_export_trg' and not tgisinternal) as trg`;
const CATALOG = `
  select
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public') as funcs,
    (select count(*)::int from pg_trigger t where t.tgrelid = 'public.audit_logs'::regclass and not t.tgisinternal) as triggers,
    (select coalesce(c.relacl::text, '') from pg_class c where c.oid = 'public.audit_logs'::regclass) as audit_acl,
    (select count(*)::int from pg_policy where polrelid = 'public.audit_logs'::regclass) as policies,
    (select count(*)::int from pg_class c where c.relnamespace = 'public'::regnamespace) as relations,
    (select count(*)::int from pg_constraint where conrelid = 'public.audit_logs'::regclass) as constraints,
    (select count(*)::int from pg_trigger t where t.tgrelid = 'public.clients'::regclass and not t.tgisinternal) as client_triggers`;

describe("D. idempotent, and it changes nothing else (catalog-asserted)", () => {
  it("UP twice, DOWN twice, UP again: each step succeeds and leaves exactly 0 or 1 of each object", async () => {
    await sandbox(async ({ q }) => {
      const counts = async () => (await q(COUNTS)).rows[0];
      expect(await counts()).toEqual({ fn: 0, trg: 0 });
      await q(EXPORT_UP);
      expect(await counts()).toEqual({ fn: 1, trg: 1 });
      await q(EXPORT_UP);
      expect(await counts()).toEqual({ fn: 1, trg: 1 });
      await q(EXPORT_DOWN);
      expect(await counts()).toEqual({ fn: 0, trg: 0 });
      await q(EXPORT_DOWN);
      expect(await counts()).toEqual({ fn: 0, trg: 0 });
      await q(EXPORT_UP);
      expect(await counts()).toEqual({ fn: 1, trg: 1 });
    });
  });

  it("the function is INVOKER, search_path pinned, trigger-returning, with no EXECUTE for PUBLIC, anon, authenticated or service_role", async () => {
    await sandbox(async ({ q }) => {
      await q(EXPORT_UP);
      const fn = await q(
        `select p.prosecdef, p.proconfig, p.prorettype::regtype::text as ret, l.lanname,
                has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
                (select count(*)::int from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where a.privilege_type = 'EXECUTE' and a.grantee = 0) as public_grants,
                (select count(*)::int from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner) as non_owner_grants
           from pg_proc p join pg_language l on l.oid = p.prolang
          where p.proname = 'pause_studio_export_guard' and p.pronamespace = 'public'::regnamespace`,
      );
      expect(fn.rows).toHaveLength(1);
      expect(fn.rows[0]).toMatchObject({
        prosecdef: false, ret: "trigger", lanname: "plpgsql",
        anon: false, authenticated: false, service_role: false, public_grants: 0, non_owner_grants: 0,
      });
      expect(fn.rows[0].proconfig).toContain('search_path=""');
    });
  });

  it("the trigger is exactly one: BEFORE INSERT, FOR EACH ROW, WHEN action = 'studio_export', enabled, on audit_logs", async () => {
    await sandbox(async ({ q }) => {
      await q(EXPORT_UP);
      const t = await q(
        `select t.tgtype, t.tgenabled, t.tgrelid::regclass::text as rel, pg_get_triggerdef(t.oid) as def
           from pg_trigger t where t.tgname = 'audit_logs_00_pause_export_trg' and not t.tgisinternal`,
      );
      expect(t.rows).toHaveLength(1);
      expect(t.rows[0].rel).toBe("audit_logs");
      expect(t.rows[0].tgenabled).toBe("O");
      // bit 0 ROW, bit 1 BEFORE (0 would be AFTER), bit 2 INSERT
      expect(t.rows[0].tgtype & 1).toBe(1);
      expect(t.rows[0].tgtype & 2).toBe(2);
      expect(t.rows[0].tgtype & 4).toBe(4);
      expect(t.rows[0].tgtype & (8 | 16 | 32 | 64)).toBe(0);
      expect(t.rows[0].def).toMatch(/WHEN \(.*new\.action.*'studio_export'/s);
    });
  });

  it("catalog identity: UP adds exactly one function and one audit_logs trigger; UP then DOWN restores everything else", async () => {
    await sandbox(async ({ q }) => {
      const before = (await q(CATALOG)).rows[0];
      await q(EXPORT_UP);
      const during = (await q(CATALOG)).rows[0];
      expect(during).toEqual({ ...before, funcs: before.funcs + 1, triggers: before.triggers + 1 });
      await q(EXPORT_DOWN);
      expect((await q(CATALOG)).rows[0]).toEqual(before);
    });
  });

  it("the trigger runs before the table's other insert triggers (name sorts first)", async () => {
    await sandbox(async ({ q }) => {
      await q(EXPORT_UP);
      const names = (
        await q(`select tgname from pg_trigger where tgrelid = 'public.audit_logs'::regclass and not tgisinternal and (tgtype & 4) = 4 and (tgtype & 2) = 2 order by tgname`)
      ).rows.map((r) => r.tgname as string);
      expect(names[0]).toBe("audit_logs_00_pause_export_trg");
    });
  });
});

describe("E. no file without a committed audit row (source order, both builds)", () => {
  const section = (source: string, from: string) => source.slice(source.indexOf(from));

  it("B-1035: exportStudioDataAction returns the base64 file only after a failed recordStudioExportAudit has returned ok:false", () => {
    const src = readFileSync(path.resolve(__dirname, "../../app/(app)/settings/data/actions.ts"), "utf8");
    const tail = section(src, "await recordStudioExportAudit(");
    const refuse = tail.indexOf("if (auditError)");
    const hand = tail.indexOf("return { ok: true, filename, base64 }");
    expect(refuse).toBeGreaterThan(0);
    expect(hand).toBeGreaterThan(refuse);
    expect(tail.slice(refuse, hand)).toMatch(/return\s*\{\s*ok:\s*false/);
  });

  it("B-1035: recordStudioExportAudit refuses on any rpc error or a non-true result", () => {
    const src = readFileSync(path.resolve(__dirname, "../../lib/audit/governed-writes.ts"), "utf8");
    expect(src).toMatch(/return error \|\| recorded !== true \? refused\(\) : \{ error: null \}/);
  });

  it("the guard survives the chain it is installed before: no migration 0213-0246 drops, disables, renames or truncates audit_logs triggers or the table", () => {
    const dir = path.resolve(__dirname, "../../supabase/migrations");
    const hits: string[] = [];
    for (const file of readdirSync(dir)) {
      const n = Number.parseInt(file.slice(0, 4), 10);
      if (!(n >= 213 && n <= 246)) continue;
      const text = readFileSync(path.join(dir, file), "utf8");
      if (/(drop\s+trigger[^;]*on\s+(public\.)?audit_logs|alter\s+table\s+(public\.)?audit_logs[^;]*(disable|rename|drop)|drop\s+table[^;]*audit_logs|truncate[^;]*audit_logs)/i.test(text)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });
});
