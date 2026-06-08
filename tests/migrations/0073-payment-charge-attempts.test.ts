import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #171. Pin every load-bearing invariant of the dormant
// payment_charge_attempts table. The migration is the v1
// canonical charge ledger but ships ZERO runtime behavior; a
// future PR (#181) writes the first rows. The patched prompt
// listed 16 acceptance gates; these tests pin each one that is
// machine-verifiable at the source-grep level. Live-mode + RLS
// invariants are verified on the deployed DB by the
// post-migration `supabase db query` checks captured in the PR
// description; the tests below are the second line of defense
// for the schema shape.

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../supabase/migrations/0073_payment_charge_attempts.sql",
);
const SOURCE = readFileSync(MIGRATION_PATH, "utf8");

describe("migration 0073: charge_reason enum", () => {
  it("supports exactly the three canonical reasons", () => {
    expect(SOURCE).toMatch(
      /charge_reason text not null[\s\S]{0,200}check \(charge_reason in \(\s*'session_payment',\s*'late_cancellation_fee',\s*'no_show_fee'\s*\)\)/i,
    );
  });

  it("does NOT add a fourth reason (deposit, package, store credit, etc.)", () => {
    // A future PR that adds a fourth reason must update both the
    // CHECK and the product model in docs/13. Pin the negative.
    expect(SOURCE).not.toMatch(/'deposit'/);
    expect(SOURCE).not.toMatch(/'package'/);
    expect(SOURCE).not.toMatch(/'gift_card'/);
    expect(SOURCE).not.toMatch(/'store_credit'/);
  });
});

describe("migration 0073: session_id / appointment_id reason-shape CHECK (patched prompt)", () => {
  it("the CHECK constraint is named so a future PR can target it", () => {
    expect(SOURCE).toMatch(
      /constraint payment_charge_attempts_reason_shape_check check/,
    );
  });

  it("session_payment requires session_id (not appointment_id)", () => {
    expect(SOURCE).toMatch(
      /charge_reason = 'session_payment'[\s\S]{0,40}session_id is not null/,
    );
  });

  it("session_payment does NOT hard-require appointment_id (freeform sessions are allowed)", () => {
    // The patched prompt's load-bearing rule: a future chargeable
    // freeform session must not require a migration to relax. We
    // pin the absence of any "appointment_id is not null" clause
    // within the session_payment branch of the CHECK.
    const sessionPaymentBranch =
      SOURCE.match(
        /charge_reason = 'session_payment'[\s\S]*?(?=or|\)\s*,)/i,
      )?.[0] ?? "";
    expect(sessionPaymentBranch).toMatch(/session_id is not null/);
    expect(sessionPaymentBranch).not.toMatch(/appointment_id is not null/);
  });

  it("late_cancellation_fee + no_show_fee require appointment_id AND forbid session_id", () => {
    expect(SOURCE).toMatch(
      /charge_reason in \('late_cancellation_fee', 'no_show_fee'\)[\s\S]{0,120}appointment_id is not null[\s\S]{0,40}session_id is null/,
    );
  });

  it("appointment_id and session_id are both nullable at the column level", () => {
    expect(SOURCE).toMatch(/appointment_id uuid,\n/);
    expect(SOURCE).toMatch(/session_id uuid\s*\n?\s*references/);
  });
});

describe("migration 0073: status enum mirrors manual_fee_charge_attempts", () => {
  it("supports exactly the same six statuses as manual_fee", () => {
    // Audit confirmed manual_fee_charge_attempts CHECK is
    // status in ('ready','blocked','cancelled','pending_stripe','succeeded','failed').
    // PR #171 mirrors it exactly to avoid a parallel state machine.
    expect(SOURCE).toMatch(
      /check \(status in \(\s*'ready',\s*'blocked',\s*'cancelled',\s*'pending_stripe',\s*'succeeded',\s*'failed'\s*\)\)/i,
    );
  });

  it("default status is 'ready' (same as manual_fee)", () => {
    expect(SOURCE).toMatch(
      /status text not null default 'ready'/,
    );
  });
});

