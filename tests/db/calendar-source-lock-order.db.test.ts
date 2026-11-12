// HELD DRAFT, NEVER RUN. Pairs with 0297-calendar-source-lock-order.sql.draft. When 0297 is numbered and staged this becomes
// tests/db/calendar-source-lock-order.db.test.ts in the same PR. Synthetic values only.
// ALSO REQUIRED (OPS): Photos' #1346 tests/db/simultaneous-booking-block-race.db.test.ts with KNOWN_DEFECT_HON48_DEADLOCK = false must pass
// on a stack with 0297 applied (all rounds created/refused, zero 40P01, the unrelated-practitioner case lands both). Run that file too.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, closePool, seedStudio } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";

afterAll(closePool);

const FN = "public.lock_structural_calendar_source_mutation()";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("0297 lock order for structural calendar sources", () => {
  it("catalog: the studios row lock comes before the advisory lock in the function body, and uses NO KEY UPDATE", async () => {
    const r = await adminQuery(`select prosrc from pg_proc where oid = $1::regprocedure`, [FN]);
    const src = String(r.rows[0].prosrc).toLowerCase().replace(/--[^\n]*/g, ""); // comments do not count
    const row = src.indexOf("for no key update");
    const adv = src.indexOf("acquire_studio_capacity_lock");
    expect(row).toBeGreaterThan(-1);
    expect(adv).toBeGreaterThan(-1);
    expect(row).toBeLessThan(adv);
    expect(src).not.toMatch(/for update/); // not the stronger mode
  });

  it("grants by name: no EXECUTE for public, anon, authenticated or service_role", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      const r = await adminQuery(`select has_function_privilege($1, $2, 'EXECUTE') as ok`, [role, FN]);
      expect(r.rows[0].ok, role).toBe(false);
    }
    const pub = await adminQuery(
      `select count(*)::int as n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::regprocedure and a.grantee = 0`,
      [FN],
    );
    expect(pub.rows[0].n).toBe(0);
  });

  it("the four triggers still exist and still point at the function", async () => {
    const r = await adminQuery(
      `select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
        where p.proname = 'lock_structural_calendar_source_mutation' and not t.tgisinternal order by 1`,
    );
    expect(r.rows.map((x) => x.relname)).toEqual([
      "studio_blockouts",
      "studio_recurring_break_occurrences",
      "studio_recurring_break_rules",
      "studio_timed_blocks",
    ]);
  });

  // THE DEADLOCK, DETERMINISTICALLY. A plays the booking commands: studios row FOR UPDATE first, then (later) the advisory lock.
  // B inserts a studio-wide block on another connection. Before 0297: B takes the advisory lock, then waits for A at its foreign-key
  // check, and A then waits for the advisory lock: one of them gets 40P01. After 0297: B waits on the studios row holding nothing, A gets
  // the advisory lock, commits, and B proceeds. Negative control: the same script against the 0138 body (the down file) must fail this
  // test with 40P01. A must COMMIT before B can finish, so B is awaited only after A's transaction has ended.
  const blockInsert = (studioId: string, start: string) =>
    `insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category, practitioner_id)
     values ('${randomUUID()}','${studioId}','${start}'::timestamptz,'${start}'::timestamptz + interval '60 minutes','break',null)`;

  async function waitUntilBlocked(pid: () => number | null, isDone: () => boolean) {
    for (let i = 0; i < 100 && !isDone(); i++) {
      const p = pid();
      if (p !== null) {
        const w = await adminQuery(`select wait_event_type from pg_stat_activity where pid = $1`, [p]);
        if (w.rows[0]?.wait_event_type === "Lock") return true;
      }
      await sleep(50);
    }
    return false;
  }

  it("a block insert and a booking-order transaction on one studio never deadlock", async () => {
    const s = await seedStudio("l297-order");
    const start = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
    let bPid: number | null = null;
    let bDone = false;
    let bCode: string | null = null;
    let bPromise: Promise<void> = Promise.resolve();
    let aCode: string | null = null;

    await adminTx(async (q) => {
      await q(`select 1 from public.studios where id = $1 for update`, [s.studioId]);
      bPromise = adminTx(async (qb) => {
        bPid = (await qb(`select pg_backend_pid() as pid`)).rows[0].pid;
        await qb(blockInsert(s.studioId, start));
      })
        .catch((e: { code?: string }) => { bCode = e.code ?? "error"; })
        .finally(() => { bDone = true; });
      await waitUntilBlocked(() => bPid, () => bDone);
      await q(`select public.acquire_studio_capacity_lock($1)`, [s.studioId]);
    }).catch((e: { code?: string }) => { aCode = e.code ?? "error"; });

    await bPromise;
    expect(aCode, "booking-order transaction").toBeNull();
    expect(bCode, "block insert").toBeNull();
    const n = await adminQuery(`select count(*)::int as n from public.studio_timed_blocks where studio_id = $1`, [s.studioId]);
    expect(n.rows[0].n).toBe(1);
  });

  it("the block still serializes with a booking-order transaction: B does not finish while A holds the studios row", async () => {
    const s = await seedStudio("l297-serial");
    const start = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();
    let bDone = false;
    let bPromise: Promise<void> = Promise.resolve();
    let stillWaiting = false;

    await adminTx(async (q) => {
      await q(`select 1 from public.studios where id = $1 for update`, [s.studioId]);
      bPromise = adminTx((qb) => qb(blockInsert(s.studioId, start))).then(() => { bDone = true; });
      await sleep(500);
      stillWaiting = !bDone;
    });
    await bPromise;
    expect(stillWaiting, "B must still be waiting while A holds the row").toBe(true);
    expect(bDone).toBe(true);
  });

  // ---- PART B -----------------------------------------------------------------------------------------------------------------------

  it("EVERY caller of acquire_studio_capacity_lock takes the studios row first (directly, via a helper that does, or through a studios trigger)", async () => {
    const strip = (s: string) => s.toLowerCase().replace(/--[^\n]*/g, "");
    const callers = await adminQuery(
      `select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosrc ilike '%acquire_studio_capacity_lock%' and p.proname <> 'acquire_studio_capacity_lock' order by 1`,
    );
    expect(callers.rows.length).toBeGreaterThan(10);
    // Functions that run only from a trigger ON studios: the UPDATE that fires them already holds the studios row.
    const studiosTriggerFns = new Set(
      (await adminQuery(
        `select p.proname from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = 'public.studios'::regclass and not t.tgisinternal`,
      )).rows.map((r) => r.proname as string),
    );
    // Plain functions whose every caller is such a trigger function (checked below, not assumed).
    const viaStudiosTrigger = new Set(["rematerialize_studio_reservations"]);

    const rowFirst = /from\s+public\.studios\b[^;]*?for\s+(?:no\s+key\s+)?update|lock_studio_and_assert_owner\s*\(|lock_appointment_for_command\s*\(/;
    const bad: string[] = [];
    for (const c of callers.rows) {
      const name = c.proname as string;
      if (studiosTriggerFns.has(name) || viaStudiosTrigger.has(name)) continue;
      const src = strip(String(c.prosrc));
      const adv = src.indexOf("acquire_studio_capacity_lock");
      const m = rowFirst.exec(src);
      if (!m || m.index > adv) bad.push(name);
    }
    expect(bad, "callers that take the advisory lock before (or without) a studios row lock").toEqual([]);
    for (const fn of viaStudiosTrigger) {
      const users = await adminQuery(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prosrc ilike $1 and p.proname <> $2`,
        [`%${fn}(%`, fn],
      );
      for (const u of users.rows) {
        const callerName = u.proname as string;
        if (studiosTriggerFns.has(callerName)) continue;
        // Not a studios trigger (e.g. on_practitioner_change_refan, a practitioners trigger): it must take the studios row itself, first.
        const callerSrc = strip(String((await adminQuery(`select prosrc from pg_proc where oid = $1::regproc`, [`public.${callerName}`])).rows[0].prosrc));
        const m = rowFirst.exec(callerSrc);
        expect(m !== null && m.index < callerSrc.indexOf(fn), `${fn} is called by ${callerName}, which must take the studios row first`).toBe(true);
      }
    }
  });

  const rule = async (studioId: string, practitionerId: string) =>
    (await adminQuery(
      `select public.create_recurring_break_rule_and_materialize($1,'lunch','{1,2,3,4,5}'::int[],'12:00','13:00',true,$2,(current_date + 30)::date,null) as id`,
      [studioId, practitionerId],
    )).rows[0].id as string;

  // The same booking-order transaction as above (studios row first, advisory later) against each of the four recurring-break commands.
  // Negative control: apply ONLY part A of 0297; the four commands must then fail this test with 40P01.
  const cycle = (name: string, prepare: (s: { studioId: string; practitionerId: string }) => Promise<string>) =>
    it(`${name} and a booking-order transaction never deadlock`, async () => {
      const s = await seedStudio("l297-" + name.slice(0, 6));
      const call = await prepare(s);
      let bPid: number | null = null;
      let bDone = false;
      let bCode: string | null = null;
      let bPromise: Promise<void> = Promise.resolve();
      let aCode: string | null = null;
      await adminTx(async (q) => {
        await q(`select 1 from public.studios where id = $1 for update`, [s.studioId]);
        bPromise = adminTx(async (qb) => {
          bPid = (await qb(`select pg_backend_pid() as pid`)).rows[0].pid;
          await qb(call);
        })
          .catch((e: { code?: string }) => { bCode = e.code ?? "error"; })
          .finally(() => { bDone = true; });
        await waitUntilBlocked(() => bPid, () => bDone);
        await q(`select public.acquire_studio_capacity_lock($1)`, [s.studioId]);
      }).catch((e: { code?: string }) => { aCode = e.code ?? "error"; });
      await bPromise;
      expect(aCode, "booking-order transaction").toBeNull();
      expect(bCode, name).toBeNull();
    });

  cycle("create_recurring_break_rule_and_materialize", async (s) =>
    `select public.create_recurring_break_rule_and_materialize('${s.studioId}','lunch','{1,2,3,4,5}'::int[],'12:00','13:00',true,'${s.practitionerId}',(current_date + 30)::date,null)`);
  cycle("update_recurring_break_rule_and_rematerialize", async (s) => {
    const id = await rule(s.studioId, s.practitionerId);
    return `select public.update_recurring_break_rule_and_rematerialize('${id}','${s.studioId}','lunch2','{1,2,3}'::int[],'11:00','12:00',true,(current_date + 30)::date,null)`;
  });
  cycle("delete_recurring_break_rule", async (s) => {
    const id = await rule(s.studioId, s.practitionerId);
    return `select public.delete_recurring_break_rule('${id}','${s.studioId}')`;
  });
  cycle("materialize_recurring_break_rule", async (s) => {
    const id = await rule(s.studioId, s.practitionerId);
    return `select public.materialize_recurring_break_rule('${id}',(current_date + 60)::date)`;
  });

  // Practitioner change vs a booking (Part C). The remaining practitioner's studio-wide block is re-fanned by the refan trigger, which inserts
  // reservation rows (studios foreign key, KEY SHARE) AFTER taking the advisory lock. Negative control: 0297 without part C, or the down file.
  it("a practitioner delete (capacity ON, studio-wide block present) and a booking-order transaction never deadlock", async () => {
    const S = await seedSynthStudioB();
    try {
      await adminQuery(
        `update public.studios set practitioner_capacity_enabled = true, practitioner_capacity_booking_enabled = true where id = $1`,
        [S.studioId],
      );
      await adminQuery(blockInsert(S.studioId, new Date(Date.now() + 8 * 24 * 3600 * 1000).toISOString()));
      const victim = S.practitioners[S.practitioners.length - 1].practitionerId;
      let bPid: number | null = null;
      let bDone = false;
      let bCode: string | null = null;
      let bPromise: Promise<void> = Promise.resolve();
      let aCode: string | null = null;
      await adminTx(async (q) => {
        await q(`select 1 from public.studios where id = $1 for update`, [S.studioId]);
        bPromise = adminTx(async (qb) => {
          bPid = (await qb(`select pg_backend_pid() as pid`)).rows[0].pid;
          await qb(`delete from public.practitioners where id = $1`, [victim]);
        })
          .catch((e: { code?: string }) => { bCode = e.code ?? "error"; })
          .finally(() => { bDone = true; });
        const blocked = await waitUntilBlocked(() => bPid, () => bDone);
        expect(blocked, "the practitioner delete must be waiting on the studios row held by A").toBe(true);
        await q(`select public.acquire_studio_capacity_lock($1)`, [S.studioId]);
      }).catch((e: { code?: string }) => { aCode = e.code ?? "error"; });
      await bPromise;
      expect(aCode, "booking-order transaction").toBeNull();
      expect(bCode, "practitioner delete").toBeNull();
    } finally {
      await dropSynthStudio(S);
    }
  });

  // Randomised race against the REAL booking command, as Photos' block race does: a break-rule create/update/delete and a booking for the
  // same studio at the same moment. Every outcome must be created or an honest refusal (23P01 exclusion, buffer_conflict, P0002 for a rule
  // already gone); never 40P01 or any other error.
  describe("break rule commands against a real booking (random race)", () => {
    const DATE = "2031-09-16";
    const DOW = new Date(`${DATE}T12:00:00Z`).getUTCDay();
    const ROUNDS = 6;
    const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");
    const HONEST = new Set(["23P01", "P0002"]);
    let B: SynthStudio;
    let serviceId: string;
    const owner = () => B.practitioners[0].practitionerId;

    async function setup(capacity: boolean) {
      B = await seedSynthStudioB();
      await adminQuery(
        `update public.studios set practitioner_capacity_enabled = $2, practitioner_capacity_booking_enabled = $2, timezone = 'UTC', buffer_minutes = 30 where id = $1`,
        [B.studioId, capacity],
      );
      serviceId = (await adminQuery(
        `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active) values ($1,$2,'Consult',60,0,true) returning id`,
        [randomUUID(), B.studioId],
      )).rows[0].id as string;
      await adminQuery(
        `insert into public.studio_availability_default (id, studio_id, day_of_week, is_open, open_time, close_time) values (gen_random_uuid(),$1,$2,true,'00:00','23:59')`,
        [B.studioId, DOW],
      );
      for (const p of B.practitioners) {
        await adminQuery(`insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($1,$2,$3) on conflict do nothing`, [B.studioId, serviceId, p.practitionerId]);
      }
    }
    const book = async (start: string) => {
      try {
        const r = await adminQuery(
          `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,false)`,
          [B.studioId, owner(), owner(), B.clientId, serviceId, start, hash64()],
        );
        const result = (r.rows[0] as { result: string }).result;
        return result === "created" || result === "buffer_conflict" ? "ok" : `named:${result}`;
      } catch (e) {
        const c = (e as { code?: string }).code ?? "unknown";
        return HONEST.has(c) ? "ok" : `error:${c}`;
      }
    };
    const ruleCmd = (sql: string, params: unknown[]) => async () => {
      try {
        await adminQuery(sql, params);
        return "ok";
      } catch (e) {
        const c = (e as { code?: string }).code ?? "unknown";
        return HONEST.has(c) ? "ok" : `error:${c}`;
      }
    };

    for (const capacity of [false, true]) {
      for (const kind of ["create", "update", "delete"] as const) {
        it(`${kind} a break rule vs a booking, capacity ${capacity ? "ON" : "OFF"}: no deadlock, no other error`, async () => {
          await setup(capacity);
          try {
            for (let i = 0; i < ROUNDS; i += 1) {
              const start = `${DATE}T${String(10 + i).padStart(2, "0")}:00:00.000Z`;
              // Every round starts from no rules: rules left by earlier rounds would overlap the next round's rule (23P01 in the setup).
              await adminQuery(
                `select public.delete_recurring_break_rule(id, studio_id) from public.studio_recurring_break_rules where studio_id = $1`,
                [B.studioId],
              );
              let racer: () => Promise<string>;
              if (kind === "create") {
                racer = ruleCmd(
                  `select public.create_recurring_break_rule_and_materialize($1,'lunch','{1,2,3,4,5}'::int[],'12:00','13:00',true,$2,(current_date + 30)::date,null)`,
                  [B.studioId, owner()],
                );
              } else {
                const id = (await adminQuery(
                  `select public.create_recurring_break_rule_and_materialize($1,'lunch','{1,2,3,4,5}'::int[],'12:00','13:00',true,$2,(current_date + 30)::date,null) as id`,
                  [B.studioId, owner()],
                )).rows[0].id as string;
                racer = kind === "update"
                  ? ruleCmd(`select public.update_recurring_break_rule_and_rematerialize($1,$2,'l2','{1,2}'::int[],'14:00','15:00',true,(current_date + 30)::date,null)`, [id, B.studioId])
                  : ruleCmd(`select public.delete_recurring_break_rule($1,$2)`, [id, B.studioId]);
              }
              const out = await Promise.all([racer(), book(start)]);
              expect(out, `round ${i}`).toEqual(["ok", "ok"]);
            }
          } finally {
            await dropSynthStudio(B);
          }
        });
      }
    }
  });
});
