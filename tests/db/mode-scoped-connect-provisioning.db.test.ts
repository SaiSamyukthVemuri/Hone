import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// Migration 0103: mode-scoped Stripe Connect provisioning. A studio can now
// hold one studio_payment_settings row PER MODE (test / live / a null-mode
// placeholder for the dormant require_card_on_file flag), and the five
// settings RPCs are mode-scoped. This exercises the REAL migrated DB:
//   * test + live rows coexist; same-mode duplicates are refused
//   * an existing TEST binding no longer blocks LIVE provisioning (the
//     pre-0103 "already bound to mode f, refusing to provision mode t")
//   * same-mode claims short-circuit to the existing binding (reuse)
//   * in-flight attempts are matched per mode
//   * complete_... writes only the current-mode row
//   * sync_studio_account_status updates only the current-mode row
//   * get_studio_payment_settings_display returns the requested mode's row
//     only (zero rows = not connected), owner-gated
//   * set_studio_require_card_on_file lives on the null-mode placeholder and
//     never interferes with the mode rows
//   * the (studio_id, stripe_account_id, stripe_livemode) FK target still
//     works after the PK swap

let s: SeededStudio;

beforeAll(async () => {
  s = await seedStudio("mode-scope");
});

afterAll(async () => {
  await closePool();
});

type ClaimRow = {
  attempt_id: string | null;
  out_status: string;
  out_stripe_account_id: string | null;
  out_stripe_livemode: boolean | null;
  out_idempotency_key: string | null;
  out_processing_claim_token: string | null;
  should_execute_stripe_call: boolean;
  already_provisioned: boolean;
};

async function claim(studioId: string, livemode: boolean): Promise<ClaimRow> {
  const { rows } = await adminQuery(
    `select * from public.create_or_claim_stripe_account_provisioning($1, $2)`,
    [studioId, livemode],
  );
  return rows[0] as ClaimRow;
}

async function complete(
  attemptId: string,
  claimToken: string,
  acct: string,
  livemode: boolean,
): Promise<void> {
  await adminQuery(
    `select public.complete_stripe_account_provisioning($1, $2, $3, $4)`,
    [attemptId, claimToken, acct, livemode],
  );
}

async function settingsRows(studioId: string) {
  const { rows } = await adminQuery(
    `select stripe_livemode, stripe_account_id, stripe_account_status,
            stripe_charges_enabled, stripe_payouts_enabled, require_card_on_file
       from public.studio_payment_settings
      where studio_id = $1
      order by stripe_livemode nulls first`,
    [studioId],
  );
  return rows as Array<{
    stripe_livemode: boolean | null;
    stripe_account_id: string | null;
    stripe_account_status: string | null;
    stripe_charges_enabled: boolean;
    stripe_payouts_enabled: boolean;
    require_card_on_file: boolean;
  }>;
}

