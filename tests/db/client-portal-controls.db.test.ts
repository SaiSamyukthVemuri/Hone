import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  seedMember,
  seedStudio,
} from "@/tests/db/helpers/harness";

// ===========================================================================
// HON-47 MIGRATION 0252 — studios.client_portal_enabled + the portal access
// guard. DB-BEHAVIOUR HALF (the application half is unit-tested under
// tests/app and tests/lib; the source contract is
// tests/migrations/0252-client-portal-controls.test.ts).
// ===========================================================================
//
// Runs in CI's DB lane and on an owned isolated stack (CLAUDE.md §5); never
// against a shared stack.
//
// Synthetic studios, users and clients only (seedStudio / seedMember).

afterAll(async () => {
  await closePool();
});

async function portalFlag(studioId: string): Promise<boolean> {
  const { rows } = await adminQuery(
    `select client_portal_enabled as v from public.studios where id = $1`,
    [studioId],
  );
  return rows[0].v as boolean;
}

function magicLinkInsert(studioId: string, clientId: string) {
  return [
    `insert into public.client_portal_magic_links
       (studio_id, client_id, token_hash, email_normalized, expires_at)
     values ($1, $2, $3, 'synthetic@harness.local', now() + interval '1 hour')`,
    [studioId, clientId, randomUUID().replace(/-/g, "")],
  ] as [string, unknown[]];
}

function sessionInsert(studioId: string, clientId: string) {
  return [
    `insert into public.client_portal_sessions
       (studio_id, client_id, session_token_hash, expires_at)
     values ($1, $2, $3, now() + interval '7 days')`,
    [studioId, clientId, randomUUID().replace(/-/g, "")],
  ] as [string, unknown[]];
}

describe("the column", () => {
  it("is boolean NOT NULL DEFAULT true", async () => {
    const { rows } = await adminQuery(
      `select data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = 'studios'
          and column_name = 'client_portal_enabled'`,
    );
    expect(rows).toEqual([{ data_type: "boolean", is_nullable: "NO", column_default: "true" }]);
  });

  it("DEFAULT: a studio inserted without naming it is TRUE (today's behaviour)", async () => {
    const s = await seedStudio("hon47-default");
    expect(await portalFlag(s.studioId)).toBe(true);
  });
});

