import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL } from "@/e2e/helpers/local-env";
import { adminQuery, adminTx, closePool, seedStudio } from "./helpers/harness";

// 0300 — PAY-006 legacy history BOUNDED ABOVE by its own insert time, proved
// against real PostgreSQL. Synthetic data only.
//
// 0245 returned unknown_event_order whenever the client's same-mode history
// held ANY NULL-evidence (pre-0245) row, so such a client could never save or
// replace a card again (live incident 2026-11-04). 0300 lets a success event
// through ONLY when it is strictly newer than ceil(epoch(created_at)) + 900 s of
// every legacy row, and then runs 0245's known-evidence logic unchanged.
//
// Legacy rows are written here the way the pre-0245 writers wrote them (NULL
// evidence, added_via 'portal'); created_at is set explicitly ONLY to put the
// synthetic row at a known instant. Proof of the bound:
// docs/production/0300-card-legacy-event-order-bound.md.

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const MARGIN = 900;
// A legacy insert instant with a fractional second, so the ceil() is exercised:
// bound = (T_L + 1) + 900.
const T_L = 1_790_000_000;
const LEGACY_CREATED_AT = T_L + 0.25;
const BOUND = T_L + 1 + MARGIN;

const savedEnv = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  stripe: process.env.STRIPE_SECRET_KEY,
};
let admin: SupabaseClient;
let ensureCardChangeNotification: (typeof import("@/lib/billing/card-change-notification"))["ensureCardChangeNotification"];

beforeAll(async () => {
  // createAdminClient() must reach the SAME isolated stack as the pg pool.
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  admin = (await import("@/lib/supabase/admin-server")).createAdminClient();
  ({ ensureCardChangeNotification } = await import("@/lib/billing/card-change-notification"));
});

afterAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = savedEnv.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = savedEnv.key;
  process.env.STRIPE_SECRET_KEY = savedEnv.stripe;
  await closePool();
});

type Fixture = { studioId: string; clientId: string; practitionerId: string; acct: string; cust: string };

async function seedCardStudio(label: string): Promise<Fixture> {
  const s = await seedStudio(label);
  const acct = `acct_${randomUUID().slice(0, 12)}`;
  const cust = `cus_${randomUUID().slice(0, 12)}`;
  await adminQuery(
    `insert into public.studio_payment_settings
       (studio_id, stripe_account_id, stripe_livemode, stripe_charges_enabled,
        stripe_payouts_enabled, require_card_on_file, default_charge_currency)
     values ($1,$2,false,true,true,false,'cad')`,
    [s.studioId, acct],
  );
  await adminQuery(
    `insert into public.client_stripe_customers
       (client_id, studio_id, stripe_account_id, stripe_livemode, stripe_customer_id)
     values ($1,$2,$3,false,$4)`,
    [s.clientId, s.studioId, acct, cust],
  );
  return { ...s, acct, cust };
}

/** A pre-0245 row: NULL success evidence, inserted at a known instant. */
async function seedLegacy(
  f: Fixture,
  opts: { status?: "active" | "removed"; addedVia?: string; createdAt?: number; seti?: string } = {},
) {
  const seti = opts.seti ?? `seti_legacy_${randomUUID().slice(0, 8)}`;
  const status = opts.status ?? "active";
  const r = await adminQuery(
    `insert into public.client_payment_methods
       (studio_id, client_id, stripe_account_id, stripe_livemode, stripe_customer_id,
        stripe_payment_method_id, stripe_setup_intent_id, brand, last4, exp_month, exp_year,
        status, removed_at, added_via, added_at, created_at)
     values ($1,$2,$3,false,$4,$5,$6,'visa','4242',12,2030,$7,
             case when $7 = 'removed' then to_timestamp($9) end, $8,
             to_timestamp($9), to_timestamp($9))
     returning id`,
    [f.studioId, f.clientId, f.acct, f.cust, `pm_${seti}`, seti, status,
      opts.addedVia ?? "portal", opts.createdAt ?? LEGACY_CREATED_AT],
  );
  return { id: r.rows[0].id as string, seti };
}

async function ordered(f: Fixture, si: string, clock: number, event = `evt_${si}`, pm = `pm_${si}`) {
  const r = await adminQuery(
    `select * from public.save_client_card_on_file_ordered(
       $1,$2,$3,false,$4,$5,$6,'visa','4242',12,2030,null,$7,$8)`,
    [f.studioId, f.clientId, f.acct, f.cust, pm, si, event, clock],
  );
  return r.rows[0] as { outcome: string; card_id: string | null; previous_card_id: string | null };
}

async function row(id: string) {
  const r = await adminQuery(`select * from public.client_payment_methods where id=$1`, [id]);
  return r.rows[0] as Record<string, unknown>;
}