describe("migration 0073: named livemode dormancy CHECK", () => {
  it("the CHECK constraint name matches the manual_fee naming convention", () => {
    expect(SOURCE).toMatch(
      /constraint payment_charge_attempts_livemode_false_check\s*\n?\s*check \(stripe_livemode = false\)/,
    );
  });

  it("stripe_livemode column defaults to false", () => {
    expect(SOURCE).toMatch(
      /stripe_livemode boolean not null default false/,
    );
  });
});

describe("migration 0073: amount + currency bounds", () => {
  it("amount_cents > 0 (strict; no zero-amount attempts) AND <= 200000 (patched-prompt $2k cap)", () => {
    expect(SOURCE).toMatch(
      /check \(amount_cents > 0 and amount_cents <= 200000\)/,
    );
  });

  it("currency hardcoded to 'cad'", () => {
    expect(SOURCE).toMatch(/currency text not null default 'cad'/);
    expect(SOURCE).toMatch(/check \(currency in \('cad'\)\)/);
  });
});

describe("migration 0073: FK ON DELETE rules (audit-aligned)", () => {
  it("studio_id CASCADE (matches manual_fee + studio_payment_settings)", () => {
    expect(SOURCE).toMatch(
      /studio_id uuid not null\s*\n?\s*references public\.studios\(id\) on delete cascade/,
    );
  });

  it("session_id FK effectively resolves to ON DELETE RESTRICT after migration 0074", () => {
    // 0073 originally declared session_id as ON DELETE SET NULL,
    // but that contradicted the same migration's
    // payment_charge_attempts_reason_shape_check (which requires
    // session_payment rows to have a non-null session_id). PR
    // #171 patch shipped migration 0074 as the corrective
    // ALTER TABLE that drops + re-adds the FK with ON DELETE
    // RESTRICT, which is the honest declaration: sessions are
    // immutable clinical artefacts and a session_payment row
    // structurally REQUIRES the referenced session to stay put
    // (the CHECK constraint enforces session_id is not null on
    // those rows). The 0073 file is preserved as the historical
    // record; the effective state is verified against 0074.
    const fs = readFileSync(
      path.resolve(
        __dirname,
        "../../supabase/migrations/0074_payment_charge_attempts_session_fk_restrict.sql",
      ),
      "utf8",
    );
    expect(fs).toMatch(
      /foreign key \(session_id\) references public\.sessions\(id\)\s*\n?\s*on delete restrict/i,
    );
    expect(fs).toMatch(
      /drop constraint if exists payment_charge_attempts_session_id_fkey/i,
    );
  });

  it("0073 historically declared SET NULL (pinned for the audit trail)", () => {
    // Pin the historical 0073 declaration so a future "tidy up"
    // PR that retroactively rewrites 0073 to RESTRICT is caught.
    // 0073 represents what was actually applied on 2026-06-08;
    // 0074 is the layered correction. Both files are part of
    // the migration history.
    expect(SOURCE).toMatch(
      /session_id uuid\s*\n?\s*references public\.sessions\(id\) on delete set null/,
    );
  });

  it("client (composite) RESTRICT", () => {
    expect(SOURCE).toMatch(
      /constraint payment_charge_attempts_client_studio_fk[\s\S]{0,200}references public\.clients\(id, studio_id\) on delete restrict/,
    );
  });

  it("appointment (composite) RESTRICT", () => {
    expect(SOURCE).toMatch(
      /constraint payment_charge_attempts_appointment_studio_fk[\s\S]{0,200}references public\.appointments\(id, studio_id\) on delete restrict/,
    );
  });

  it("created_by_practitioner (composite) RESTRICT", () => {
    expect(SOURCE).toMatch(
      /constraint payment_charge_attempts_created_by_practitioner_studio_fk[\s\S]{0,200}references public\.practitioners\(id, studio_id\) on delete restrict/,
    );
  });

  it("client_payment_method RESTRICT (mirrors manual_fee)", () => {
    expect(SOURCE).toMatch(
      /client_payment_method_id uuid\s*\n?\s*references public\.client_payment_methods\(id\) on delete restrict/,
    );
  });

  it("card_authorization_signature RESTRICT (mirrors manual_fee; nullable per patched prompt)", () => {
    expect(SOURCE).toMatch(
      /card_authorization_signature_id uuid\s*\n?\s*references public\.client_consent_signatures\(id\) on delete restrict/,
    );
    // Pin the absence of "not null" on this column declaration
    // (the patched prompt requires nullable in the dormant PR).
    expect(SOURCE).not.toMatch(
      /card_authorization_signature_id uuid not null/,
    );
  });

  it("cancelled_by_practitioner RESTRICT (single-column FK matching manual_fee)", () => {
    expect(SOURCE).toMatch(
      /cancelled_by_practitioner_id uuid\s*\n?\s*references public\.practitioners\(id\) on delete restrict/,
    );
  });
});

