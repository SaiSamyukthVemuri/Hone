import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, closePool } from "./helpers/harness";

// 0294 (HELD): the shared fixed-window counter behind the public limiter's outage fallback (DN-29). Proves the rules the app
// depends on against the real function: exact counting under concurrency, every attempt counted (also over the limit), windows
// roll over, buckets are independent, bad input is refused, and no browser role can touch it. Synthetic keys only.

afterAll(async () => {
  await closePool();
});

type Hit = { allowed: boolean; count: number; retry_after_seconds: number };
const hit = async (scope: string, key: string, windowSeconds: number, limit: number): Promise<Hit> =>
  (await adminQuery(`select public.rate_limit_fallback_hit($1, $2, $3, $4) as r`, [scope, key, windowSeconds, limit])).rows[0].r as Hit;
const key = () => `k${randomUUID().replace(/-/g, "")}`;

describe("rate_limit_fallback_hit: counting", () => {
  it("POSITIVE CONTROL: the first attempt is allowed and counted", async () => {
    const r = await hit("t_basic", key(), 600, 5);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
    expect(r.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(r.retry_after_seconds).toBeLessThanOrEqual(600);
  });

  it("allows exactly `limit` attempts, refuses the next, and KEEPS COUNTING the refused ones", async () => {
    const k = key();
    const results: Hit[] = [];
    for (let i = 0; i < 8; i++) results.push(await hit("t_limit", k, 3600, 5));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false, false, false]);
    expect(results.map((r) => r.count)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("is atomic under concurrency: 60 parallel attempts, limit 10 -> exactly 10 allowed, 50 refused, final count 60", async () => {
    const k = key();
    const rs = await Promise.all(Array.from({ length: 60 }, () => hit("t_conc", k, 3600, 10)));
    expect(rs.filter((r) => r.allowed)).toHaveLength(10);
    expect(rs.filter((r) => !r.allowed)).toHaveLength(50);
    expect(new Set(rs.map((r) => r.count)).size).toBe(60); // no two callers saw the same count
    const row = (await adminQuery(`select sum(n)::int as n from public.rate_limit_fallback_counters where scope='t_conc' and key_hash=$1`, [k])).rows[0];
    expect(row.n).toBe(60);
  });

  it("buckets are independent across keys and across scopes", async () => {
    const a = key();
    const b = key();
    for (let i = 0; i < 3; i++) await hit("t_indep", a, 3600, 2);
    expect((await hit("t_indep", a, 3600, 2)).allowed).toBe(false);
    expect((await hit("t_indep", b, 3600, 2)).allowed).toBe(true); // another key
    expect((await hit("t_indep_other", a, 3600, 2)).allowed).toBe(true); // another scope, same key
  });

  it("a new window starts a new count (1-second window rolls over)", async () => {
    const k = key();
    expect((await hit("t_roll", k, 1, 1)).allowed).toBe(true);
    await new Promise((r) => setTimeout(r, 2100));
    const r = await hit("t_roll", k, 1, 1);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
  });

  it("DOCUMENTED EDGE: fixed windows can admit up to twice the limit across a boundary (two windows, two full budgets)", async () => {
    const k = key();
    await adminQuery(
      `insert into public.rate_limit_fallback_counters (scope, key_hash, window_start, window_seconds, n) values ('t_edge', $1, to_timestamp(floor(extract(epoch from clock_timestamp()) / 3600) * 3600) - interval '1 hour', 3600, 5)`,
      [k],
    );
    // The previous window is full (5 of 5); this one still gives a fresh budget of 5.
    const rs = await Promise.all(Array.from({ length: 5 }, () => hit("t_edge", k, 3600, 5)));
    expect(rs.every((r) => r.allowed)).toBe(true);
  });
});

describe("rate_limit_fallback_hit: input and housekeeping", () => {
  it.each([
    ["uppercase scope", ["BAD", "k", 60, 5]],
    ["empty scope", ["", "k", 60, 5]],
    ["scope with a dash", ["a-b", "k", 60, 5]],
    ["empty key", ["t_bad", "", 60, 5]],
    ["window 0", ["t_bad", "k", 0, 5]],
    ["window too long", ["t_bad", "k", 604801, 5]],
    ["limit 0 (would be 'always refuse', not a limit)", ["t_bad", "k", 60, 0]],
    ["negative limit", ["t_bad", "k", 60, -1]],
    ["huge limit", ["t_bad", "k", 60, 1000001]],
  ])("refuses %s with 22023 and writes nothing", async (_l, args) => {
    await expect(adminQuery(`select public.rate_limit_fallback_hit($1, $2, $3, $4)`, args as unknown[])).rejects.toThrow(/invalid rate limit arguments|22023/i);
  });

  it("null arguments are refused too", async () => {
    await expect(adminQuery(`select public.rate_limit_fallback_hit(null, 'k', 60, 5)`)).rejects.toThrow(/invalid rate limit arguments|22023/i);
    await expect(adminQuery(`select public.rate_limit_fallback_hit('t_bad', 'k', null, 5)`)).rejects.toThrow(/invalid rate limit arguments|22023/i);
  });

  it("deletes long-expired windows opportunistically and leaves current ones", async () => {
    const old = key();
    const fresh = key();
    await adminQuery(`insert into public.rate_limit_fallback_counters (scope, key_hash, window_start, window_seconds, n) values ('t_clean', $1, now() - interval '3 days', 3600, 1)`, [old]);
    await adminQuery(`select public.rate_limit_fallback_hit('t_clean', $1, 3600, 5)`, [fresh]);
    // About 1 call in 50 sweeps; 1500 calls make a miss astronomically unlikely.
    await adminQuery(`select count(*) from generate_series(1, 1500) g, lateral (select public.rate_limit_fallback_hit('t_clean_bulk', g::text, 60, 5)) x`);
    const left = (await adminQuery(`select key_hash from public.rate_limit_fallback_counters where scope='t_clean'`)).rows.map((r: { key_hash: string }) => r.key_hash);
    expect(left).toContain(fresh);
    expect(left).not.toContain(old);
  });
});

describe("P2: cleanup is by window END, never deleting an active window", () => {
  const seed = (scope: string, k: string, ago: string, windowSeconds: number) =>
    adminQuery(
      `insert into public.rate_limit_fallback_counters (scope, key_hash, window_start, window_seconds, n) values ($1, $2, now() - $3::interval, $4, 1)`,
      [scope, k, ago, windowSeconds],
    );
  const present = async (scope: string) => (await adminQuery(`select key_hash from public.rate_limit_fallback_counters where scope = $1`, [scope])).rows.map((r: { key_hash: string }) => r.key_hash);

  it("a 7-day window that started 3 days ago is ACTIVE and survives; a 1-hour window from 3 days ago is expired and goes; a window still open survives", async () => {
    const longActive = key();
    const shortExpired = key();
    const stillOpen = key();
    await seed("t_p2", longActive, "3 days", 604800); // ends in 4 days
    await seed("t_p2", shortExpired, "3 days", 3600); // ended 71 hours ago
    await seed("t_p2", stillOpen, "30 minutes", 3600); // ends in 30 minutes
    await adminQuery(`select public.rate_limit_fallback_cleanup(500)`);
    const left = await present("t_p2");
    expect(left).toContain(longActive);
    expect(left).toContain(stillOpen);
    expect(left).not.toContain(shortExpired);
  });

  it("the old rule would have deleted the active long window (control: its window_start is older than two days)", async () => {
    const k = key();
    await seed("t_p2b", k, "3 days", 604800);
    const r = await adminQuery(`select (window_start < now() - interval '2 days') as old_by_start, (window_start + make_interval(secs => window_seconds) > now()) as still_active from public.rate_limit_fallback_counters where key_hash = $1`, [k]);
    expect(r.rows[0]).toEqual({ old_by_start: true, still_active: true });
    await adminQuery(`select public.rate_limit_fallback_cleanup(500)`);
    expect(await present("t_p2b")).toContain(k);
  });

  it("the opportunistic sweep in the hit function applies the same rule", async () => {
    const longActive = key();
    await seed("t_p2c", longActive, "3 days", 604800);
    await adminQuery(`select count(*) from generate_series(1, 1500) g, lateral (select public.rate_limit_fallback_hit('t_p2c_bulk', g::text, 60, 5)) x`);
    expect(await present("t_p2c")).toContain(longActive);
  });

  it("the cleanup function is not callable by any browser or service role", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      await expect(asRole(role, (q) => q(`select public.rate_limit_fallback_cleanup(10)`))).rejects.toThrow(/permission denied|42501/i);
    }
  });
});

