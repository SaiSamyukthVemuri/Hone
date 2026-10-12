import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

const VERSION = "0225";
const FILE = "supabase/migrations/0225_public_new_client_practitioner_selection.sql";
const sql = readFileSync(FILE, "utf8");
/** Executable SQL only — comments stripped, line comments before block ones. */
const EXECUTABLE = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
/** Top level only: a booking command inserts at RUNTIME and must. */
const TOP_LEVEL = EXECUTABLE.replace(/\$\$[\s\S]*?\$\$/g, " <body> ");

const ARGS =
  "uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text, uuid, uuid";

describe("0225 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    expect(isRepoMax(VERSION), "0225 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(sql).toMatch(/^begin;/m);
    expect(sql).toMatch(/set local lock_timeout = '5s';/);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql.indexOf("set local lock_timeout")).toBeGreaterThan(sql.indexOf("begin;"));
  });

  it("records the renumber from 0223, so the reason is not lost", () => {
    // MPX #860 and Audit #872 pushed 0223/0224 while this file was unpushed; a
    // pushed claim beats an unpushed one. The header carries that history.
    expect(sql).toMatch(/RENUMBERED 0223 -> 0225/);
  });
});

describe("0225 is additive — 0204 stays in place", () => {
  it("creates exactly the one _v2 function", () => {
    const created = [
      ...TOP_LEVEL.matchAll(/create or replace function public\.([a-z_0-9]+)/g),
    ].map((m) => m[1]);
    expect(created).toEqual(["create_public_appointment_for_new_client_v2"]);
  });

  it("does NOT redefine 0204's command", () => {
    expect(EXECUTABLE).not.toMatch(
      /create or replace function public\.create_public_appointment_for_new_client\s*\(/,
    );
  });

  it("writes nothing and alters no schema object WHEN APPLIED", () => {
    for (const banned of [
      /\bcreate table\b/i, /\balter table\b/i, /\bdrop table\b/i,
      /\bcreate index\b/i, /\bcreate trigger\b/i, /\bcreate policy\b/i,
      /\binsert into\b/i, /\bdelete from\b/i, /\btruncate\b/i, /\bdrop function\b/i,
    ]) {
      expect(TOP_LEVEL, `0225 must not contain ${banned} at top level`).not.toMatch(banned);
    }
  });
});

describe("0225 delegates rather than re-implements", () => {
  it("the ORDINARY branch delegates to create_public_appointment_v2", () => {
    // This is what makes every 0222 guarantee inherited rather than restated:
    // the practitioner is validated by the delegate, not here.
    expect(EXECUTABLE).toMatch(/from public\.create_public_appointment_v2\(/);
    expect(EXECUTABLE).toMatch(/p_practitioner_id\s*\n?\s*\)\s*c;/);
  });

  it("the INVITED branch still delegates to the waitlist command, unchanged", () => {
    // An invitation redeems an offer that named no practitioner, and that
    // command takes none. A recorded product gap, not an oversight.
    expect(EXECUTABLE).toMatch(/from public\.create_waitlist_public_appointment\(/);
  });

  it("keeps the admission gate ABOVE the delegate", () => {
    // WAITLIST and CLOSED must refuse before anything is written, so a
    // practitioner choice can never carry a booking past them.
    const gateAt = EXECUTABLE.indexOf("assert_new_client_admission");
    const delegateAt = EXECUTABLE.indexOf("create_public_appointment_v2");
    expect(gateAt).toBeGreaterThan(-1);
    expect(delegateAt).toBeGreaterThan(gateAt);
  });
});

describe("0225 grant posture — revoke all three by name, then service_role only", () => {
  const FN = "create_public_appointment_for_new_client_v2";
  it("revokes from public, anon, authenticated and service_role", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(sql, `does not revoke from ${role}`).toContain(
        `revoke execute on function public.${FN}(${ARGS}) from ${role};`,
      );
    }
  });
  it("grants EXECUTE to service_role only", () => {
    expect(sql).toContain(`grant execute on function public.${FN}(${ARGS}) to service_role;`);
    for (const role of ["anon", "authenticated"]) {
      expect(sql).not.toContain(
        `grant execute on function public.${FN}(${ARGS}) to ${role};`,
      );
    }
  });
});