describe("persisted on/off choices, owner-only", () => {
  it("the OWNER can turn it off and back on, through the existing owners-update policy", async () => {
    const s = await seedStudio("hon47-owner");
    await asUser(s.userId, (q) =>
      q(`update public.studios set client_portal_enabled = false where id = $1`, [s.studioId]),
    );
    expect(await portalFlag(s.studioId)).toBe(false);
    await asUser(s.userId, (q) =>
      q(`update public.studios set client_portal_enabled = true where id = $1`, [s.studioId]),
    );
    expect(await portalFlag(s.studioId)).toBe(true);
  });

  it("a non-owner MEMBER cannot change it (RLS: zero rows)", async () => {
    const s = await seedStudio("hon47-member");
    const m = await seedMember(s, "hon47-member-m");
    const r = await asUser(m.userId, (q) =>
      q(`update public.studios set client_portal_enabled = false where id = $1`, [s.studioId]),
    );
    expect(r.rowCount).toBe(0);
    expect(await portalFlag(s.studioId)).toBe(true);
  });

  it("another studio's owner cannot change it", async () => {
    const s = await seedStudio("hon47-victim");
    const other = await seedStudio("hon47-other");
    const r = await asUser(other.userId, (q) =>
      q(`update public.studios set client_portal_enabled = false where id = $1`, [s.studioId]),
    );
    expect(r.rowCount).toBe(0);
    expect(await portalFlag(s.studioId)).toBe(true);
  });

  it("anon cannot change it", async () => {
    const s = await seedStudio("hon47-anon");
    await asRole("anon", async (q) => {
      const r = await q(`update public.studios set client_portal_enabled = false where id = $1`, [s.studioId]).catch(
        (e: { code?: string }) => ({ rowCount: 0, code: e.code }),
      );
      expect(r.rowCount).toBe(0);
    });
    expect(await portalFlag(s.studioId)).toBe(true);
  });

  it("is independent of new_client_admission_mode in both directions", async () => {
    const s = await seedStudio("hon47-admission");
    const before = await adminQuery(
      `select new_client_admission_mode, new_client_admission_mode_set_at from public.studios where id = $1`,
      [s.studioId],
    );
    await asUser(s.userId, (q) =>
      q(`update public.studios set client_portal_enabled = false where id = $1`, [s.studioId]),
    );
    const after = await adminQuery(
      `select new_client_admission_mode, new_client_admission_mode_set_at from public.studios where id = $1`,
      [s.studioId],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("is independent of new_client_admission_mode in the other direction: admission changes, the flag and the guard do not", async () => {
    const s = await seedStudio("hon47-admission-rev");
    // The 0204 command is admission's only writer; waitlist first stamps the row.
    for (const mode of ["waitlist", "closed"]) {
      const { rows } = await asUser(s.userId, (q) =>
        q(`select outcome from public.set_new_client_admission_mode($1, $2)`, [s.studioId, mode]),
      );
      expect(rows[0].outcome).not.toMatch(/not_authorized|invalid_mode|studio_not_found/);
    }
    const { rows: mode } = await adminQuery(
      `select new_client_admission_mode as m from public.studios where id = $1`,
      [s.studioId],
    );
    expect(mode[0].m).toBe("closed");
    expect(await portalFlag(s.studioId)).toBe(true);
    // Admission closed does not shut the portal: the guard still admits credentials.
    await asRole("service_role", async (q) => {
      await q(...magicLinkInsert(s.studioId, s.clientId));
      await q(...sessionInsert(s.studioId, s.clientId));
    });
  });

  it("admission OPEN does not reopen a disabled portal: the guard still refuses", async () => {
    const s = await seedStudio("hon47-admission-open");
    const { rows: mode } = await adminQuery(
      `select new_client_admission_mode as m from public.studios where id = $1`,
      [s.studioId],
    );
    expect(mode[0].m).toBe("open");
    await adminQuery(`update public.studios set client_portal_enabled = false where id = $1`, [s.studioId]);
    await expect(
      asRole("service_role", (q) => q(...magicLinkInsert(s.studioId, s.clientId))),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("defence in depth: no portal credential for a disabled studio", () => {
  it("service_role CAN insert a magic link and a session while the flag is TRUE (control)", async () => {
    const s = await seedStudio("hon47-guard-on");
    await asRole("service_role", async (q) => {
      await q(...magicLinkInsert(s.studioId, s.clientId));
      await q(...sessionInsert(s.studioId, s.clientId));
    });
  });

  it("a magic-link insert is REFUSED (23514) while the flag is FALSE", async () => {
    const s = await seedStudio("hon47-guard-link");
    await adminQuery(`update public.studios set client_portal_enabled = false where id = $1`, [s.studioId]);
    await expect(
      asRole("service_role", (q) => q(...magicLinkInsert(s.studioId, s.clientId))),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("a session insert is REFUSED (23514) while the flag is FALSE", async () => {
    const s = await seedStudio("hon47-guard-session");
    await adminQuery(`update public.studios set client_portal_enabled = false where id = $1`, [s.studioId]);
    await expect(
      asRole("service_role", (q) => q(...sessionInsert(s.studioId, s.clientId))),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("turning the flag off writes nothing: an existing session row is left as it was", async () => {
    const s = await seedStudio("hon47-existing");
    await adminQuery(...sessionInsert(s.studioId, s.clientId));
    await adminQuery(`update public.studios set client_portal_enabled = false where id = $1`, [s.studioId]);
    const { rows } = await adminQuery(
      `select count(*)::int as n, count(revoked_at)::int as revoked
         from public.client_portal_sessions where studio_id = $1`,
      [s.studioId],
    );
    expect(rows[0]).toEqual({ n: 1, revoked: 0 });
  });

  it("the guard function is not directly reachable by any API role", async () => {
    const { rows } = await adminQuery(
      `select r.role,
              has_function_privilege(r.role, 'public.client_portal_access_guard()', 'execute') as can
         from (values ('anon'), ('authenticated'), ('service_role')) as r(role)`,
    );
    expect(rows.every((r: { can: boolean }) => r.can === false)).toBe(true);
  });
});

describe("with 0234 on the same chain (skipped when 0234 is absent)", () => {
  it("the three flags are independent columns, all default TRUE", async () => {
    const { rows } = await adminQuery(
      `select column_name, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = 'studios'
          and column_name in ('client_cancellation_enabled', 'client_reschedule_enabled', 'client_portal_enabled')
        order by column_name`,
    );
    if (rows.length < 3) return; // chain without 0234: the column test above is the proof
    expect(rows).toEqual([
      { column_name: "client_cancellation_enabled", column_default: "true" },
      { column_name: "client_portal_enabled", column_default: "true" },
      { column_name: "client_reschedule_enabled", column_default: "true" },
    ]);
    const s = await seedStudio("hon47-three");
    await adminQuery(`update public.studios set client_portal_enabled = false where id = $1`, [s.studioId]);
    const { rows: flags } = await adminQuery(
      `select client_cancellation_enabled as c, client_reschedule_enabled as r, client_portal_enabled as p
         from public.studios where id = $1`,
      [s.studioId],
    );
    expect(flags[0]).toEqual({ c: true, r: true, p: false });
    // Portal off with both 0234 flags on: the guard still refuses.
    await expect(
      asRole("service_role", (q) => q(...sessionInsert(s.studioId, s.clientId))),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("turning 0234's two flags off leaves the portal flag and the guard alone", async () => {
    const { rows } = await adminQuery(
      `select count(*)::int as n from information_schema.columns
        where table_schema = 'public' and table_name = 'studios'
          and column_name in ('client_cancellation_enabled', 'client_reschedule_enabled')`,
    );
    if (rows[0].n < 2) return;
    const s = await seedStudio("hon47-three-rev");
    await asUser(s.userId, (q) =>
      q(
        `update public.studios
            set client_cancellation_enabled = false, client_reschedule_enabled = false
          where id = $1`,
        [s.studioId],
      ),
    );
    const { rows: flags } = await adminQuery(
      `select client_cancellation_enabled as c, client_reschedule_enabled as r, client_portal_enabled as p
         from public.studios where id = $1`,
      [s.studioId],
    );
    expect(flags[0]).toEqual({ c: false, r: false, p: true });
    await asRole("service_role", async (q) => {
      await q(...magicLinkInsert(s.studioId, s.clientId));
      await q(...sessionInsert(s.studioId, s.clientId));
    });
  });
});