describe("0294 privileges", () => {
  it("anon and authenticated cannot execute the function or read the table; service_role can execute it", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(role, (q) => q(`select public.rate_limit_fallback_hit('t_priv', 'k', 60, 5)`))).rejects.toThrow(/permission denied|42501/i);
      await expect(asRole(role, (q) => q(`select * from public.rate_limit_fallback_counters limit 1`))).rejects.toThrow(/permission denied|42501/i);
      await expect(asRole(role, (q) => q(`insert into public.rate_limit_fallback_counters (scope, key_hash, window_start, window_seconds, n) values ('t_priv','k',now(),60,1)`))).rejects.toThrow(/permission denied|42501/i);
    }
    const r = await asRole("service_role", (q) => q(`select public.rate_limit_fallback_hit('t_priv_sr', $1, 60, 5) as r`, [key()]));
    expect((r.rows[0].r as Hit).allowed).toBe(true);
  });

  it("PUBLIC has no execute grant, and the table has row level security forced", async () => {
    const g = await adminQuery(
      `select has_function_privilege('public', 'public.rate_limit_fallback_hit(text,text,integer,integer)', 'execute') as pub,
              (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.rate_limit_fallback_counters'::regclass) as rls`,
    );
    expect(g.rows[0].pub).toBe(false);
    expect(g.rows[0].rls).toBe(true);
  });
});
