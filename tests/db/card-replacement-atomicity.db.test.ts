import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// 0180: CARD-ON-FILE REPLACEMENT INTEGRITY, proved against real PostgreSQL.
//
// The defect these tests exist for: `client_payment_methods_one_active_per_pair`
// is a partial unique index on (studio_id, client_id, stripe_livemode) WHERE
// status='active', so a replacement MUST retire the old active row before
// inserting the new one. The webhook did that as two independent PostgREST
// writes, each in its own transaction, so any non-23505 failure of the INSERT
// left the client with ZERO ACTIVE CARDS after their working card had already
// been retired.
//
// save_client_card_on_file makes the retire + insert one transaction.
//
// Fixtures are isolated by run-unique identity (random UUIDs / ids), never by
// cleanup, so this suite is safe to re-run against the same database.

afterAll(async () => {
  await closePool();
});

const LIVEMODE = false;

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "NO_ERROR";
  } catch (e) {
    return (e as { code?: string }).code ?? "UNKNOWN";
  }
}

/** A studio wired for card-on-file: payment settings + a Stripe customer. */
async function seedCardStudio(label: string) {
  const s: SeededStudio = await seedStudio(label);
  const acct = `acct_${randomUUID().slice(0, 12)}`;
  const cust = `cus_${randomUUID().slice(0, 12)}`;
  await adminQuery(
    `insert into public.studio_payment_settings
       (studio_id, stripe_account_id, stripe_livemode, stripe_charges_enabled,
        stripe_payouts_enabled, require_card_on_file, default_charge_currency)
     values ($1,$2,$3,true,true,false,'cad')`,
    [s.studioId, acct, LIVEMODE],
  );
  await adminQuery(
    `insert into public.client_stripe_customers
       (client_id, studio_id, stripe_account_id, stripe_livemode, stripe_customer_id)
     values ($1,$2,$3,$4,$5)`,
    [s.clientId, s.studioId, acct, LIVEMODE, cust],
  );
  return { ...s, acct, cust };
}

type SaveArgs = { seti?: string; pm?: string; sig?: string | null };

async function saveCard(
  f: Awaited<ReturnType<typeof seedCardStudio>>,
  { seti, pm, sig = null }: SaveArgs = {},
) {
  const res = await adminQuery(
    `select * from public.save_client_card_on_file(
       $1,$2,$3,$4,$5,$6,$7,'visa','4242',12,2030,$8)`,
    [
      f.studioId,
      f.clientId,
      f.acct,
      LIVEMODE,
      f.cust,
      pm ?? `pm_${randomUUID().slice(0, 12)}`,
      seti ?? `seti_${randomUUID().slice(0, 12)}`,
      sig,
    ],
  );
  return res.rows[0];
}

async function activeCards(f: { studioId: string; clientId: string }) {
  const r = await adminQuery(
    `select id, stripe_setup_intent_id from public.client_payment_methods
      where studio_id=$1 and client_id=$2 and stripe_livemode=$3 and status='active'`,
    [f.studioId, f.clientId, LIVEMODE],
  );
  return r.rows;
}

