import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #177. Source-grep tests pin the load-bearing shape of the
// backfill migration so a future re-edit cannot silently widen its
// scope, change the lateral join semantics, or drop the
// `IS DISTINCT FROM` idempotency clause.

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../supabase/migrations/0077_refresh_card_authorization_signature_pointers.sql",
);
const MIGRATION = readFileSync(MIGRATION_PATH, "utf8");

describe("0077 migration: scoping invariants", () => {
  it("only updates rows where cpm.status = 'active'", () => {
    expect(MIGRATION).toMatch(/where cpm\.status = 'active'/);
  });

  it("only updates rows where cpm.removed_at is null", () => {
    expect(MIGRATION).toMatch(/and cpm\.removed_at is null/);
  });

  it("looks up the live card_authorization template scoped to the same studio", () => {
    expect(MIGRATION).toMatch(
      /from public\.consent_form_templates t[\s\S]{0,500}where t\.studio_id = cpm\.studio_id/,
    );
  });

  it("requires the template to be is_live = true", () => {
    expect(MIGRATION).toMatch(/and t\.is_live = true/);
  });

  it("requires the template to be status = 'active'", () => {
    expect(MIGRATION).toMatch(/and t\.status = 'active'/);
  });

  it("requires the template to be form_type = 'card_authorization'", () => {
    expect(MIGRATION).toMatch(/and t\.form_type = 'card_authorization'/);
  });

  it("uses the same created_at desc + limit 1 tiebreaker as the helper", () => {
    expect(MIGRATION).toMatch(
      /order by t\.created_at desc[\s\S]{0,80}limit 1/,
    );
  });

  it("scopes the latest signature lookup by (studio, client, template_id)", () => {
    expect(MIGRATION).toMatch(
      /from public\.client_consent_signatures s[\s\S]{0,500}where s\.studio_id = cpm\.studio_id[\s\S]{0,200}and s\.client_id = cpm\.client_id[\s\S]{0,200}and s\.template_id = live_template\.id/,
    );
  });

  it("requires the signature's template_version to equal the live template's current version", () => {
    expect(MIGRATION).toMatch(
      /and s\.template_version = live_template\.version/,
    );
  });

  it("ranks signatures by signed_at desc with limit 1 (latest wins)", () => {
    expect(MIGRATION).toMatch(/order by s\.signed_at desc[\s\S]{0,80}limit 1/);
  });
});

describe("0077 migration: idempotency", () => {
  it("uses IS DISTINCT FROM to handle NULL pointers + already-current pointers", () => {
    expect(MIGRATION).toMatch(
      /cpm\.card_authorization_signature_id is distinct from latest_sig\.id/,
    );
  });

  it("the migration is re-runnable (no destructive DML, no schema change)", () => {
    expect(MIGRATION).not.toMatch(/drop table|drop column|alter table[\s\S]{0,200}drop/i);
  });

  it("does NOT relax any CHECK constraint", () => {
    expect(MIGRATION).not.toMatch(/drop constraint|alter[\s\S]{0,200}check/i);
  });
});

describe("0077 migration: forbidden operations", () => {
  it("does NOT touch manual_fee_charge_attempts (no DML)", () => {
    // The header comment legitimately mentions the table by name in
    // the "does NOT touch" enumeration; the structural check is that
    // no FROM/UPDATE/INSERT/DELETE targets that table.
    expect(MIGRATION).not.toMatch(
      /from public\.manual_fee_charge_attempts|update public\.manual_fee_charge_attempts|insert into public\.manual_fee_charge_attempts|delete from public\.manual_fee_charge_attempts/i,
    );
  });

  it("does NOT touch payment_charge_attempts (no DML)", () => {
    expect(MIGRATION).not.toMatch(
      /from public\.payment_charge_attempts|update public\.payment_charge_attempts|insert into public\.payment_charge_attempts|delete from public\.payment_charge_attempts/i,
    );
  });

  it("does NOT relax stripe_livemode invariants", () => {
    expect(MIGRATION).not.toMatch(/stripe_livemode.*true/i);
    expect(MIGRATION).not.toMatch(/livemode_false_check/);
  });

  it("does NOT INSERT or DELETE rows; only UPDATE", () => {
    expect(MIGRATION).not.toMatch(/insert into\s|delete from\s/i);
    expect(MIGRATION).toMatch(/update public\.client_payment_methods cpm/);
  });

  it("does NOT cross studio_id when joining (verified by the matched constraint)", () => {
    // The matched .studio_id = cpm.studio_id clauses bound every
    // cross-table join. Pin both.
    const studioBoundaries = MIGRATION.match(
      /\.studio_id\s*=\s*cpm\.studio_id/g,
    );
    expect((studioBoundaries ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT cross client_id when joining", () => {
    expect(MIGRATION).toMatch(/s\.client_id = cpm\.client_id/);
  });

  it("emits a notice with the row count for the operator audit", () => {
    expect(MIGRATION).toMatch(
      /raise notice[\s\S]{0,200}PR #177 backfill[\s\S]{0,200}v_rows_updated/,
    );
  });
});

describe("0077 migration: audit trail", () => {
  it("references docs/16 §5.11 in the header comment", () => {
    expect(MIGRATION).toMatch(/docs\/16 §5\.11/);
  });

  it("explicitly documents the strictness clauses in the header", () => {
    expect(MIGRATION).toMatch(/Strictness/);
  });

  it("explicitly documents the idempotency clause in the header", () => {
    expect(MIGRATION).toMatch(/Idempotency/i);
  });
});
