import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

// PR #278. Migration 0094 replaced the single-column FKs on these relationships
// with composite (studio_id, …) FKs. PostgREST `alias:<fk_column>(...)` embed
// hints resolved via the OLD single-column FKs, so after 0094 they no longer
// resolve and silently return null (which hid the "Review appointment & billing"
// link and would break records-print + global-search). Embeds must use the bare
// table name, which resolves via the one remaining composite FK.

function grepFixed(literal: string): string {
  return execSync(
    `grep -rnF '${literal}' app lib --include='*.ts' --include='*.tsx' 2>/dev/null || true`,
    { cwd: process.cwd() },
  )
    .toString()
    .trim();
}

// 0094 replaced single-column FKs with composite FKs on: sessions->clients,
// sessions->appointments, session_blocks->sessions, client_intake_forms->clients,
// imported_treatment_memories->clients/import_batches, treatment_plans->clients,
// electrolysis_entries->session_blocks. The `alias:<fk_column>(...)` embed hint
// for THOSE relationships no longer resolves; they must use the bare table name.
// NOTE: appointments->clients was NOT changed (its single FK is intact), so
// `client:client_id(name)` on an appointments query stays valid and is NOT banned.
describe("no column-hint embeds remain on 0094-replaced relationships", () => {
  it("no appointments-via-appointment_id hint (sessions -> appointments)", () => {
    expect(grepFixed("appointments:appointment_id(")).toBe("");
  });
  it("no clients-via-client_id alias hint (sessions/records -> clients)", () => {
    expect(grepFixed("clients:client_id(")).toBe("");
  });
  it("no sessions-via-session_id hint (session_blocks -> sessions, incl. nested)", () => {
    expect(grepFixed("session:session_id(")).toBe("");
    expect(grepFixed("sessions:session_id(")).toBe("");
  });
});

describe("the replaced embeds now use the bare table name (composite FK resolves)", () => {
  it("session-payment-eligibility embeds appointments(...) bare", () => {
    expect(grepFixed("appointments(id, status, starts_at)")).not.toBe("");
  });
  it("record-keeping embeds clients(...) bare", () => {
    expect(grepFixed("clients(id, name, date_of_birth, phone, email, address)")).not.toBe("");
  });
  it("global-search embeds client:clients(name)", () => {
    expect(grepFixed("client:clients(name)")).not.toBe("");
  });
});
