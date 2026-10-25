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