describe("0180: atomic card replacement", () => {
  it("inserts the first card and reports no previous card", async () => {
    const f = await seedCardStudio("card-first");
    const out = await saveCard(f);
    expect(out.outcome).toBe("inserted");
    expect(out.card_id).toBeTruthy();
    expect(out.previous_card_id).toBeNull();
    expect(await activeCards(f)).toHaveLength(1);
  });

  it("replacement retires the old card and activates the new one, atomically", async () => {
    const f = await seedCardStudio("card-replace");
    const first = await saveCard(f);
    const second = await saveCard(f);

    expect(second.outcome).toBe("inserted");
    expect(second.previous_card_id).toBe(first.card_id);

    // Exactly one active card, and it is the new one.
    const active = await activeCards(f);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(second.card_id);

    // The old card is retired, not deleted, history survives.
    const old = await adminQuery(
      `select status, removed_at from public.client_payment_methods where id=$1`,
      [first.card_id],
    );
    expect(old.rows[0].status).toBe("removed");
    expect(old.rows[0].removed_at).not.toBeNull();
  });

  it("THE DEFECT: a failed replacement leaves the PREVIOUS card active", async () => {
    // This is the whole point of 0180. We force the insert to fail *after* the
    // retire would have happened, by violating a column check constraint
    // (last4 length) inside the same call. Pre-0180 the retire was a separate
    // committed statement, so the client would have been left with zero cards.
    const f = await seedCardStudio("card-atomic");
    const first = await saveCard(f);
    expect(await activeCards(f)).toHaveLength(1);

    const code = await codeOf(() =>
      adminQuery(
        `select * from public.save_client_card_on_file(
           $1,$2,$3,$4,$5,$6,$7,'visa','THIS_IS_NOT_LAST4',12,2030,null)`,
        [
          f.studioId,
          f.clientId,
          f.acct,
          LIVEMODE,
          f.cust,
          `pm_${randomUUID().slice(0, 12)}`,
          `seti_${randomUUID().slice(0, 12)}`,
        ],
      ),
    );
    expect(code).not.toBe("NO_ERROR");

    // The previous card is STILL ACTIVE, the retire rolled back with the insert.
    const active = await activeCards(f);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(first.card_id);
  });

  it("is idempotent for a duplicate delivery of the same SetupIntent", async () => {
    const f = await seedCardStudio("card-idem");
    const seti = `seti_${randomUUID().slice(0, 12)}`;
    const a = await saveCard(f, { seti });
    const b = await saveCard(f, { seti });

    expect(a.outcome).toBe("inserted");
    expect(b.outcome).toBe("idempotent");
    expect(b.card_id).toBe(a.card_id);
    expect(b.previous_card_id).toBeNull();
    // A redelivery must never retire the row the first delivery inserted.
    const active = await activeCards(f);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(a.card_id);
  });

  it("concurrent replacements cannot leave zero active cards, and one wins", async () => {
    const f = await seedCardStudio("card-concurrent");
    await saveCard(f);

    // Two DIFFERENT SetupIntents racing: claim_stripe_event only serialises
    // redeliveries of the SAME event, so this race is real.
    const [r1, r2] = await Promise.allSettled([
      saveCard(f, { seti: `seti_${randomUUID().slice(0, 12)}` }),
      saveCard(f, { seti: `seti_${randomUUID().slice(0, 12)}` }),
    ]);
    // Whatever happens, the invariant holds.
    const active = await activeCards(f);
    expect(active).toHaveLength(1);
    // At least one must have succeeded; a loser may only fail, never corrupt.
    expect([r1.status, r2.status]).toContain("fulfilled");
  });

  it("refuses a customer that does not belong to this (studio, client, mode)", async () => {
    const a = await seedCardStudio("card-lineage-a");
    const b = await seedCardStudio("card-lineage-b");
    const code = await codeOf(() =>
      adminQuery(
        `select * from public.save_client_card_on_file(
           $1,$2,$3,$4,$5,$6,$7,'visa','4242',12,2030,null)`,
        [
          a.studioId,
          a.clientId,
          a.acct,
          LIVEMODE,
          b.cust, // another studio's Stripe customer
          `pm_${randomUUID().slice(0, 12)}`,
          `seti_${randomUUID().slice(0, 12)}`,
        ],
      ),
    );
    expect(code).toBe("22023");
    expect(await activeCards(a)).toHaveLength(0);
  });

  it("refuses a card-authorization signature from another client", async () => {
    const a = await seedCardStudio("card-sig-a");
    const code = await codeOf(() =>
      adminQuery(
        `select * from public.save_client_card_on_file(
           $1,$2,$3,$4,$5,$6,$7,'visa','4242',12,2030,$8)`,
        [
          a.studioId,
          a.clientId,
          a.acct,
          LIVEMODE,
          a.cust,
          `pm_${randomUUID().slice(0, 12)}`,
          `seti_${randomUUID().slice(0, 12)}`,
          randomUUID(), // a signature id that is not this client's
        ],
      ),
    );
    expect(code).toBe("22023");
    expect(await activeCards(a)).toHaveLength(0);
  });

  it("refuses a NULL tuple component rather than writing a partial row", async () => {
    const f = await seedCardStudio("card-null");
    const code = await codeOf(() =>
      adminQuery(
        `select * from public.save_client_card_on_file(
           $1,$2,$3,$4,$5,null,$6,'visa','4242',12,2030,null)`,
        [f.studioId, f.clientId, f.acct, LIVEMODE, f.cust, `seti_${randomUUID().slice(0, 12)}`],
      ),
    );
    expect(code).toBe("22023");
    expect(await activeCards(f)).toHaveLength(0);
  });
});