async function activeCards(f: Fixture) {
  const r = await adminQuery(
    `select id, stripe_setup_intent_id, stripe_setup_success_event_id,
            stripe_setup_success_event_created::text as created
       from public.client_payment_methods
      where studio_id=$1 and client_id=$2 and stripe_livemode=false and status='active'`,
    [f.studioId, f.clientId],
  );
  return r.rows;
}

/** Columns whose value differs between two snapshots of one row. */
function changed(before: Record<string, unknown>, after: Record<string, unknown>) {
  return Object.keys(before)
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .sort();
}

// The 0180 retire is the ONLY sanctioned change to a legacy row: status and
// removed_at (0180 step 6), plus updated_at from the 0058 BEFORE UPDATE trigger.
const RETIRE_COLUMNS = ["removed_at", "status", "updated_at"];

describe("0300 (a) — REPRODUCE: 0245's body refuses a provably newer event forever", () => {
  it("under the exact 0245 body (read from the held rollback) a legacy client gets unknown_event_order; under 0300 the same call inserts", async () => {
    const rollback = readFileSync(
      join(__dirname, "..", "..", "supabase", "rollbacks", "0300_card_setup_legacy_event_order_bound.down.sql"),
      "utf8",
    );
    const start = rollback.indexOf("create or replace function public.save_client_card_on_file_ordered(");
    const end = rollback.indexOf("\n$$;", start) + "\n$$;".length;
    const oldBody = rollback.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(oldBody.endsWith("$$;")).toBe(true);

    const f = await seedCardStudio("legacy-repro");
    const legacy = await seedLegacy(f);
    const ROLLED_BACK = new Error("rolled back on purpose");
    let under0245: string | undefined;
    await expect(
      adminTx(async (query) => {
        // DDL is transactional: the 0245 body exists only inside this transaction.
        await query(oldBody);
        const r = await query(
          `select * from public.save_client_card_on_file_ordered(
             $1,$2,$3,false,$4,'pm_seti_new','seti_new','visa','4242',12,2030,null,'evt_seti_new',$5)`,
          [f.studioId, f.clientId, f.acct, f.cust, T_L + 86_400],
        );
        under0245 = r.rows[0].outcome;
        throw ROLLED_BACK;
      }),
    ).rejects.toBe(ROLLED_BACK);
    expect(under0245).toBe("unknown_event_order");
    // The rollback really rolled back: nothing changed, and 0300 is live again.
    expect(await activeCards(f)).toMatchObject([{ id: legacy.id }]);
    expect((await ordered(f, "seti_new", T_L + 86_400)).outcome).toBe("inserted");
  });
});

