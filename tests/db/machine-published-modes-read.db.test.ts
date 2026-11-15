import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { planContractPublication } from "../../lib/machines/contract-publication";
import { publishedModesFor, type MachineDb } from "../../lib/machines/machine-queries";
import { publicationFixture } from "../fixtures/machine-publication";
import { asRole, closePool, seedStudio, type UserQuery } from "./helpers/harness";

afterAll(closePool);

// The owner settings page and registerMachineAction decide what an owner may register from `publishedModesFor`. Its unit tests mock the
// database; this runs the REAL function against the REAL migrated table and RLS policy (0223: select for authenticated, none for anon).
// The adapter below turns the exact PostgREST chain the function issues (from/select/eq/order/limit) into SQL on a transaction that
// is running as the given role, so a permission failure surfaces as the same { error } the function sees in production.
function dbOver(q: UserQuery): MachineDb {
  return {
    rpc: async () => ({ data: null, error: null }),
    from(table: string) {
      const st = { cols: "*", eqs: [] as Array<[string, unknown]>, ord: null as null | [string, boolean], lim: null as null | number };
      const exec = async () => {
        try {
          const where = st.eqs.map(([c], i) => `${c} = $${i + 1}`).join(" and ");
          const sql = `select ${st.cols} from public.${table}${where ? ` where ${where}` : ""}${st.ord ? ` order by ${st.ord[0]} ${st.ord[1] ? "asc" : "desc"}` : ""}${st.lim ? ` limit ${st.lim}` : ""}`;
          return { data: (await q(sql, st.eqs.map(([, v]) => v))).rows, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code ?? null } };
        }
      };
      const b = {
        select(c: string) { st.cols = c; return b; },
        eq(c: string, v: unknown) { st.eqs.push([c, v]); return b; },
        order(c: string, o?: { ascending?: boolean }) { st.ord = [c, o?.ascending !== false]; return b; },
        limit(n: number) { st.lim = n; return b; },
        then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) { return exec().then(res, rej); },
      };
      return b;
    },
  } as unknown as MachineDb;
}

describe("publishedModesFor against the real table and RLS", () => {
  it("an authenticated studio owner reads exactly the published modes, per version; an unpublished profile reads empty", async () => {
    const studio = await seedStudio("published-read");
    const profile = publicationFixture(`synthetic:published-read-${randomUUID()}`);
    const [c] = planContractPublication([profile]).publish;
    await asRole("service_role", async (q) => {
      await q("select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)", [c.p_machine_profile_id, c.p_machine_profile_version, c.p_mode_key, c.p_channels_max, c.p_requires_installed_option, JSON.stringify(c.p_fields)]);
      await q("reset role"); await q("set local role authenticated");
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: studio.userId, role: "authenticated" })]);
      const db = dbOver(q);
      expect(await publishedModesFor(db, profile.profileId, profile.version)).toEqual({ ok: true, value: ["galvanic"] });
      expect(await publishedModesFor(db, profile.profileId, profile.version + 1)).toEqual({ ok: true, value: [] });
      expect(await publishedModesFor(db, `synthetic:never-published-${randomUUID()}`, 1)).toEqual({ ok: true, value: [] });
    });
  });

  it("a role the policy does not grant (anon) gets a FAILED read, not an empty one", async () => {
    await asRole("anon", async (q) => {
      const res = await publishedModesFor(dbOver(q), "dectro-apilus:senior-3g", 3);
      expect(res.ok).toBe(false);
    });
  });
});