describe("0180, negative control: the pre-0180 two-write sequence really did lose the card", () => {
  it("retire-then-failing-insert as SEPARATE transactions leaves ZERO active cards", async () => {
    // This reproduces EXACTLY what the webhook used to do: a PostgREST UPDATE
    // that retires the active row, then a separate PostgREST INSERT. Each is
    // its own transaction, so the retire is already committed when the insert
    // fails. Without this control the atomicity test above could pass
    // vacuously, it proves the failure mode 0180 exists to remove is real,
    // and that this suite would catch a regression back to it.
    const f = await seedCardStudio("card-nc-twowrite");
    const first = await saveCard(f);
    expect(await activeCards(f)).toHaveLength(1);

    // Write 1: retire (commits on its own, exactly as PostgREST would).
    await adminQuery(
      `update public.client_payment_methods
          set status='removed', removed_at=now()
        where studio_id=$1 and client_id=$2 and stripe_livemode=$3 and status='active'`,
      [f.studioId, f.clientId, LIVEMODE],
    );

    // Write 2: insert fails (same check violation used above).
    const code = await codeOf(() =>
      adminQuery(
        `insert into public.client_payment_methods
           (studio_id, client_id, stripe_account_id, stripe_livemode, stripe_customer_id,
            stripe_payment_method_id, stripe_setup_intent_id, brand, last4, exp_month,
            exp_year, status, added_via)
         values ($1,$2,$3,$4,$5,$6,$7,'visa','THIS_IS_NOT_LAST4',12,2030,'active','portal')`,
        [
          f.studioId,
          f.clientId,
          f.acct,
          LIVEMODE,
          f.cust,
          `pm_${randomUUID().slice(0, 12)}`,
          `seti_${randomUUID().slice(0, 12)}`,
        ],
      ),
    );
    expect(code).not.toBe("NO_ERROR");

    // THE BUG: the client now has NO active card, and their working card is gone.
    expect(await activeCards(f)).toHaveLength(0);
    const old = await adminQuery(
      `select status from public.client_payment_methods where id=$1`,
      [first.card_id],
    );
    expect(old.rows[0].status).toBe("removed");
  });
});

