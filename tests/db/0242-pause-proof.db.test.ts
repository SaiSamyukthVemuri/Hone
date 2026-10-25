import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminTx,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
  type UserQuery,
} from "./helpers/harness";

// 0242-PAUSE-PROOF (OPS decision 2: no bridge). Between the S1 commit (0213-0246
// applied, member INSERT on audit_logs revoked by 0242) and S3 READY (the new
// app serving), the OLD app is still live. This file runs at the #1035 schema
// with synthetic studios and proves, for the three writes, what 0242 itself
// refuses, what the old caller then does, and what a window-scoped guard adds.
//
// The old statements below are copied from production 1efb2de9:
//   app/(app)/clients/[id]/actions.ts  archiveClientAction / unarchiveClientAction
//     (client UPDATE first, then audit_logs INSERT; an audit error is only LOGGED)
//   app/(app)/settings/data/actions.ts exportStudioDataAction
//     (audit_logs INSERT; an audit error returns ok:false and no file is handed out)

let a: SeededStudio;
let b: SeededStudio;
let aMember: { userId: string; practitionerId: string };

const fixture = (name: string) =>
  readFileSync(path.resolve(__dirname, "fixtures", name), "utf8")
    .split("\n")
    .filter((line) => !/^(begin|commit);$/.test(line.trim()))
    .join("\n");
const GUARD_UP = fixture("0242-pause-guard.up.sql");
const GUARD_DOWN = fixture("0242-pause-guard.down.sql");

beforeAll(async () => {
  a = await seedStudio("pausea");
  b = await seedStudio("pauseb");
  aMember = await seedMember(a, "pausea-member");
});

afterAll(async () => {
  await closePool();
});

const ROLLBACK = new Error("rollback");

/** One transaction as postgres that is always rolled back; `as()` switches to a browser role. */
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
type Ctx = {
  q: UserQuery;
  as: <R>(role: "authenticated" | "service_role", userId: string | null, run: (q: UserQuery) => Promise<R>) => Promise<R>;
};

async function code(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "no-code";
  }
}

async function auditCount(q: UserQuery, studioId: string): Promise<number> {
  return (await q("select count(*)::int n from public.audit_logs where studio_id = $1", [studioId])).rows[0].n;
}

async function archivedAt(q: UserQuery, clientId: string): Promise<string | null> {
  return (await q("select archived_at from public.clients where id = $1", [clientId])).rows[0].archived_at;
}

const ARCHIVE_ROW = (s: SeededStudio, ts: string) => [s.studioId, s.practitionerId, "client_archived", "client", s.clientId, { archived_at: ts }];
const INSERT_AUDIT = `insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
                      values ($1, $2, $3, $4, $5, $6)`;
const OLD_ARCHIVE_UPDATE = `update public.clients set archived_at = $1, archived_by = $2
                             where id = $3 and studio_id = $4 and archived_at is null`;
const OLD_UNARCHIVE_UPDATE = `update public.clients set archived_at = null, archived_by = null
                               where id = $1 and studio_id = $2 and archived_at is not null`;