describe("0300 — active legacy card", () => {
  it("(b) an event strictly after the bound inserts, retires the legacy card, and carries its evidence", async () => {
    const f = await seedCardStudio("legacy-newer");
    const legacy = await seedLegacy(f);
    const before = await row(legacy.id);

    const out = await ordered(f, "seti_new", BOUND + 1);
    expect(out.outcome).toBe("inserted");
    expect(out.previous_card_id).toBe(legacy.id);

    const active = await activeCards(f);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      id: out.card_id,
      stripe_setup_intent_id: "seti_new",
      stripe_setup_success_event_id: "evt_seti_new",
      created: String(BOUND + 1),
    });
    // Old record keeps NULL evidence; only the 0180 retire touched it.
    const after = await row(legacy.id);
    expect(changed(before, after)).toEqual(RETIRE_COLUMNS);
    expect(after.status).toBe("removed");
    expect(after.removed_at).not.toBeNull();
    expect(after.stripe_setup_success_event_id).toBeNull();
    expect(after.stripe_setup_success_event_created).toBeNull();
    expect(after.created_at).toEqual(before.created_at);
  });

  it("(c) STALE: an event older than the legacy row is refused; the legacy card is unchanged", async () => {
    const f = await seedCardStudio("legacy-older");
    const legacy = await seedLegacy(f);
    const before = await row(legacy.id);
    for (const clock of [T_L - 3_600, T_L - 1, T_L]) {
      expect((await ordered(f, `seti_old_${clock}`, clock)).outcome).toBe("unknown_event_order");
    }
    expect(changed(before, await row(legacy.id))).toEqual([]);
    expect(await activeCards(f)).toMatchObject([{ id: legacy.id }]);
  });

  it("(d) inside the margin, and EXACTLY at the bound, is refused; bound + 1 is the first admitted second", async () => {
    const f = await seedCardStudio("legacy-margin");
    const legacy = await seedLegacy(f);
    const before = await row(legacy.id);
    for (const clock of [T_L + 1, T_L + 300, BOUND - 1, BOUND]) {
      expect((await ordered(f, `seti_in_${clock}`, clock)).outcome).toBe("unknown_event_order");
    }
    expect(changed(before, await row(legacy.id))).toEqual([]);
    expect((await ordered(f, "seti_first_admitted", BOUND + 1)).outcome).toBe("inserted");
  });

  it("(e) DUPLICATE: the same event twice is inserted then idempotent; one row, one notification", async () => {
    const f = await seedCardStudio("legacy-dup");
    await seedLegacy(f);
    const first = await ordered(f, "seti_dup", BOUND + 60);
    const n1 = await ensureCardChangeNotification(admin, {
      studioId: f.studioId, clientId: f.clientId, livemode: false, setupIntentId: "seti_dup",
    });
    const second = await ordered(f, "seti_dup", BOUND + 60);
    const n2 = await ensureCardChangeNotification(admin, {
      studioId: f.studioId, clientId: f.clientId, livemode: false, setupIntentId: "seti_dup",
    });

    expect(first.outcome).toBe("inserted");
    expect(second).toMatchObject({ outcome: "idempotent", card_id: first.card_id, previous_card_id: null });
    expect(n1).toMatchObject({ eventType: "card_replaced", deduped: false });
    expect(n2).toMatchObject({ eventType: "card_replaced", deduped: true });

    const byEvent = await adminQuery(
      `select count(*)::int as n from public.client_payment_methods
        where stripe_account_id=$1 and stripe_livemode=false and stripe_setup_success_event_id='evt_seti_dup'`,
      [f.acct],
    );
    expect(byEvent.rows[0].n).toBe(1);
    const notices = await adminQuery(
      `select count(*)::int as n from public.practitioner_notifications where studio_id=$1 and dedupe_key=$2`,
      [f.studioId, "stripe:setup_intent:test:seti_dup"],
    );
    expect(notices.rows[0].n).toBe(1);
    expect(await activeCards(f)).toHaveLength(1);
  });

  it("a redelivered pre-0245 success for the legacy row's OWN intent stays unknown (never stale, never idempotent)", async () => {
    const f = await seedCardStudio("legacy-same-intent");
    const legacy = await seedLegacy(f);
    const before = await row(legacy.id);
    for (const clock of [T_L - 5, BOUND + 86_400]) {
      expect((await ordered(f, legacy.seti, clock, `evt_${clock}`, `pm_${legacy.seti}`)).outcome).toBe("unknown_event_order");
    }
    expect(changed(before, await row(legacy.id))).toEqual([]);
  });

  it("a NULL row not attested by the webhook writers (added_via <> 'portal') keeps 0245's refusal", async () => {
    const f = await seedCardStudio("legacy-untrusted");
    const legacy = await seedLegacy(f, { addedVia: "practitioner_recovery" });
    expect((await ordered(f, "seti_far", BOUND + 10 * 86_400)).outcome).toBe("unknown_event_order");
    expect(await activeCards(f)).toMatchObject([{ id: legacy.id }]);
  });
});

describe("0300 (f) — removed-only legacy history", () => {
  it("behaves like (b) and (c): older refused, newer inserted with no previous card, legacy rows untouched", async () => {
    const f = await seedCardStudio("legacy-removed");
    const a = await seedLegacy(f, { status: "removed", createdAt: T_L - 86_400 });
    const b = await seedLegacy(f, { status: "removed" }); // the greatest bound wins
    const beforeA = await row(a.id);
    const beforeB = await row(b.id);

    // Newer than row a's bound but not row b's: still refused.
    expect((await ordered(f, "seti_mid", T_L - 86_400 + 2 + MARGIN)).outcome).toBe("unknown_event_order");
    expect((await ordered(f, "seti_older", T_L - 10)).outcome).toBe("unknown_event_order");
    expect((await ordered(f, "seti_inside", BOUND)).outcome).toBe("unknown_event_order");
    expect(await activeCards(f)).toHaveLength(0);

    const out = await ordered(f, "seti_new", BOUND + 1);
    expect(out).toMatchObject({ outcome: "inserted", previous_card_id: null });
    expect(await activeCards(f)).toMatchObject([{ id: out.card_id, stripe_setup_success_event_id: "evt_seti_new" }]);
    // Already removed, so nothing retires them: not one column changes.
    expect(changed(beforeA, await row(a.id))).toEqual([]);
    expect(changed(beforeB, await row(b.id))).toEqual([]);
  });
});

