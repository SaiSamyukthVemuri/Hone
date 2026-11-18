import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #157. getAppointmentsForClientProfile is the single query that
// powers the client profile's appointment timeline. Pin the studio +
// client scope, the bounded result size, and the explicit-FK linked-
// session join shape as textual invariants so a future refactor that
// silently widens the scope is caught by `npm test`.

const QUERIES_PATH = path.resolve(
  __dirname,
  "../../../lib/supabase/queries.ts",
);
const SOURCE = readFileSync(QUERIES_PATH, "utf8");

function helperBlock(): string {
  const match = SOURCE.match(
    /export async function getAppointmentsForClientProfile[\s\S]*?\n\}/,
  );
  if (!match) {
    throw new Error("getAppointmentsForClientProfile not found in queries.ts");
  }
  return match[0];
}

describe("getAppointmentsForClientProfile scope + shape", () => {
  it("queries appointments scoped to (studio_id, client_id)", () => {
    const fn = helperBlock();
    expect(fn).toMatch(/\.eq\(\s*["']studio_id["']\s*,\s*studioId\s*\)/);
    expect(fn).toMatch(/\.eq\(\s*["']client_id["']\s*,\s*clientId\s*\)/);
  });

  it("returns all four statuses (no .eq on status)", () => {
    const fn = helperBlock();
    // The timeline surfaces confirmed + completed + cancelled + no_show;
    // a stray .eq("status", "...") would silently hide cancelled or
    // no-show rows from the client profile.
    expect(fn).not.toMatch(/\.eq\(\s*["']status["']/);
  });

  it("orders results newest-first and caps the result set", () => {
    const fn = helperBlock();
    expect(fn).toMatch(
      /\.order\(\s*["']starts_at["']\s*,\s*\{\s*ascending:\s*false\s*\}\s*\)/,
    );
    expect(fn).toMatch(/CLIENT_APPOINTMENT_TIMELINE_LIMIT/);
    expect(SOURCE).toMatch(/CLIENT_APPOINTMENT_TIMELINE_LIMIT\s*=\s*100/);
  });

  it("loads linked sessions via the PR #156 appointment_id FK", () => {
    const fn = helperBlock();
    expect(fn).toMatch(/\.in\(\s*["']appointment_id["']\s*,\s*apptIds\s*\)/);
    // The linked-session select is intentionally narrow: id, started_at,
    // modality, appointment_id. No notes, no entries, no PII beyond
    // what the row already exposes via the existing session detail
    // page.
    expect(fn).toMatch(
      /\.select\(\s*["']id, started_at, modality, appointment_id["']\s*\)/,
    );
  });

  it("filters out soft-deleted sessions when building the linked-session map", () => {
    const fn = helperBlock();
    expect(fn).toMatch(/\.is\(\s*["']deleted_at["']\s*,\s*null\s*\)/);
  });

  it("collapses to ONE linked session per appointment id (newest wins)", () => {
    const fn = helperBlock();
    expect(fn).toMatch(/latestByAppointment\s*=\s*new Map/);
    expect(fn).toMatch(/if \(latestByAppointment\.has\(s\.appointment_id\)\) continue;/);
  });

  it("uses the authenticated RLS server client (no admin / service role)", () => {
    // The action runs as the authenticated practitioner; the
    // sessions: members all and appointments_member_all policies
    // gate visibility. createAdminClient must NOT appear in this
    // helper block.
    const fn = helperBlock();
    expect(fn).not.toMatch(/createAdminClient|admin-server/);
    expect(fn).toMatch(/await createClient\(\)/);
  });
});