describe("A. OLD app against the 0246 schema, no guard", () => {
  it("every old audit INSERT shape is refused for a studio owner (42501): archive, unarchive and export", async () => {
    const ts = new Date().toISOString();
    const rows: unknown[][] = [
      ARCHIVE_ROW(a, ts),
      [a.studioId, a.practitionerId, "client_unarchived", "client", a.clientId, {}],
      [a.studioId, a.practitionerId, "studio_export", "studio", a.studioId, { filename: "x.zip", files: ["manifest.json"], row_counts: {} }],
    ];
    for (const params of rows) {
      const refused = await code(() => asUser(a.userId, (q) => q(INSERT_AUDIT, params)));
      expect(refused, String(params[2])).toBe("42501");
    }
  });

  it("CHARACTERIZATION: archive still COMMITS the client change while its audit row is refused and lost", async () => {
    await sandbox(async ({ q, as }) => {
      const before = await auditCount(q, a.studioId);
      const ts = new Date().toISOString();
      const updated = await as("authenticated", a.userId, (uq) => uq(OLD_ARCHIVE_UPDATE, [ts, a.practitionerId, a.clientId, a.studioId]));
      expect(updated.rowCount).toBe(1);
      const audit = await as("authenticated", a.userId, async (uq) => {
        await uq("savepoint s");
        const c = await code(() => uq(INSERT_AUDIT, ARCHIVE_ROW(a, ts)));
        await uq("rollback to savepoint s");
        return c;
      });
      expect(audit).toBe("42501");
      expect(await archivedAt(q, a.clientId)).not.toBeNull();
      expect(await auditCount(q, a.studioId)).toBe(before); // archived, no audit row
    });
  });

  it("CHARACTERIZATION: unarchive commits and loses its audit row the same way", async () => {
    await sandbox(async ({ q, as }) => {
      await q("update public.clients set archived_at = now(), archived_by = $2 where id = $1", [a.clientId, a.practitionerId]);
      const before = await auditCount(q, a.studioId);
      const updated = await as("authenticated", a.userId, (uq) => uq(OLD_UNARCHIVE_UPDATE, [a.clientId, a.studioId]));
      expect(updated.rowCount).toBe(1);
      expect(await archivedAt(q, a.clientId)).toBeNull();
      expect(await auditCount(q, a.studioId)).toBe(before);
    });
  });
});

describe("B. OLD app against the 0246 schema WITH the window guard", () => {
  it("archive is refused (55000): client unchanged, no audit row", async () => {
    await sandbox(async ({ q, as }) => {
      await q(GUARD_UP);
      const before = await auditCount(q, a.studioId);
      const state = await as("authenticated", a.userId, async (uq) => {
        await uq("savepoint s");
        const c = await code(() => uq(OLD_ARCHIVE_UPDATE, [new Date().toISOString(), a.practitionerId, a.clientId, a.studioId]));
        await uq("rollback to savepoint s");
        return c;
      });
      expect(state).toBe("55000");
      expect(await archivedAt(q, a.clientId)).toBeNull();
      expect(await auditCount(q, a.studioId)).toBe(before);
    });
  });

  it("unarchive is refused (55000): the client stays archived", async () => {
    await sandbox(async ({ q, as }) => {
      await q("update public.clients set archived_at = now(), archived_by = $2 where id = $1", [a.clientId, a.practitionerId]);
      await q(GUARD_UP);
      const state = await as("authenticated", a.userId, async (uq) => {
        await uq("savepoint s");
        const c = await code(() => uq(OLD_UNARCHIVE_UPDATE, [a.clientId, a.studioId]));
        await uq("rollback to savepoint s");
        return c;
      });
      expect(state).toBe("55000");
      expect(await archivedAt(q, a.clientId)).not.toBeNull();
    });
  });

  it("a non-owner member is refused too, and so is a direct API update of either column", async () => {
    await sandbox(async ({ q, as }) => {
      await q(GUARD_UP);
      for (const sql of [
        "update public.clients set archived_at = now() where id = $1",
        "update public.clients set archived_by = $2 where id = $1",
      ]) {
        const state = await as("authenticated", aMember.userId, async (uq) => {
          await uq("savepoint s");
          const c = await code(() => uq(sql, sql.includes("$2") ? [a.clientId, aMember.practitionerId] : [a.clientId]));
          await uq("rollback to savepoint s");
          return c;
        });
        expect(state, sql).toBe("55000");
      }
    });
  });

  it("does not touch other client edits, other studios, owner/service/migration writes", async () => {
    await sandbox(async ({ q, as }) => {
      await q(GUARD_UP);
      const edit = await as("authenticated", a.userId, (uq) => uq("update public.clients set name = 'Renamed' where id = $1", [a.clientId]));
      expect(edit.rowCount).toBe(1);
      // postgres (migrations, repair scripts) and service_role are not browser roles
      await q("update public.clients set archived_at = now() where id = $1", [b.clientId]);
      expect(await archivedAt(q, b.clientId)).not.toBeNull();
      await as("service_role", null, (sq) => sq("update public.clients set archived_at = null where id = $1", [b.clientId]));
      expect(await archivedAt(q, b.clientId)).toBeNull();
    });
  });

  it("export stays refused by 0242 itself, guard or not", async () => {
    await sandbox(async ({ q, as }) => {
      await q(GUARD_UP);
      const state = await as("authenticated", a.userId, async (uq) => {
        await uq("savepoint s");
        const c = await code(() =>
          uq(INSERT_AUDIT, [a.studioId, a.practitionerId, "studio_export", "studio", a.studioId, { filename: "x.zip", files: ["manifest.json"], row_counts: {} }]),
        );
        await uq("rollback to savepoint s");
        return c;
      });
      expect(state).toBe("42501");
    });
  });

  it("lifting the guard (down) restores archive for the new app's user-scoped UPDATE", async () => {
    await sandbox(async ({ q, as }) => {
      await q(GUARD_UP);
      await q(GUARD_DOWN);
      const updated = await as("authenticated", a.userId, (uq) =>
        uq(OLD_ARCHIVE_UPDATE, [new Date().toISOString(), a.practitionerId, a.clientId, a.studioId]),
      );
      expect(updated.rowCount).toBe(1);
      const left = await q("select count(*)::int n from pg_trigger where tgname = 'clients_00_pause_archive_trg'");
      expect(left.rows[0].n).toBe(0);
    });
  });
});

