import { afterAll, describe, expect, it } from "vitest";
import { adminTx, closePool } from "./helpers/harness";
// @ts-expect-error - .mjs utility ships without type declarations
import { ACL_SQL } from "../../scripts/db-baseline/sql.mjs";

// The baseline restore replays explicit grants generated from the chain (scripts/db-baseline/sql.mjs, ACL_SQL).
// This proves the mechanism on the real stack: give tables MORE access than the chain gave them (what a target's
// default privileges do to an object whose ACL equals the built-in default), replay, and the ACL is exactly the
// chain's again. A negative control shows the extra grant is real before the replay.

afterAll(async () => {
  await closePool();
});

class Rollback extends Error {}

describe("baseline ACL replay never leaves a table with more grants than the chain", () => {
  it("restores the chain's ACL after extra grants, and the extra grants were real", async () => {
    const seen: { before: Record<string, string>; leaked: Record<string, string>; after: Record<string, string>; tables: string[] } = { before: {}, leaked: {}, after: {}, tables: [] };
    try {
      await adminTx(async (q) => {
        const cand = await q(
          `select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
              and coalesce(c.relacl::text, '') !~ 'anon=' and coalesce(c.relacl::text, '') !~ 'authenticated=' and pg_get_userbyid(c.relowner) = current_user
            order by c.relname limit 3`,
        );
        seen.tables = cand.rows.map((r: Record<string, unknown>) => String(r.relname));
        const acls = async () => {
          const r = await q(`select relname::text n, coalesce(relacl::text, '<default>') a from pg_class where relnamespace = 'public'::regnamespace and relname = any($1)`, [seen.tables]);
          return Object.fromEntries(r.rows.map((x: Record<string, unknown>) => [String(x.n), String(x.a)]));
        };
        seen.before = await acls();
        // The replay script, generated from the chain's state NOW, narrowed to these tables.
        const gen = await q(ACL_SQL);
        const stmts = gen.rows.map((r: Record<string, unknown>) => String(Object.values(r)[0])).filter((s: string) => seen.tables.some((t) => s.includes(` TABLE public.${t} `) || s.includes(` TABLE public."${t}" `)));
        for (const t of seen.tables) await q(`grant all on table public.${t} to anon, authenticated`);
        seen.leaked = await acls();
        for (const s of stmts) await q(s);
        seen.after = await acls();
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    expect(seen.tables.length, "need owner-only tables to prove the replay on").toBeGreaterThan(0);
    for (const t of seen.tables) {
      expect(seen.leaked[t], `negative control: the extra grant on ${t} must be real before the replay`).not.toBe(seen.before[t]);
      expect(seen.after[t], `${t} must carry exactly the chain's grants after the replay`).toBe(seen.before[t]);
    }
  });
});