describe("0300 (g) — known evidence keeps 0245's stale / ambiguous / idempotent behaviour beside legacy rows", () => {
  it("after a bound-clearing insert, older-but-past-bound is stale, equal is ambiguous, same intent is idempotent", async () => {
    const f = await seedCardStudio("legacy-known");
    await seedLegacy(f);
    const b = await ordered(f, "seti_b", BOUND + 1_000);
    expect(b.outcome).toBe("inserted");
    expect((await ordered(f, "seti_a", BOUND + 500)).outcome).toBe("stale_event");
    expect((await ordered(f, "seti_tie", BOUND + 1_000)).outcome).toBe("ambiguous_event_order");
    expect(await ordered(f, "seti_b", BOUND + 1_000)).toMatchObject({ outcome: "idempotent", card_id: b.card_id });
    // Inside the legacy margin stays UNKNOWN even though it is also older than b.
    expect((await ordered(f, "seti_inside", BOUND)).outcome).toBe("unknown_event_order");
    const c = await ordered(f, "seti_c", BOUND + 2_000);
    expect(c).toMatchObject({ outcome: "inserted", previous_card_id: b.card_id });
    expect(await activeCards(f)).toMatchObject([{ id: c.card_id }]);
  });

  it("SAME-SECOND: two different events with equal created give inserted then ambiguous_event_order", async () => {
    const f = await seedCardStudio("legacy-same-second");
    await seedLegacy(f);
    const first = await ordered(f, "seti_one", BOUND + 7);
    expect(first.outcome).toBe("inserted");
    expect((await ordered(f, "seti_two", BOUND + 7)).outcome).toBe("ambiguous_event_order");
    expect(await activeCards(f)).toMatchObject([{ id: first.card_id }]);
  });
});

describe("0300 — CONCURRENT different new events on two connections", () => {
  it("both wait on the real coarse lock; the greater signed success wins; never two active cards", async () => {
    const f = await seedCardStudio("legacy-concurrent");
    const legacy = await seedLegacy(f);
    let workers: Promise<Awaited<ReturnType<typeof ordered>>[]> | undefined;
    await adminTx(async (query) => {
      await query(`select pg_advisory_xact_lock(hashtextextended($1 || '|' || $2 || '|f',0))`, [f.studioId, f.clientId]);
      workers = Promise.all([ordered(f, "seti_early", BOUND + 100), ordered(f, "seti_late", BOUND + 200)]);
      // Attach immediately so an early command failure is never unhandled.
      void workers.catch(() => undefined);
      // Wait for a REAL lock wait (pg_locks), not a sleep standing in for one.
      let waiting = 0;
      for (let retry = 0; retry < 100; retry++) {
        const locks = await query(`with k as (select hashtextextended($1 || '|' || $2 || '|f',0) as key)
          select count(*)::int as n from pg_locks, k where locktype='advisory' and not granted
          and classid::bigint=((k.key >> 32) & 4294967295::bigint)
          and objid::bigint=(k.key & 4294967295::bigint) and objsubid=1`, [f.studioId, f.clientId]);
        waiting = locks.rows[0].n;
        if (waiting === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(2);
    });
    // Settle both deferred commands before asserting anything.
    const [early, late] = await workers!;
    expect(late.outcome).toBe("inserted");
    // Whichever took the lock first: early is either superseded or refused stale.
    expect(["inserted", "stale_event"]).toContain(early.outcome);
    const active = await activeCards(f);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ stripe_setup_intent_id: "seti_late", created: String(BOUND + 200) });
    const legacyAfter = await row(legacy.id);
    expect(legacyAfter.status).toBe("removed");
    expect(legacyAfter.stripe_setup_success_event_created).toBeNull();
  });
});

describe("0300 — command authority is unchanged", () => {
  it("unordered command closed to every API role; ordered command service_role only", async () => {
    const sig = "uuid,uuid,text,boolean,text,text,text,text,text,integer,integer,uuid";
    const r = await adminQuery(`select
      has_function_privilege('service_role','public.save_client_card_on_file(${sig})','EXECUTE') as old_service,
      has_function_privilege('authenticated','public.save_client_card_on_file(${sig})','EXECUTE') as old_authenticated,
      has_function_privilege('anon','public.save_client_card_on_file(${sig})','EXECUTE') as old_anon,
      has_function_privilege('service_role','public.save_client_card_on_file_ordered(${sig},text,bigint)','EXECUTE') as new_service,
      has_function_privilege('authenticated','public.save_client_card_on_file_ordered(${sig},text,bigint)','EXECUTE') as new_authenticated,
      has_function_privilege('anon','public.save_client_card_on_file_ordered(${sig},text,bigint)','EXECUTE') as new_anon,
      has_function_privilege('public','public.save_client_card_on_file_ordered(${sig},text,bigint)','EXECUTE') as new_public`);
    expect(r.rows[0]).toEqual({
      old_service: false, old_authenticated: false, old_anon: false,
      new_service: true, new_authenticated: false, new_anon: false, new_public: false,
    });
  });
});