describe("C. NEW app (S3) writes against the 0246 schema: the governed commands", () => {
  const FILE = "hone-export-harness-pausea-2026-10-25.zip";

  it("archive and unarchive each record exactly one row, through service_role only", async () => {
    await sandbox(async ({ q, as }) => {
      const before = await auditCount(q, a.studioId);
      const ts = new Date().toISOString();
      const ok = await as("service_role", null, (sq) =>
        sq("select public.record_client_archive_audit_governed($1,$2,$3,$4,true,$5) as ok", [a.practitionerId, a.userId, a.studioId, a.clientId, ts]),
      );
      expect(ok.rows[0].ok).toBe(true);
      const ok2 = await as("service_role", null, (sq) =>
        sq("select public.record_client_archive_audit_governed($1,$2,$3,$4,false,null) as ok", [a.practitionerId, a.userId, a.studioId, a.clientId]),
      );
      expect(ok2.rows[0].ok).toBe(true);
      expect(await auditCount(q, a.studioId)).toBe(before + 2);
      const rows = await q("select action, metadata from public.audit_logs where studio_id=$1 and entity_id=$2 order by created_at, action", [a.studioId, a.clientId]);
      expect(rows.rows.map((r) => r.action).sort()).toEqual(["client_archived", "client_unarchived"]);
    });
  });

  it("refuses with false and writes nothing: cross-studio client, forged actor, or a browser role", async () => {
    await sandbox(async ({ q, as }) => {
      const before = await auditCount(q, a.studioId);
      const ts = new Date().toISOString();
      const cross = await as("service_role", null, (sq) =>
        sq("select public.record_client_archive_audit_governed($1,$2,$3,$4,true,$5) as ok", [a.practitionerId, a.userId, a.studioId, b.clientId, ts]),
      );
      expect(cross.rows[0].ok).toBe(false);
      const forged = await as("service_role", null, (sq) =>
        sq("select public.record_client_archive_audit_governed($1,$2,$3,$4,true,$5) as ok", [a.practitionerId, b.userId, a.studioId, a.clientId, ts]),
      );
      expect(forged.rows[0].ok).toBe(false);
      expect(await auditCount(q, a.studioId)).toBe(before);
      const browser = await code(() =>
        as("authenticated", a.userId, async (uq) => {
          await uq("savepoint s");
          try {
            await uq("select public.record_client_archive_audit_governed($1,$2,$3,$4,true,$5)", [a.practitionerId, a.userId, a.studioId, a.clientId, ts]);
          } finally {
            await uq("rollback to savepoint s");
          }
        }),
      );
      expect(browser).toBe("42501");
    });
  });

  it("export is recorded for the owner only, with a studio-bound filename", async () => {
    await sandbox(async ({ q, as }) => {
      const before = await auditCount(q, a.studioId);
      const call = (actor: string, user: string, filename: string) =>
        as("service_role", null, (sq) =>
          sq("select public.record_studio_export_audit_governed($1,$2,$3,$4,$5::text[],$6::jsonb) as ok", [
            actor, user, a.studioId, filename, ["clients.csv", "manifest.json", "README.txt"], JSON.stringify({ clients: 1 }),
          ]),
        );
      expect((await call(a.practitionerId, a.userId, FILE)).rows[0].ok).toBe(true);
      expect((await call(aMember.practitionerId, aMember.userId, FILE)).rows[0].ok).toBe(false); // not an owner
      expect((await call(a.practitionerId, a.userId, "hone-export-other-2026-10-25.zip")).rows[0].ok).toBe(false);
      expect(await auditCount(q, a.studioId)).toBe(before + 1);
    });
  });
});