describe("migration 0073: required indexes", () => {
  const REQUIRED_INDEXES = [
    "payment_charge_attempts_studio_created_idx",
    "payment_charge_attempts_studio_client_idx",
    "payment_charge_attempts_studio_appointment_idx",
    "payment_charge_attempts_studio_session_idx",
    "payment_charge_attempts_studio_status_reason_idx",
    "payment_charge_attempts_idempotency_uniq",
    "payment_charge_attempts_pi_uniq",
    "payment_charge_attempts_charge_id_idx",
    "payment_charge_attempts_payment_method_idx",
    "payment_charge_attempts_card_auth_sig_idx",
    "payment_charge_attempts_active_fee_per_appointment_uniq",
    "payment_charge_attempts_active_session_payment_uniq",
  ];

  for (const idx of REQUIRED_INDEXES) {
    it(`creates ${idx}`, () => {
      expect(SOURCE).toContain(idx);
    });
  }

  it("partial-on-appointment_id and partial-on-session_id indexes use a WHERE clause", () => {
    // Partial indexes save space + don't pay an index hit on
    // rows where the nullable column is null.
    expect(SOURCE).toMatch(
      /payment_charge_attempts_studio_appointment_idx[\s\S]{0,200}where appointment_id is not null/,
    );
    expect(SOURCE).toMatch(
      /payment_charge_attempts_studio_session_idx[\s\S]{0,200}where session_id is not null/,
    );
  });

  it("idempotency_uniq is a UNIQUE index", () => {
    expect(SOURCE).toMatch(
      /create unique index if not exists payment_charge_attempts_idempotency_uniq/,
    );
  });

  it("pi_uniq is a UNIQUE index", () => {
    expect(SOURCE).toMatch(
      /create unique index if not exists payment_charge_attempts_pi_uniq/,
    );
  });

  it("the active-fee partial unique scopes to (appointment_id, charge_reason) for fees only", () => {
    expect(SOURCE).toMatch(
      /payment_charge_attempts_active_fee_per_appointment_uniq[\s\S]{0,400}where appointment_id is not null[\s\S]{0,200}charge_reason in \('late_cancellation_fee', 'no_show_fee'\)[\s\S]{0,200}status in \('ready', 'pending_stripe', 'succeeded'\)/,
    );
  });

  it("the active-session_payment partial unique scopes to session_id for session_payment only", () => {
    expect(SOURCE).toMatch(
      /payment_charge_attempts_active_session_payment_uniq[\s\S]{0,400}where session_id is not null[\s\S]{0,200}charge_reason = 'session_payment'[\s\S]{0,200}status in \('ready', 'pending_stripe', 'succeeded'\)/,
    );
  });
});

describe("migration 0073: RLS posture (mirrors manual_fee)", () => {
  it("enables RLS on the table", () => {
    expect(SOURCE).toMatch(
      /alter table public\.payment_charge_attempts enable row level security/,
    );
  });

  it("creates a studio-member SELECT policy", () => {
    expect(SOURCE).toMatch(
      /create policy "payment_charge_attempts_member_read"[\s\S]{0,200}for select[\s\S]{0,200}using \(public\.is_studio_member\(studio_id\)\)/,
    );
  });

  it("does NOT add any INSERT, UPDATE, or DELETE policy (service-role only)", () => {
    expect(SOURCE).not.toMatch(/for insert/i);
    expect(SOURCE).not.toMatch(/for update/i);
    expect(SOURCE).not.toMatch(/for delete/i);
  });
});