describe("B/D: terminal rejection is CLIENT-BOUND and fail-closed", () => {
  // The portal's rejection authority is stripe_events.payload_summary (committed
  // by mark_stripe_event_processed), NOT ops_alerts, whose insert is
  // best-effort. But durability alone is not authorization: stripe_events.studio_id
  // is derived from the connected account, so it is NULL for a
  // missing_account_context rejection and may name a DIFFERENT studio for a
  // studio_metadata_mismatch. Scoping by studio_id alone both missed real
  // rejections and let any same-studio client probe any SetupIntent id.
  //
  // Ownership is proved through Hone's own provisioning table instead:
  // client_stripe_customers is UNIQUE on
  // (stripe_account_id, stripe_livemode, stripe_customer_id), so the customer on
  // the event resolves to exactly one (studio, client). These exercise the EXACT
  // query pair confirmCardPersistedAction runs.
  async function seedRejection(
    setupIntentId: string,
    summary: Record<string, unknown>,
    opts: { studioId?: string | null; processed?: boolean } = {},
  ) {
    const { studioId = null, processed = true } = opts;
    await adminQuery(
      `insert into public.stripe_events
         (stripe_event_id, event_type, stripe_account_id, stripe_livemode,
          studio_id, processed_at, payload_summary)
       values ($1,'setup_intent.succeeded',$2,$3,$4,$5,$6::jsonb)`,
      [
        `evt_${randomUUID().slice(0, 12)}`,
        `acct_${randomUUID().slice(0, 8)}`,
        LIVEMODE,
        studioId,
        processed ? new Date().toISOString() : null,
        JSON.stringify({
          eventType: "setup_intent.succeeded",
          setupIntentId,
          terminalRejection: true,
          opsAlertAttempted: true,
          ...summary,
        }),
      ],
    );
  }

  /** The action's two-step lookup: durable rejection, then client ownership. */
  async function rejectedForClient(
    studioId: string,
    clientId: string,
    setupIntentId: string,
  ): Promise<boolean> {
    const evts = await adminQuery(
      `select payload_summary from public.stripe_events
        where event_type = 'setup_intent.succeeded'
          and processed_at is not null
          and payload_summary->>'setupIntentId' = $1
          and payload_summary->>'terminalRejection' = 'true'
        limit 5`,
      [setupIntentId],
    );
    for (const row of evts.rows) {
      const sum = row.payload_summary as Record<string, unknown>;
      if (
        typeof sum.stripeCustomerId !== "string" ||
        typeof sum.stripeAccountId !== "string" ||
        typeof sum.stripeLivemode !== "boolean"
      ) {
        continue; // unattributable -> fail closed
      }
      const owner = await adminQuery(
        `select client_id from public.client_stripe_customers
          where stripe_account_id = $1 and stripe_livemode = $2
            and stripe_customer_id = $3 and studio_id = $4 and client_id = $5`,
        [sum.stripeAccountId, sum.stripeLivemode, sum.stripeCustomerId, studioId, clientId],
      );
      if ((owner.rowCount ?? 0) > 0) return true;
    }
    return false;
  }

  it("A: the owning client sees their own terminal rejection", async () => {
    const f = await seedCardStudio("bind-owner");
    const seti = `seti_${randomUUID().slice(0, 12)}`;
    await seedRejection(seti, {
      stripeCustomerId: f.cust,
      stripeAccountId: f.acct,
      stripeLivemode: LIVEMODE,
      rejected: "signature_lineage_mismatch",
    }, { studioId: f.studioId });
    expect(await rejectedForClient(f.studioId, f.clientId, seti)).toBe(true);
  });

  it("B: SAME STUDIO, different client cannot see it even with the exact SetupIntent id", async () => {
    // THE MISSING CONTROL. A SetupIntent id is not authorization.
    const a = await seedCardStudio("bind-same-a");
    const otherClientId = randomUUID();
    await adminQuery(
      `insert into public.clients (id, studio_id, name) values ($1,$2,'Same-studio other')`,
      [otherClientId, a.studioId],
    );
    const seti = `seti_${randomUUID().slice(0, 12)}`;
    await seedRejection(seti, {
      stripeCustomerId: a.cust,
      stripeAccountId: a.acct,
      stripeLivemode: LIVEMODE,
      rejected: "signature_lineage_mismatch",
    }, { studioId: a.studioId });

    expect(await rejectedForClient(a.studioId, a.clientId, seti)).toBe(true);
    expect(await rejectedForClient(a.studioId, otherClientId, seti)).toBe(false);
  });

  it("C: a different studio cannot see it", async () => {
    const a = await seedCardStudio("bind-studio-a");
    const b = await seedCardStudio("bind-studio-b");
    const seti = `seti_${randomUUID().slice(0, 12)}`;
    await seedRejection(seti, {
      stripeCustomerId: a.cust,
      stripeAccountId: a.acct,
      stripeLivemode: LIVEMODE,
      rejected: "signature_lineage_mismatch",
    }, { studioId: a.studioId });
    expect(await rejectedForClient(a.studioId, a.clientId, seti)).toBe(true);
    expect(await rejectedForClient(b.studioId, b.clientId, seti)).toBe(false);
  });

  it("D: missing_account_context (studio_id NULL) is still visible when the customer binds", async () => {
    // Deliberate: the event carries no studio, but the customer still resolves
    // through client_stripe_customers, so ownership IS provable.
    const f = await seedCardStudio("bind-noacct");
    const seti = `seti_${randomUUID().slice(0, 12)}`;
    await seedRejection(seti, {
      stripeCustomerId: f.cust,
      stripeAccountId: f.acct,
      stripeLivemode: LIVEMODE,
      rejected: "missing_account_context",
    }, { studioId: null });
    expect(await rejectedForClient(f.studioId, f.clientId, seti)).toBe(true);
  });

  it("E: studio_metadata_mismatch stored under ANOTHER studio still binds by customer", async () => {
    // stripe_events.studio_id names the account's studio, which may differ from
    // the portal client's. Binding by customer is what makes this correct.
    const f = await seedCardStudio("bind-mismatch");
    const other = await seedCardStudio("bind-mismatch-other");
    const seti = `seti_${randomUUID().slice(0, 12)}`;
    await seedRejection(seti, {
      stripeCustomerId: f.cust,
      stripeAccountId: f.acct,
      stripeLivemode: LIVEMODE,
      rejected: "studio_metadata_mismatch",
    }, { studioId: other.studioId });
    expect(await rejectedForClient(f.studioId, f.clientId, seti)).toBe(true);
    expect(await rejectedForClient(other.studioId, other.clientId, seti)).toBe(false);
  });

  it("D/E: an UNATTRIBUTABLE rejection fails closed to not-confirmed, never rejected", async () => {
    // missing_customer / customer_lineage_mismatch can leave no usable customer.
    // Nobody may see these as "rejected", the portal shows not-confirmed.
    const f = await seedCardStudio("bind-unattributable");
    const seti = `seti_${randomUUID().slice(0, 12)}`;
    await seedRejection(seti, {
      stripeCustomerId: null,
      stripeAccountId: f.acct,
      stripeLivemode: LIVEMODE,
      rejected: "missing_customer",
    }, { studioId: f.studioId });
    expect(await rejectedForClient(f.studioId, f.clientId, seti)).toBe(false);
  });

  it("F: durable truth is used with NO ops_alerts row present at all", async () => {
    const f = await seedCardStudio("bind-noalert");
    const seti = `seti_${randomUUID().slice(0, 12)}`;
    await seedRejection(seti, {
      stripeCustomerId: f.cust,
      stripeAccountId: f.acct,
      stripeLivemode: LIVEMODE,
      rejected: "non_card_payment_method",
    }, { studioId: f.studioId });
    const alerts = await adminQuery(
      `select id from public.ops_alerts where studio_id=$1 and event='card_on_file_setup_rejected'`,
      [f.studioId],
    );
    expect(alerts.rowCount).toBe(0);
    expect(await rejectedForClient(f.studioId, f.clientId, seti)).toBe(true);
  });

  it("an UNPROCESSED event is not a rejection, Stripe may still retry it", async () => {
    const f = await seedCardStudio("bind-unprocessed");
    const seti = `seti_${randomUUID().slice(0, 12)}`;
    await seedRejection(seti, {
      stripeCustomerId: f.cust,
      stripeAccountId: f.acct,
      stripeLivemode: LIVEMODE,
    }, { studioId: f.studioId, processed: false });
    expect(await rejectedForClient(f.studioId, f.clientId, seti)).toBe(false);
  });

  it("G: malformed or unknown SetupIntent ids leak nothing", async () => {
    const f = await seedCardStudio("bind-unknown");
    expect(await rejectedForClient(f.studioId, f.clientId, "seti_does_not_exist")).toBe(false);
    expect(await rejectedForClient(f.studioId, f.clientId, "not-a-setup-intent")).toBe(false);
    expect(await rejectedForClient(f.studioId, f.clientId, "")).toBe(false);
  });

  it("the saved lookup is bound to the owning client, not just the SetupIntent", async () => {
    const f = await seedCardStudio("bind-saved-owner");
    const other = await seedCardStudio("bind-saved-other");
    const seti = `seti_${randomUUID().slice(0, 12)}`;
    await saveCard(f, { seti });
    const mine = await adminQuery(
      `select id from public.client_payment_methods
        where studio_id=$1 and client_id=$2 and stripe_setup_intent_id=$3 and status='active'`,
      [f.studioId, f.clientId, seti],
    );
    expect(mine.rowCount).toBe(1);
    const theirs = await adminQuery(
      `select id from public.client_payment_methods
        where studio_id=$1 and client_id=$2 and stripe_setup_intent_id=$3 and status='active'`,
      [other.studioId, other.clientId, seti],
    );
    expect(theirs.rowCount).toBe(0);
  });
});

describe("0180: command authority", () => {
  it("is service_role-only; PUBLIC, anon and authenticated cannot execute it", async () => {
    const r = await adminQuery(`
      select has_function_privilege('anon',          p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
             has_function_privilege('service_role',  p.oid, 'EXECUTE') as service_role,
             has_function_privilege('public',        p.oid, 'EXECUTE') as pub
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'save_client_card_on_file'`);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].anon).toBe(false);
    expect(r.rows[0].authenticated).toBe(false);
    expect(r.rows[0].pub).toBe(false);
    expect(r.rows[0].service_role).toBe(true);
  });

  it("leaves the one-active-card-per-mode invariant in place", async () => {
    const r = await adminQuery(`
      select indexdef from pg_indexes
       where indexname = 'client_payment_methods_one_active_per_pair'`);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].indexdef).toContain("studio_id, client_id, stripe_livemode");
    expect(r.rows[0].indexdef).toContain("status = 'active'");
  });
});
