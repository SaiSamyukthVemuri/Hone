import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #278. SQL-text pin for migration 0094 (tenant-consistency composite FKs).
// Behavioral proof is in tests/db/tenant-consistency.db.test.ts (db lane); this
// pins the migration shape so the constraints cannot silently regress, and that
// no RLS / payment / live-mode behavior was changed.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0094_tenant_consistency_constraints.sql"),
  "utf8",
);

describe("0094 adds the parent unique constraints the composite FKs need", () => {
  it("sessions (studio_id, id), session_blocks (session_id, id), import_batches (studio_id, id)", () => {
    expect(SQL).toMatch(/constraint sessions_studio_id_uniq unique \(studio_id, id\)/);
    expect(SQL).toMatch(/constraint session_blocks_session_id_id_uniq unique \(session_id, id\)/);
    expect(SQL).toMatch(/constraint import_batches_studio_id_uniq unique \(studio_id, id\)/);
  });
});

describe("0094 adds composite same-studio FKs (mirroring existing ON DELETE)", () => {
  it("sessions.client + appointment", () => {
    expect(SQL).toMatch(/sessions_client_same_studio_fk[\s\S]*foreign key \(studio_id, client_id\) references public\.clients \(studio_id, id\)[\s\S]*on delete cascade/);
    expect(SQL).toMatch(/sessions_appointment_same_studio_fk[\s\S]*foreign key \(studio_id, appointment_id\) references public\.appointments \(studio_id, id\)[\s\S]*on delete set null \(appointment_id\)/);
  });
  it("session_blocks.session", () => {
    expect(SQL).toMatch(/session_blocks_session_same_studio_fk[\s\S]*foreign key \(studio_id, session_id\) references public\.sessions \(studio_id, id\)[\s\S]*on delete cascade/);
  });
  it("client_intake_forms.client + treatment_plans.client", () => {
    expect(SQL).toMatch(/client_intake_forms_client_same_studio_fk[\s\S]*\(studio_id, client_id\) references public\.clients \(studio_id, id\)/);
    expect(SQL).toMatch(/treatment_plans_client_same_studio_fk[\s\S]*\(studio_id, client_id\) references public\.clients \(studio_id, id\)/);
  });
  it("imported_treatment_memories.client + import batch (restrict)", () => {
    expect(SQL).toMatch(/imported_memories_client_same_studio_fk[\s\S]*\(studio_id, client_id\) references public\.clients \(studio_id, id\)/);
    expect(SQL).toMatch(/imported_memories_batch_same_studio_fk[\s\S]*foreign key \(studio_id, import_batch_id\) references public\.import_batches \(studio_id, id\)[\s\S]*on delete restrict/);
  });
  it("electrolysis_entries block-belongs-to-its-session", () => {
    expect(SQL).toMatch(/electrolysis_block_same_session_fk[\s\S]*foreign key \(session_id, block_id\) references public\.session_blocks \(session_id, id\)[\s\S]*on delete set null \(block_id\)/);
  });
  it("is idempotent (drop-if-exists before each add)", () => {
    expect((SQL.match(/drop constraint if exists/g) ?? []).length).toBeGreaterThanOrEqual(11);
  });
  it("includes a production preflight section", () => {
    expect(SQL).toMatch(/PREFLIGHT/);
  });
});

describe("0094 changes nothing else (no RLS / payment / live-mode / trigger)", () => {
  it("creates/drops no policy and grants no anon/public access", () => {
    expect(SQL).not.toMatch(/create policy|drop policy/i);
    expect(SQL).not.toMatch(/to anon|to public/i);
    expect(SQL).not.toMatch(/enable row level security|disable row level security/i);
  });
  it("touches no payment / live-mode / Stripe surface (no DDL on those tables)", () => {
    expect(SQL).not.toMatch(/paymentIntents|STRIPE_ALLOW_LIVE_MODE|stripe_livemode/i);
    // header prose may NAME the already-hardened payment tables; ban actual DDL.
    expect(SQL).not.toMatch(/alter table\s+public\.(payment_charge_attempts|manual_fee_charge_attempts|appointment_payments)/i);
  });
  it("adds no trigger and runs no DDL against treatment_images (0093)", () => {
    expect(SQL).not.toMatch(/create trigger|create or replace function/i);
    expect(SQL).not.toMatch(/alter table\s+public\.treatment_images/i);
  });
});