describe("migration 0073: updated_at touch trigger", () => {
  it("declares the trigger function", () => {
    expect(SOURCE).toMatch(
      /function public\.payment_charge_attempts_touch_updated_at\(\)/,
    );
  });

  it("attaches the trigger before update", () => {
    expect(SOURCE).toMatch(
      /create trigger payment_charge_attempts_touch_updated_at_trg\s*\n?\s*before update on public\.payment_charge_attempts/,
    );
  });
});

describe("migration 0073: idempotency + safety", () => {
  it("table create is idempotent (IF NOT EXISTS)", () => {
    expect(SOURCE).toMatch(
      /create table if not exists public\.payment_charge_attempts/,
    );
  });

  it("every index uses IF NOT EXISTS", () => {
    const indexCreates = SOURCE.match(/create (unique )?index [^;]+/gi) ?? [];
    expect(indexCreates.length).toBeGreaterThanOrEqual(12);
    for (const stmt of indexCreates) {
      expect(stmt).toMatch(/if not exists/i);
    }
  });

  it("does NOT touch manual_fee_charge_attempts (runtime stays untouched)", () => {
    // The patched prompt: "Leave existing manual_fee_charge_attempts
    // runtime untouched." Any ALTER TABLE / UPDATE / DROP / RENAME
    // statement against the legacy table here would violate the
    // contract. The regexes anchor on the actual SQL keyword +
    // the table name (with optional public. prefix) to avoid
    // matching substrings inside comments (e.g. "updated_at
    // touch trigger. Mirrors manual_fee_charge_attempts." is a
    // legitimate doc reference and must not trip the test).
    expect(SOURCE).not.toMatch(
      /^\s*alter table\s+(public\.)?manual_fee_charge_attempts\b/im,
    );
    expect(SOURCE).not.toMatch(
      /^\s*update\s+(public\.)?manual_fee_charge_attempts\b/im,
    );
    expect(SOURCE).not.toMatch(
      /^\s*drop table\s+(if exists\s+)?(public\.)?manual_fee_charge_attempts\b/im,
    );
    expect(SOURCE).not.toMatch(
      /^\s*alter table\s+(public\.)?manual_fee_charge_attempts[\s\S]{0,200}rename/im,
    );
  });
});

describe("migration 0073: documentation", () => {
  it("comments name PR #171 + the dormant posture", () => {
    expect(SOURCE).toMatch(/PR #171/);
    expect(SOURCE).toMatch(/DORMANT|dormant/);
  });

  it("comments name the future execution PR (#181) and the unification PR gate", () => {
    expect(SOURCE).toMatch(/PR #181/);
  });

  it("table comment names the canonical-ledger role", () => {
    expect(SOURCE).toMatch(
      /comment on table public\.payment_charge_attempts/,
    );
  });

  it("the appointment_id column comment names the freeform-session caveat", () => {
    expect(SOURCE).toMatch(
      /comment on column public\.payment_charge_attempts\.appointment_id[\s\S]{0,200}freeform/i,
    );
  });
});

describe("migration 0073: no payment / live-mode / SMS behavior added", () => {
  it("does NOT add a paymentIntents.create call anywhere", () => {
    expect(SOURCE).not.toMatch(/paymentIntents/i);
  });

  it("does NOT add a refunds.create or checkout.sessions reference", () => {
    expect(SOURCE).not.toMatch(/refunds\.create/i);
    expect(SOURCE).not.toMatch(/checkout\.sessions/i);
  });

  it("does NOT relax STRIPE_ALLOW_LIVE_MODE or any existing live-mode guard", () => {
    // The migration header comment legitimately documents the
    // existing STRIPE_ALLOW_LIVE_MODE guard. What we forbid is
    // an actual `drop constraint ... livemode` statement against
    // either the new table's own CHECK or the existing
    // manual_fee_charge_attempts CHECK. Neither would be valid
    // dormant-schema work; the live-enablement PR (per docs/16
    // §11) drops those constraints, not this PR.
    expect(SOURCE).not.toMatch(
      /^\s*alter table[\s\S]{0,200}drop constraint[\s\S]{0,200}livemode_false_check/im,
    );
    expect(SOURCE).not.toMatch(
      /drop constraint if exists\s+manual_fee_charge_attempts_livemode_false_check/i,
    );
    expect(SOURCE).not.toMatch(
      /drop constraint if exists\s+payment_charge_attempts_livemode_false_check/i,
    );
  });
});
