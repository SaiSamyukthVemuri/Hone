import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminQuery, adminTx, closePool } from "./helpers/harness";
import { stackAuthConfig } from "./helpers/auth-email-change";

// Insurance S-3: the CODEX-P2 rollback (supabase/rollbacks/0291_session_link_proof_stamp.down.sql) on a real database. Each case
// runs the file's body inside ONE transaction that is then rolled back (a sentinel throw), so the stack keeps 0291 for the other
// files; the file's own begin/commit lines are the only lines removed. Synthetic rows; local stack only.
beforeAll(async () => { console.log(`[auth-config] ${JSON.stringify(await stackAuthConfig())} ${new URL(process.env.E2E_SUPABASE_URL ?? "http://x").host}`); });
afterAll(async () => { await closePool(); });

const DOWN = readFileSync(join(process.cwd(), "supabase/rollbacks/0291_session_link_proof_stamp.down.sql"), "utf8");
const BODY = DOWN.split("\n").filter((l) => !/^(begin|commit);$/.test(l.trim())).join("\n");
const ROLLBACK = "__rolled_back_on_purpose__";
async function inRolledBackTx(fn: (q: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<void>) {
  await expect(adminTx(async (q) => { await fn(q as never); throw new Error(ROLLBACK); })).rejects.toThrow(ROLLBACK);
}
const objects = (q: (t: string) => Promise<{ rows: Record<string, unknown>[] }>) =>
  q(`select to_regclass('public.auth_session_link_proofs') is not null as tbl,
            to_regprocedure('public.stamp_session_link_proof()') is not null as stamp_fn,
            to_regprocedure('public.session_link_proof_is_current()') is not null as link_fn,
            coalesce((select position('auth_session_link_proofs' in prosrc) > 0 from pg_proc where oid = to_regprocedure('public.session_link_proof_is_current()')), false) as link_reads_stamps`).then((r) => r.rows[0]);

describe("0291 CODEX-P2 rollback, proven on a real database", () => {
  it("REFUSES while a stamp row exists (data-loss guard): raises, nothing changed", async () => {
    await inRolledBackTx(async (q) => {
      await q(`insert into public.auth_session_link_proofs (session_id, user_id, anchor) values ($1, $2, now())`, [randomUUID(), randomUUID()]);
      await q(`savepoint before_down`);
      await expect(q(BODY)).rejects.toThrow(/0291 stamp rollback refused: [1-9][0-9]* session proof stamp row\(s\) exist/);
      await q(`rollback to savepoint before_down`);
      expect(await objects(q as never)).toEqual({ tbl: true, stamp_fn: true, link_fn: true, link_reads_stamps: true });
    });
  });

  it("with the explicit opt-in it drops the recorder and the table and restores the stamp-free link check (grants intact)", async () => {
    await inRolledBackTx(async (q) => {
      await q(`insert into public.auth_session_link_proofs (session_id, user_id, anchor) values ($1, $2, now())`, [randomUUID(), randomUUID()]);
      await q(`set local hone.rollback_0291_discard_stamps = 'discard'`);
      await q(BODY);
      expect(await objects(q as never)).toEqual({ tbl: false, stamp_fn: false, link_fn: true, link_reads_stamps: false });
      const g = (await q(`select has_function_privilege('authenticated', 'public.session_link_proof_is_current()', 'execute') as a,
                                 has_function_privilege('anon', 'public.session_link_proof_is_current()', 'execute') as b`)).rows[0];
      expect(g).toEqual({ a: true, b: false });
      // The restored check still works: a never-changed caller is proven, a changed caller with no credential is not.
      const never = randomUUID(), changed = randomUUID();
      await q(`insert into auth.users (id, email) values ($1, $2), ($3, $4)`, [never, `rb-n-${never.slice(0, 8)}@harness.local`, changed, `rb-c-${changed.slice(0, 8)}@harness.local`]);
      await q(`update auth.users set email_change_sent_at = now() where id = $1`, [changed]);
      const as = async (uid: string) => {
        await q(`set local role authenticated`);
        await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: "authenticated", session_id: randomUUID() })]);
        const r = (await q(`select public.session_link_proof_is_current() as ok`)).rows[0].ok;
        await q(`reset role`);
        return r;
      };
      expect(await as(never)).toBe(true);
      expect(await as(changed)).toBe(false);
    });
  });

  it("with NO stamp rows it runs without the opt-in", async () => {
    await inRolledBackTx(async (q) => {
      await q(`delete from public.auth_session_link_proofs`);
      await q(BODY);
      expect(await objects(q as never)).toEqual({ tbl: false, stamp_fn: false, link_fn: true, link_reads_stamps: false });
    });
  });

  it("every case rolled back: the stack still has the stamp table, the recorder and the stamp-aware check", async () => {
    expect(await objects((t) => adminQuery(t) as never)).toEqual({ tbl: true, stamp_fn: true, link_fn: true, link_reads_stamps: true });
  });
});
