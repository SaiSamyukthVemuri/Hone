import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// Behavioural proof of migration 0130, the residual anon EXECUTE grant on the
// two 0129 multi-area charting RPCs is revoked, restoring least privilege,
// against the REAL migrated local DB (reset applies every migration through
// 0130). The in-function is_studio_member guard is the security boundary; 0130
// aligns the grant layer with it. Migration sequence applying cleanly from zero
// through 0130 is a precondition of this suite even running.

const CREATE_SIG =
  "public.create_session_block_with_areas(uuid, uuid, jsonb, jsonb)";
const UPDATE_SIG =
  "public.update_session_block_with_areas(uuid, uuid, uuid, jsonb, jsonb, timestamptz)";
const AREAS = (arr: Array<{ area: string; laterality: string }>) =>
  JSON.stringify(arr);

let a: SeededStudio;
let b: SeededStudio;
beforeAll(async () => {
  a = await seedStudio("rev130-a");
  b = await seedStudio("rev130-b");
});
afterAll(async () => {
  await closePool();
});

describe("0130: grant matrix", () => {
  it("the EXECUTE grantees are exactly {authenticated, postgres, service_role}, no anon, no PUBLIC", async () => {
    for (const proname of [
      "create_session_block_with_areas",
      "update_session_block_with_areas",
    ]) {
      // string_agg (not array_agg) so the result is an unambiguous scalar string
      // regardless of node-pg array parsing.
      const r = await adminQuery(
        `select coalesce(string_agg(distinct coalesce(g.rolname,'PUBLIC'), ',' order by coalesce(g.rolname,'PUBLIC')), '') as grantees
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           cross join lateral aclexplode(p.proacl) acl
           left join pg_roles g on g.oid = acl.grantee
          where n.nspname='public' and p.proname=$1 and acl.privilege_type='EXECUTE'`,
        [proname],
      );
      expect(r.rows[0].grantees).toBe("authenticated,postgres,service_role");
    }
  });

  it("has_function_privilege: anon=false, authenticated=true, service_role=true (both RPCs)", async () => {
    const r = await adminQuery(
      `select
         has_function_privilege('anon', '${CREATE_SIG}', 'execute') as anon_create,
         has_function_privilege('anon', '${UPDATE_SIG}', 'execute') as anon_update,
         has_function_privilege('authenticated', '${CREATE_SIG}', 'execute') as auth_create,
         has_function_privilege('authenticated', '${UPDATE_SIG}', 'execute') as auth_update,
         has_function_privilege('service_role', '${CREATE_SIG}', 'execute') as sr_create,
         has_function_privilege('service_role', '${UPDATE_SIG}', 'execute') as sr_update`,
    );
    expect(r.rows[0]).toMatchObject({
      anon_create: false,
      anon_update: false,
      auth_create: true,
      auth_update: true,
      sr_create: true,
      sr_update: true,
    });
  });
});

describe("0130: anon is denied at the grant layer", () => {
  it("anon cannot execute the CREATE RPC (permission denied)", async () => {
    const { sessionId } = await seedSession(a);
    await expect(
      asRole("anon", (q) =>
        q(`select public.create_session_block_with_areas($1,$2,'{}'::jsonb,$3::jsonb)`, [
          a.studioId,
          sessionId,
          AREAS([{ area: "Chin", laterality: "left" }]),
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" }); // insufficient_privilege
  });

  it("anon cannot execute the UPDATE RPC (permission denied)", async () => {
    const { sessionId, blockId } = await seedSession(a);
    await expect(
      asRole("anon", (q) =>
        q(
          `select public.update_session_block_with_areas($1,$2,$3,'{}'::jsonb,$4::jsonb,null)`,
          [a.studioId, sessionId, blockId, AREAS([{ area: "Chin", laterality: "left" }])],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("0130: the reviewed authenticated path still works; body unchanged", () => {
  it("an authenticated same-studio practitioner CAN execute CREATE (block + areas persist)", async () => {
    const { sessionId } = await seedSession(a);
    const blockId = await asUser(a.userId, async (q) => {
      const r = await q(
        `select public.create_session_block_with_areas($1,$2,'{}'::jsonb,$3::jsonb) as id`,
        [
          a.studioId,
          sessionId,
          AREAS([
            { area: "Cheeks", laterality: "left" },
            { area: "Sideburns", laterality: "right" },
          ]),
        ],
      );
      return r.rows[0].id as string;
    });
    const areas = await adminQuery(
      `select area, laterality from public.session_block_areas where session_block_id=$1 order by display_order`,
      [blockId],
    );
    expect(areas.rows).toEqual([
      { area: "Cheeks", laterality: "left" },
      { area: "Sideburns", laterality: "right" },
    ]);
  });

  it("an authenticated CROSS-studio caller is still rejected by the body (not_authorized, not a grant error)", async () => {
    const { sessionId } = await seedSession(a);
    await expect(
      asUser(b.userId, (q) =>
        q(`select public.create_session_block_with_areas($1,$2,'{}'::jsonb,$3::jsonb)`, [
          a.studioId,
          sessionId,
          AREAS([{ area: "Chin", laterality: "left" }]),
        ]),
      ),
    ).rejects.toThrow(/not authorized/i);
  });

  it("service_role RETAINS execute: it reaches the body's authorization (not a grant error)", async () => {
    const { sessionId } = await seedSession(a);
    // service_role has no auth.uid() → is_studio_member is false → the BODY raises
    // 'not authorized' (proving EXECUTE is granted; it is NOT a 42501 grant error).
    await expect(
      asRole("service_role", (q) =>
        q(`select public.create_session_block_with_areas($1,$2,'{}'::jsonb,$3::jsonb)`, [
          a.studioId,
          sessionId,
          AREAS([{ area: "Chin", laterality: "left" }]),
        ]),
      ),
    ).rejects.toThrow(/not authorized/i);
  });

  it("function bodies + search_path are unchanged by 0130 (grant-only migration)", async () => {
    const r = await adminQuery(
      `select p.proname, pg_get_functiondef(p.oid) as src, p.prosecdef, array_to_string(p.proconfig,';') as cfg
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('create_session_block_with_areas','update_session_block_with_areas')
        order by p.proname`,
    );
    const create = r.rows.find((x) => x.proname === "create_session_block_with_areas");
    const update = r.rows.find((x) => x.proname === "update_session_block_with_areas");
    for (const fn of [create, update]) {
      expect(fn.prosecdef).toBe(true); // still SECURITY DEFINER
      expect(fn.cfg).toBe("search_path=pg_catalog, pg_temp");
      expect(fn.src).toMatch(/is_studio_member\(p_studio_id\)/);
    }
    expect(update.src).toMatch(/for update/i);
    expect(update.src).toMatch(/stale_block_version/);
    // The area-set replacement is still atomic (delete + insert in the body).
    expect(update.src).toMatch(/delete from public\.session_block_areas/i);
    expect(update.src).toMatch(/insert into public\.session_block_areas/i);
  });
});
