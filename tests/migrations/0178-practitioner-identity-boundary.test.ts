import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// 0178 — practitioner identity + mutation boundary. STATIC contract.
//
// Behaviour is proved against a real database in
// tests/db/practitioner-identity-boundary.db.test.ts and
// tests/db/treatment-image-multi-studio-actor.db.test.ts. This file pins what a
// behavioural test cannot see: what the migration is allowed to contain, and
// what it must never emit.

const FILE = "supabase/migrations/0178_practitioner_identity_boundary.sql";
const SQL = readFileSync(join(__dirname, "..", "..", FILE), "utf8");

// EXECUTABLE SQL ONLY — line comments stripped. The header deliberately NAMES
// what it does not touch, so a scope assertion over raw text would fail on the
// very prose documenting the discipline.
const EXEC = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0178 — migration state", () => {
  it("is the current repository maximum and consumes exactly one number", () => {
    expect(isRepoMax("0178")).toBe(true);
    expect(versionsAbove("0178")).toEqual([]);
    expect(countVersion("0178")).toBe(1);
  });

  it("leaves 0179 free", () => {
    expect(countVersion("0179")).toBe(0);
  });
});

describe("0178 — transaction envelope", () => {
  it("opens its own transaction and arms lock_timeout INSIDE it", () => {
    const lines = SQL.split("\n").map((l) => l.trim()).filter(Boolean);
    const b = lines.findIndex((l) => l === "begin;");
    expect(b).toBeGreaterThanOrEqual(0);
    expect(lines[b + 1]).toBe("set local lock_timeout = '5s';");
    expect(lines[lines.length - 1]).toBe("commit;");
  });
});

describe("0178 — own-preference commands", () => {
  const CMDS = [
    "update_own_practitioner_profile",
    "set_own_calendar_feed_token_hash",
    "set_own_default_machine_frequency",
  ];

  it.each(CMDS)("%s binds the actor to auth.uid() and takes NO practitioner id", (fn) => {
    const body =
      EXEC.match(new RegExp(`create or replace function public\\.${fn}[\\s\\S]*?\\n\\$\\$;`))?.[0] ??
      "";
    expect(body).not.toBe("");
    // The ONLY identity input is a studio. A practitioner id parameter would
    // reintroduce exactly the forgeable actor this boundary removes.
    expect(body).toMatch(/p_studio_id\s+uuid/);
    expect(body).not.toMatch(/p_practitioner_id|p_actor|p_user_id/);
    expect(body).toMatch(/own_practitioner_in_studio\(p_studio_id\)/);
    expect(body).toMatch(/security definer/);
    expect(body).toMatch(/set search_path = pg_catalog, pg_temp/);
  });

  it("the resolver is studio-scoped and never LIMIT 1s a global membership set", () => {
    const helper =
      EXEC.match(
        /create or replace function public\.own_practitioner_in_studio[\s\S]*?\n\$\$;/,
      )?.[0] ?? "";
    expect(helper).toMatch(/p\.user_id = auth\.uid\(\)/);
    expect(helper).toMatch(/p\.studio_id = p_studio_id/);
    expect(helper).toMatch(/p\.active = true/);
    expect(helper).not.toMatch(/limit\s+1/i);
  });

  it("does NOT duplicate the practitioner palette or invent a name limit", () => {
    // `lib/practitioner-colors.ts` is canonical and promises that adding a
    // colour needs no migration. Enumerating the tokens here would break that.
    for (const token of ["amber", "emerald", "indigo", "neutral", "rose", "sky", "teal", "violet"]) {
      expect(EXEC, `SQL must not enumerate the palette (${token})`).not.toMatch(
        new RegExp(`'${token}'`),
      );
    }
    // A generic shape backstop is fine; a product length ceiling is not.
    expect(EXEC).not.toMatch(/length\(v_name\)\s*>/);
  });

  it("NO authority column is reachable from any own-preference command", () => {
    // The SET lists are the whole surface. If a future edit adds `role` or
    // `active` to one of them, this is the guard that notices.
    const bodies = CMDS.map(
      (fn) =>
        EXEC.match(new RegExp(`create or replace function public\\.${fn}[\\s\\S]*?\\n\\$\\$;`))?.[0] ??
        "",
    ).join("\n");
    const sets = [...bodies.matchAll(/set\s+([\s\S]*?)\s+where/g)].map((m) => m[1]).join(",");
    for (const forbidden of [
      "role",
      "active",
      "studio_id",
      "user_id",
      "email",
      "created_at",
      "terms_accepted_at",
      "privacy_accepted_at",
    ]) {
      expect(sets, `${forbidden} must not be assignable`).not.toMatch(
        new RegExp(`\\b${forbidden}\\s*=`),
      );
    }
    // ...and the four legitimate preference columns ARE assignable.
    for (const allowed of [
      "display_name",
      "color",
      "calendar_feed_token_hash",
      "default_machine_frequency",
    ]) {
      expect(sets).toContain(allowed);
    }
  });
});

