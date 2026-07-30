import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

// PR #278 (migration 0094) + Chloe checkout-default regression (migration 0151).
//
// Both migrations replaced SINGLE-column FKs with COMPOSITE (…, studio_id) FKs.
// PostgREST resolves an `alias:<fk_column>(...)` embed hint only against a
// single-column FK, so after each migration those hints stop resolving. The
// request 400s with PGRST200 ("Could not find a relationship between
// 'appointments' and 'service_id'"), supabase-js returns { data: null, error },
// and a caller that discards `error` silently loses the embedded row.
//
// 0094 covered: sessions->clients, sessions->appointments, session_blocks->
// sessions, client_intake_forms->clients, imported_treatment_memories->clients/
// import_batches, treatment_plans->clients, electrolysis_entries->session_blocks.
//
// 0151 covered: appointments->{clients, services, practitioners}. It was NOT
// swept at the app layer, which is how the session-detail page kept shipping
// `services:service_id(name, price_cents)` and lost the booked-service default
// amount on every load. Reproduced against a fresh 0001→0160 local chain:
// HTTP 400 / PGRST200 for the hint form; the bare-table form resolves.
//
// Embeds must therefore use the bare table name on ALL of these relationships.

function grepFixed(literal: string): string {
  // app, lib AND components — a column-hint embed inside a client component
  // would otherwise slip past this guard entirely.
  return execSync(
    `grep -rnF '${literal}' app lib components --include='*.ts' --include='*.tsx' 2>/dev/null || true`,
    { cwd: process.cwd() },
  )
    .toString()
    .trim();
}

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

describe("no column-hint embeds remain on 0151-replaced relationships", () => {
  // appointments.service_id — the one that actually regressed.
  it("no services-via-service_id hint (appointments -> services)", () => {
    expect(grepFixed("services:service_id(")).toBe("");
    expect(grepFixed("service:service_id(")).toBe("");
  });
  // appointments.client_id — the same file (global search) carried this one.
  it("no clients-via-client_id hint (appointments -> clients)", () => {
    expect(grepFixed("client:client_id(")).toBe("");
  });
  // appointments.practitioner_id — clean today; banned so it stays clean.
  it("no practitioners-via-practitioner_id hint (appointments -> practitioners)", () => {
    expect(grepFixed("practitioner:practitioner_id(")).toBe("");
    expect(grepFixed("practitioners:practitioner_id(")).toBe("");
  });
});

describe("the replaced embeds now use the bare table name (composite FK resolves)", () => {
  it("session-payment-eligibility embeds appointments(...) bare", () => {
    expect(grepFixed("appointments(id, status, starts_at)")).not.toBe("");
  });
  it("record-keeping embeds clients(...) bare", () => {
    expect(grepFixed("clients(id, name, date_of_birth, phone, email, address)")).not.toBe("");
  });
  it("global-search embeds client:clients(name) on the APPOINTMENTS queries", () => {
    // The bare form must appear on the appointments selects specifically — the
    // old positive assertion was satisfied by already-fixed 0094 queries in the
    // same file while the three appointments queries stayed broken.
    expect(grepFixed("id, starts_at, status, client:clients(name), service:services(name)")).not.toBe(
      "",
    );
  });
  it("the session-detail default-amount query embeds service:services(...) bare", () => {
    expect(grepFixed("service:services(name, price_cents)")).not.toBe("");
  });
});
