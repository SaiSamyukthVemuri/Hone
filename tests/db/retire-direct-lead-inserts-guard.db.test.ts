import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminTx, closePool } from "./helpers/harness";

// 0391 guard: refuse only when leads EXIST but no lead alert proves the RPC path was used. A database with no leads at
// all has nothing to protect (a fresh chain starts empty: 0213 creates platform_lead_alerts with no rows).
//
// Each case runs inside one transaction that is always rolled back: the pre-0391 state is rebuilt from the rollback file,
// the lead tables are emptied for the case, and the migration body (minus its own begin/commit) runs under a savepoint.
const ROOT = join(__dirname, "..", "..", "supabase");
const UP = readFileSync(join(ROOT, "migrations", "0391_retire_direct_public_lead_inserts.sql"), "utf8")
  .replace(/^begin;\s*$/m, "")
  .replace(/^commit;\s*$/m, "");
const DOWN = readFileSync(join(ROOT, "rollbacks", "0391_retire_direct_public_lead_inserts.down.sql"), "utf8")
  .replace(/^begin;\s*$/m, "")
  .replace(/^commit;\s*$/m, "");

class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super("rollback");
  }
}

type Outcome = { ok: boolean; code: string | null; message: string; policies: number; anonPrivs: number };

async function run(setup: (q: (t: string, p?: unknown[]) => Promise<any>) => Promise<void>): Promise<Outcome> {
  try {
    await adminTx(async (q) => {
      await q("set local session_replication_role = replica");
      await q("delete from public.platform_lead_alerts");
      await q("delete from public.demo_requests");
      await q("delete from public.waitlist");
      await q("set local session_replication_role = origin");
      await q(DOWN); // pre-0391 state: both anonymous insert policies and the table privileges are back
      await setup(q);
      await q("savepoint before_up");
      let ok = true;
      let code: string | null = null;
      let message = "";
      try {
        await q(UP);
      } catch (e: any) {
        ok = false;
        code = e.code ?? null;
        message = String(e.message);
        await q("rollback to savepoint before_up");
      }
      const pol = await q(
        "select count(*)::int n from pg_policy where polrelid in ('public.demo_requests'::regclass,'public.waitlist'::regclass)",
      );
      const priv = await q(
        "select count(*)::int n from information_schema.role_table_grants where table_schema='public' and table_name in ('demo_requests','waitlist') and grantee='anon'",
      );
      throw new Rollback<Outcome>({ ok, code, message, policies: pol.rows[0].n, anonPrivs: priv.rows[0].n });
    });
  } catch (e) {
    if (e instanceof Rollback) return e.value;
    throw e;
  }
  throw new Error("unreachable");
}

const lead = (q: (t: string, p?: unknown[]) => Promise<any>) =>
  q("insert into public.demo_requests (name, email) values ('Guard Lead', $1) returning id", [`guard-${Date.now()}@example.com`]);

afterAll(async () => {
  await closePool();
});

describe("0391 guard: leads without any alert refuse; an empty or alerted database proceeds", () => {
  it("(b) leads exist and no alert exists: refuses with 23514 and changes nothing", async () => {
    const o = await run(async (q) => {
      await lead(q);
    });
    expect(o.ok).toBe(false);
    expect(o.code).toBe("23514");
    expect(o.message).toContain("no platform lead alert exists");
    expect(o.policies).toBe(2); // both insert policies still present
    expect(o.anonPrivs).toBeGreaterThan(0); // anon still holds its privileges
  });

  it("(b2) a waitlist lead alone also refuses", async () => {
    const o = await run(async (q) => {
      await q("insert into public.waitlist (email) values ($1)", [`guard-w-${Date.now()}@example.com`]);
    });
    expect(o.ok).toBe(false);
    expect(o.code).toBe("23514");
  });

  it("(c) leads exist and at least one alert exists: proceeds", async () => {
    const o = await run(async (q) => {
      await q("select public.record_platform_early_access_signup($1)", [`guard-a-${Date.now()}@example.com`]);
      await lead(q);
      await q("update public.demo_requests set created_at = now() - interval '1 day'"); // an older lead, before the first alert
    });
    expect(o.ok).toBe(true);
    expect(o.policies).toBe(0);
    expect(o.anonPrivs).toBe(0);
  });

  it("(d) no leads at all: proceeds", async () => {
    const o = await run(async () => {});
    expect(o.ok).toBe(true);
    expect(o.policies).toBe(0);
    expect(o.anonPrivs).toBe(0);
  });

  it("(e) the later check is unchanged: a lead after the first alert with no alert still refuses", async () => {
    const o = await run(async (q) => {
      await q("select public.record_platform_early_access_signup($1)", [`guard-e-${Date.now()}@example.com`]);
      // now() is frozen inside one transaction, so give the unalerted lead an explicit later created_at
      await q("insert into public.demo_requests (name, email, created_at) values ('Late Lead', $1, now() + interval '1 minute')", [`guard-l-${Date.now()}@example.com`]);
    });
    expect(o.ok).toBe(false);
    expect(o.code).toBe("23514");
    expect(o.message).toContain("without an alert after the RPC path started");
    expect(o.policies).toBe(2);
  });
});