describe("0178 — treatment-image actor", () => {
  it("drops the global no-argument helper and replaces it with a studio-scoped one", () => {
    expect(EXEC).toMatch(/drop function if exists public\.treatment_image_actor\(\);/);
    const helper =
      EXEC.match(
        /create or replace function public\.treatment_image_actor\(p_studio_id uuid\)[\s\S]*?\n\$\$;/,
      )?.[0] ?? "";
    expect(helper).not.toBe("");
    expect(helper).toMatch(/p\.studio_id = p_studio_id/);
    expect(helper).not.toMatch(/limit\s+1/i);
    // 0168's family pins an EMPTY search_path; the replacement must match or the
    // existing posture suite goes red.
    expect(helper).toMatch(/set search_path = ''/);
  });

  it("keeps the three application-facing command signatures unchanged", () => {
    // Signature drift here would create deployment skew for no reason: the
    // application calls these by name and argument list.
    expect(EXEC).toMatch(
      /create or replace function public\.create_treatment_image_metadata\(\s*\n\s*p_id\s+uuid/,
    );
    expect(EXEC).toMatch(
      /create or replace function public\.set_treatment_image_note\(\s*\n\s*p_image_id\s+uuid,\s*\n\s*p_client_id uuid,\s*\n\s*p_note\s+text\s*\n\)/,
    );
    expect(EXEC).toMatch(
      /create or replace function public\.archive_treatment_image\(\s*\n\s*p_image_id\s+uuid,\s*\n\s*p_client_id uuid\s*\n\)/,
    );
  });

  it("derives the studio from the RESOURCE before resolving the actor", () => {
    const create =
      EXEC.match(
        /create or replace function public\.create_treatment_image_metadata[\s\S]*?\n\$\$;/,
      )?.[0] ?? "";
    // client -> studio -> actor, in that order.
    const clientLookup = create.indexOf("from public.clients c");
    const actorLookup = create.indexOf("treatment_image_actor(v_studio)");
    expect(clientLookup).toBeGreaterThan(-1);
    expect(actorLookup).toBeGreaterThan(clientLookup);

    for (const fn of ["set_treatment_image_note", "archive_treatment_image"]) {
      const body =
        EXEC.match(new RegExp(`create or replace function public\\.${fn}[\\s\\S]*?\\n\\$\\$;`))?.[0] ??
        "";
      const imageLookup = body.indexOf("from public.treatment_images t");
      const actor = body.indexOf("treatment_image_actor(v_studio)");
      expect(imageLookup, fn).toBeGreaterThan(-1);
      expect(actor, fn).toBeGreaterThan(imageLookup);
    }
  });

  it("preserves the non-disclosing refusal shapes", () => {
    const create =
      EXEC.match(
        /create or replace function public\.create_treatment_image_metadata[\s\S]*?\n\$\$;/,
      )?.[0] ?? "";
    // One message covers BOTH "no such client" and "not your studio".
    expect((create.match(/That client is not available\./g) ?? []).length).toBe(1);
    expect(create).toMatch(/Note is too long|treatment area is not available|session is not available/);
    // NOTE / ARCHIVE stay generic-NULL rather than raising.
    for (const fn of ["set_treatment_image_note", "archive_treatment_image"]) {
      const body =
        EXEC.match(new RegExp(`create or replace function public\\.${fn}[\\s\\S]*?\\n\\$\\$;`))?.[0] ??
        "";
      expect(body).toMatch(/return null;/);
    }
    // The 1000-char note ceiling is untouched.
    expect(EXEC).toMatch(/length\(v_note\) > 1000/);
  });
});

describe("0178 — privilege closure on public.practitioners", () => {
  it("STATES the policy — revoke ALL, then grant back only SELECT", () => {
    // An enumerated "everything except SELECT" list is a maintenance burden that
    // already failed once: PostgreSQL 17 added MAINTAIN, the list did not know
    // about it, and it survived. Revoking ALL cannot be outrun by a future
    // privilege.
    expect(EXEC).toMatch(
      /revoke all privileges on table public\.practitioners\s*\n\s*from public, anon, authenticated, service_role;/,
    );
    expect(EXEC).toMatch(
      /grant select on table public\.practitioners\s*\n\s*to anon, authenticated, service_role;/,
    );
    // ...and nothing else is granted back on the table.
    const grants = [...EXEC.matchAll(/grant\s+([a-z, ]+?)\s+on table public\.practitioners/gi)].map(
      (m) => m[1].trim().toLowerCase(),
    );
    expect(grants).toEqual(["select"]);
  });

  it("retires the obsolete mutation policies and KEEPS the read policy", () => {
    expect(EXEC).toMatch(/drop policy if exists "practitioners: owners insert"/);
    expect(EXEC).toMatch(/drop policy if exists "practitioners: owners update"/);
    // The roster is read all over the product through the authenticated client.
    expect(EXEC).not.toMatch(/drop policy if exists "practitioners: members read"/);
  });

  it("grants EXECUTE on the three commands to authenticated, and the helpers to nobody", () => {
    for (const fn of [
      "update_own_practitioner_profile\\(uuid, text, text\\)",
      "set_own_calendar_feed_token_hash\\(uuid, text\\)",
      "set_own_default_machine_frequency\\(uuid, text\\)",
    ]) {
      expect(EXEC).toMatch(new RegExp(`grant execute on function public\\.${fn} to authenticated;`));
    }
    expect(EXEC).not.toMatch(/grant execute on function public\.own_practitioner_in_studio/);
    expect(EXEC).not.toMatch(/grant execute on function public\.treatment_image_actor/);
    // Every function revokes from all four principals before any grant.
    for (const p of ["public", "anon", "authenticated", "service_role"]) {
      expect(EXEC).toMatch(new RegExp(`revoke execute on function %s from ${p}`));
    }
  });

  it("grants nothing back on the table", () => {
    expect(EXEC).not.toMatch(/grant\s+(insert|update|delete|truncate|references|trigger|all)[^;]*on table public\.practitioners/i);
  });
});

describe("0178 — scope discipline", () => {
  it("touches NO appointment object and does not re-emit the protected buffer", () => {
    for (const obj of [
      "snapshot_appointment_buffer",
      "public.appointments",
      "appointment_audit",
      "claim_postcare_send",
      "settle_postcare_send",
      "appointment_has_blocking_dependents",
      "revert_appointment_outcome",
      "mark_appointment_complete",
      "public_cancel_appointment_with_token",
    ]) {
      expect(EXEC, `0178 must not touch ${obj}`).not.toContain(obj);
    }
  });

  it("does not rewrite the governed team lifecycle", () => {
    // Recon proved it is already owner-gated per studio and multi-owner safe.
    for (const obj of [
      "set_practitioner_active_locked",
      "lock_studio_and_assert_owner",
      "reconcile_my_pending_invitation",
    ]) {
      expect(EXEC, `0178 must not touch ${obj}`).not.toContain(obj);
    }
  });

  it("creates no table, trigger or index, and performs no data mutation at apply time", () => {
    expect(EXEC).not.toMatch(/create table|alter table|create trigger|create index/i);
    // The DML inside function BODIES runs per call, never at apply. Outside the
    // bodies there must be none at all.
    const outside = EXEC.replace(/as \$\$[\s\S]*?\$\$;/g, "");
    for (const verb of ["insert into", "delete from", "update "]) {
      expect(outside.toLowerCase()).not.toContain(verb);
    }
  });
});