// Privacy PEER-1124 F1-F3: idempotent UP/DOWN, catalog assertions, new-app ordering.
const CATALOG = `
  select
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public') as funcs,
    (select count(*)::int from pg_trigger t where t.tgrelid = 'public.clients'::regclass and not t.tgisinternal) as triggers,
    (select coalesce(c.relacl::text, '') from pg_class c where c.oid = 'public.clients'::regclass) as clients_acl,
    (select count(*)::int from pg_policy where polrelid = 'public.clients'::regclass) as policies,
    (select count(*)::int from pg_class c where c.relnamespace = 'public'::regnamespace) as relations,
    (select count(*)::int from pg_constraint where conrelid = 'public.clients'::regclass) as constraints`;
const GUARD_COUNTS = `
  select
    (select count(*)::int from pg_proc where proname = 'pause_client_archive_guard' and pronamespace = 'public'::regnamespace) as fn,
    (select count(*)::int from pg_trigger where tgname = 'clients_00_pause_archive_trg' and not tgisinternal) as trg`;

describe("D. the guard scripts are idempotent and change nothing else (PEER-1124 F1, F2)", () => {
  it("UP twice, DOWN twice, UP again: each step succeeds and leaves exactly 0 or 1 of each object", async () => {
    await sandbox(async ({ q }) => {
      const counts = async () => (await q(GUARD_COUNTS)).rows[0];
      expect(await counts()).toEqual({ fn: 0, trg: 0 });
      await q(GUARD_UP);
      expect(await counts()).toEqual({ fn: 1, trg: 1 });
      await q(GUARD_UP);
      expect(await counts()).toEqual({ fn: 1, trg: 1 });
      await q(GUARD_DOWN);
      expect(await counts()).toEqual({ fn: 0, trg: 0 });
      await q(GUARD_DOWN);
      expect(await counts()).toEqual({ fn: 0, trg: 0 });
      await q(GUARD_UP);
      expect(await counts()).toEqual({ fn: 1, trg: 1 });
    });
  });

  it("after UP the function is INVOKER, search_path pinned, with no EXECUTE for PUBLIC, anon, authenticated or service_role", async () => {
    await sandbox(async ({ q }) => {
      await q(GUARD_UP);
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
          where p.proname = 'pause_client_archive_guard' and p.pronamespace = 'public'::regnamespace`,
      );
      expect(fn.rows).toHaveLength(1);
      expect(fn.rows[0]).toMatchObject({
        prosecdef: false,
        ret: "trigger",
        lanname: "plpgsql",
        anon: false,
        authenticated: false,
        service_role: false,
        public_grants: 0,
        non_owner_grants: 0,
      });
      expect(fn.rows[0].proconfig).toContain('search_path=""');
    });
  });

  it("after UP there is exactly one such trigger: BEFORE UPDATE, FOR EACH ROW, on archived_at and archived_by only, enabled", async () => {
    await sandbox(async ({ q }) => {
      await q(GUARD_UP);
      const t = await q(
        `select t.tgname, t.tgenabled,
                (t.tgtype & 1) = 1 as for_each_row,
                (t.tgtype & 2) = 2 as before,
                (t.tgtype & 16) = 16 as on_update,
                (t.tgtype & (4 | 8 | 32 | 64)) = 0 as only_update,
                (select array_agg(a.attname::text order by a.attname) from pg_attribute a
                  where a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])) as columns
           from pg_trigger t
          where t.tgrelid = 'public.clients'::regclass and not t.tgisinternal
            and t.tgfoid = 'public.pause_client_archive_guard'::regproc`,
      );
      expect(t.rows).toEqual([
        {
          tgname: "clients_00_pause_archive_trg",
          tgenabled: "O",
          for_each_row: true,
          before: true,
          on_update: true,
          only_update: true,
          columns: ["archived_at", "archived_by"],
        },
      ]);
    });
  });

  it("catalog identity: UP adds exactly one function and one trigger; UP then DOWN restores everything else", async () => {
    await sandbox(async ({ q }) => {
      const before = (await q(CATALOG)).rows[0];
      await q(GUARD_UP);
      const during = (await q(CATALOG)).rows[0];
      expect(during).toEqual({ ...before, funcs: before.funcs + 1, triggers: before.triggers + 1 });
      await q(GUARD_DOWN);
      expect((await q(CATALOG)).rows[0]).toEqual(before);
    });
  });

  it("an UPDATE that SETs archived_at or archived_by to the value it already has is not refused", async () => {
    await sandbox(async ({ q, as }) => {
      await q(GUARD_UP);
      const same = await as("authenticated", a.userId, (uq) =>
        uq("update public.clients set archived_at = archived_at, archived_by = archived_by where id = $1", [a.clientId]),
      );
      expect(same.rowCount).toBe(1);
      await q("update public.clients set archived_at = now(), archived_by = $2 where id = $1", [a.clientId, a.practitionerId]);
      const sameArchived = await as("authenticated", a.userId, (uq) =>
        uq("update public.clients set archived_at = archived_at, archived_by = archived_by where id = $1", [a.clientId]),
      );
      expect(sameArchived.rowCount).toBe(1);
    });
  });
});

describe("E. ordering with the NEW app (PEER-1124 F3)", () => {
  // The new app at bfd266d9 archives with the same user-scoped statement as the old one
  // (app/(app)/clients/[id]/actions.ts), then records the audit through service_role.
  it("while the guard is UP the new app's user-scoped archive and unarchive UPDATEs are refused too (55000)", async () => {
    await sandbox(async ({ q, as }) => {
      await q(GUARD_UP);
      const archive = await as("authenticated", a.userId, async (uq) => {
        await uq("savepoint s");
        const c = await code(() => uq(OLD_ARCHIVE_UPDATE, [new Date().toISOString(), a.practitionerId, a.clientId, a.studioId]));
        await uq("rollback to savepoint s");
        return c;
      });
      expect(archive).toBe("55000");
      await q("update public.clients set archived_at = now(), archived_by = $2 where id = $1", [a.clientId, a.practitionerId]);
      const unarchive = await as("authenticated", a.userId, async (uq) => {
        await uq("savepoint s");
        const c = await code(() => uq(OLD_UNARCHIVE_UPDATE, [a.clientId, a.studioId]));
        await uq("rollback to savepoint s");
        return c;
      });
      expect(unarchive).toBe("55000");
    });
  });

  it("after DOWN the new app's whole sequence works: user UPDATE, then exactly one governed audit row", async () => {
    await sandbox(async ({ q, as }) => {
      await q(GUARD_UP);
      await q(GUARD_DOWN);
      const before = await auditCount(q, a.studioId);
      const ts = new Date().toISOString();
      const updated = await as("authenticated", a.userId, (uq) => uq(OLD_ARCHIVE_UPDATE, [ts, a.practitionerId, a.clientId, a.studioId]));
      expect(updated.rowCount).toBe(1);
      const ok = await as("service_role", null, (sq) =>
        sq("select public.record_client_archive_audit_governed($1,$2,$3,$4,true,$5) as ok", [a.practitionerId, a.userId, a.studioId, a.clientId, ts]),
      );
      expect(ok.rows[0].ok).toBe(true);
      expect(await auditCount(q, a.studioId)).toBe(before + 1);
    });
  });
});