describe("provisioning: existing test binding no longer blocks live", () => {
  it("full flow: test binding exists → live claim provisions, both rows coexist", async () => {
    // 1) Provision the TEST account through the real RPC flow.
    const testClaim = await claim(s.studioId, false);
    expect(testClaim.should_execute_stripe_call).toBe(true);
    expect(testClaim.already_provisioned).toBe(false);
    await complete(
      testClaim.attempt_id!,
      testClaim.out_processing_claim_token!,
      "acct_harness_test_1",
      false,
    );

    // 2) LIVE claim on the SAME studio: pre-0103 this raised
    //    "studio ... is already bound to mode f, refusing to provision mode t".
    //    Now it must hand out a fresh live attempt.
    const liveClaim = await claim(s.studioId, true);
    expect(liveClaim.already_provisioned).toBe(false);
    expect(liveClaim.should_execute_stripe_call).toBe(true);
    expect(liveClaim.out_stripe_livemode).toBe(true);
    await complete(
      liveClaim.attempt_id!,
      liveClaim.out_processing_claim_token!,
      "acct_harness_live_1",
      true,
    );

    // 3) Both mode rows coexist; the test row is untouched.
    const rows = await settingsRows(s.studioId);
    expect(rows.map((r) => [r.stripe_livemode, r.stripe_account_id])).toEqual([
      [false, "acct_harness_test_1"],
      [true, "acct_harness_live_1"],
    ]);
  });

  it("same-mode claim short-circuits to the existing binding (reuse, no new attempt)", async () => {
    const again = await claim(s.studioId, false);
    expect(again.already_provisioned).toBe(true);
    expect(again.should_execute_stripe_call).toBe(false);
    expect(again.out_stripe_account_id).toBe("acct_harness_test_1");
    expect(again.out_stripe_livemode).toBe(false);

    const liveAgain = await claim(s.studioId, true);
    expect(liveAgain.already_provisioned).toBe(true);
    expect(liveAgain.out_stripe_account_id).toBe("acct_harness_live_1");
  });

  it("same-mode duplicate settings row is refused by the (studio, mode) unique", async () => {
    await expect(
      adminQuery(
        `insert into public.studio_payment_settings
           (studio_id, stripe_account_id, stripe_livemode)
         values ($1, 'acct_harness_dupe', false)`,
        [s.studioId],
      ),
    ).rejects.toThrow(/studio_payment_settings_studio_mode_uniq/);
  });

  it("in-flight attempts are matched per mode (a live attempt neither blocks nor is returned to a test claim)", async () => {
    const other = await seedStudio("mode-scope-inflight");
    // Open a LIVE attempt (pending, fresh lease).
    const live = await claim(other.studioId, true);
    expect(live.should_execute_stripe_call).toBe(true);
    // A TEST claim must get its OWN fresh attempt, not the live one.
    const test = await claim(other.studioId, false);
    expect(test.attempt_id).not.toBe(live.attempt_id);
    expect(test.out_stripe_livemode).toBe(false);
    expect(test.should_execute_stripe_call).toBe(true);
  });
});

describe("sync_studio_account_status: current-mode row only", () => {
  it("updates the live row without touching the test row", async () => {
    await adminQuery(
      `select public.sync_studio_account_status($1, $2, $3, $4, $5, $6, $7)`,
      [s.studioId, "acct_harness_live_1", true, "enabled", true, true, new Date().toISOString()],
    );
    const rows = await settingsRows(s.studioId);
    const test = rows.find((r) => r.stripe_livemode === false)!;
    const live = rows.find((r) => r.stripe_livemode === true)!;
    expect(live.stripe_account_status).toBe("enabled");
    expect(live.stripe_charges_enabled).toBe(true);
    expect(live.stripe_payouts_enabled).toBe(true);
    // Cross-mode isolation: the test row keeps its (null/false) status.
    expect(test.stripe_account_status).toBeNull();
    expect(test.stripe_charges_enabled).toBe(false);
  });

  it("refuses the other mode's account id for a mode row (mismatch guard preserved)", async () => {
    await expect(
      adminQuery(
        `select public.sync_studio_account_status($1, $2, $3, $4, $5, $6, $7)`,
        [s.studioId, "acct_harness_test_1", true, "enabled", true, true, null],
      ),
    ).rejects.toThrow(/stripe_account_id mismatch/);
  });
});

describe("get_studio_payment_settings_display: mode-scoped, owner-gated", () => {
  it("returns the requested mode's row only", async () => {
    const testRows = await userQuery(
      s.userId,
      `select * from public.get_studio_payment_settings_display($1, $2)`,
      [s.studioId, false],
    );
    expect(testRows.rows).toHaveLength(1);
    expect(testRows.rows[0].livemode).toBe(false);

    const liveRows = await userQuery(
      s.userId,
      `select * from public.get_studio_payment_settings_display($1, $2)`,
      [s.studioId, true],
    );
    expect(liveRows.rows).toHaveLength(1);
    expect(liveRows.rows[0].livemode).toBe(true);
    expect(liveRows.rows[0].account_status).toBe("enabled");
  });

  it("returns ZERO rows (not the other mode's row) when the requested mode is not connected", async () => {
    const fresh = await seedStudio("mode-scope-display");
    // Give the fresh studio a TEST binding only.
    const c = await claim(fresh.studioId, false);
    await complete(c.attempt_id!, c.out_processing_claim_token!, "acct_harness_test_2", false);
    const live = await userQuery(
      fresh.userId,
      `select * from public.get_studio_payment_settings_display($1, $2)`,
      [fresh.studioId, true],
    );
    expect(live.rows).toHaveLength(0); // not connected in live — NOT the test row
  });

  it("is owner-gated (a stranger cannot read another studio's settings)", async () => {
    const stranger = await seedStudio("mode-scope-stranger");
    await expect(
      userQuery(
        stranger.userId,
        `select * from public.get_studio_payment_settings_display($1, $2)`,
        [s.studioId, false],
      ),
    ).rejects.toThrow(/not authorized/);
  });
});

describe("require_card_on_file: null-mode placeholder (Option A)", () => {
  it("upserts a null-mode placeholder row that does not disturb the mode rows", async () => {
    await adminQuery(
      `select public.set_studio_require_card_on_file($1, $2, $3)`,
      [s.studioId, s.practitionerId, true], // live row is enabled+charges → guard passes
    );
    const rows = await settingsRows(s.studioId);
    expect(rows).toHaveLength(3); // placeholder + test + live
    const placeholder = rows.find((r) => r.stripe_livemode === null)!;
    expect(placeholder.require_card_on_file).toBe(true);
    expect(placeholder.stripe_account_id).toBeNull();
    // Mode rows untouched.
    expect(rows.find((r) => r.stripe_livemode === false)!.stripe_account_id).toBe("acct_harness_test_1");
    expect(rows.find((r) => r.stripe_livemode === true)!.stripe_account_id).toBe("acct_harness_live_1");

    // Second call UPDATES the same placeholder (NULLS NOT DISTINCT), no dupe.
    await adminQuery(
      `select public.set_studio_require_card_on_file($1, $2, $3)`,
      [s.studioId, s.practitionerId, false],
    );
    const after = await settingsRows(s.studioId);
    expect(after).toHaveLength(3);
    expect(after.find((r) => r.stripe_livemode === null)!.require_card_on_file).toBe(false);
  });

  it("the placeholder does not satisfy a provisioning claim (mode rows only)", async () => {
    const fresh = await seedStudio("mode-scope-flag");
    // Placeholder first (flag=false needs no enabled binding).
    await adminQuery(
      `select public.set_studio_require_card_on_file($1, $2, false)`,
      [fresh.studioId, fresh.practitionerId],
    );
    // A test claim must still hand out a fresh attempt (placeholder ignored).
    const c = await claim(fresh.studioId, false);
    expect(c.already_provisioned).toBe(false);
    expect(c.should_execute_stripe_call).toBe(true);
  });
});

describe("downstream FK target survives the PK swap", () => {
  it("client_stripe_customers can still FK to (studio_id, stripe_account_id, stripe_livemode)", async () => {
    await expect(
      adminQuery(
        `insert into public.client_stripe_customers
           (client_id, studio_id, stripe_account_id, stripe_livemode, stripe_customer_id)
         values ($1, $2, 'acct_harness_live_1', true, $3)`,
        [s.clientId, s.studioId, `cus_harness_${randomUUID().slice(0, 8)}`],
      ),
    ).resolves.toBeDefined();
    // And a dangling tuple is still refused.
    await expect(
      adminQuery(
        `insert into public.client_stripe_customers
           (client_id, studio_id, stripe_account_id, stripe_livemode, stripe_customer_id)
         values ($1, $2, 'acct_does_not_exist', true, $3)`,
        [s.clientId, s.studioId, `cus_harness_${randomUUID().slice(0, 8)}`],
      ),
    ).rejects.toThrow(/foreign key|fk/i);
  });
});
