import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, migrationVersions } from "./helpers/migration-state";
import {
  grantedRoles,
  revokedRoles,
  REQUIRED_REVOKES,
  BLANKET_FUNCTION_GRANT,
} from "./helpers/grant-posture";

// 0232 · FETT photos (HON-43): label a visit photo before or after treatment.
// Source contract only; the behaviour (refusals, scope, actor) is proved
// against a real database in tests/db/treatment-image-capture-stage.db.test.ts.

const VERSION = "0232";
const FILE = "supabase/migrations/0232_treatment_image_capture_stage.sql";
const sql = readFileSync(FILE, "utf8");
/** Executable SQL only — line comments stripped before block comments. */
const EXECUTABLE = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
/** Top level only (function bodies blanked). */
const TOP_LEVEL = EXECUTABLE.replace(/\$\$[\s\S]*?\$\$/g, " <body> ");

const COMMAND = "set_treatment_image_capture_stage";
const COMMAND_ARGS = "uuid, uuid, text";

describe("0232 sits correctly in the migration sequence", () => {
  it("is present exactly once, above the photo table and actor it builds on", () => {
    // NO isRepoMax PIN, for the reason 0225's, 0228's and 0231's tests record:
    // it is a claim about which TREE the test runs in and goes red in
    // composition.
    const versions = migrationVersions();
    expect(countVersion(VERSION)).toBe(1);
    expect(versions, "treatment_images is created by 0092").toContain("0092");
    expect(versions, "treatment_image_actor(studio) is 0178's").toContain("0178");
  });
});

describe("0232's transaction and shape", () => {
  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(sql).toMatch(/^begin;/m);
    expect(sql).toMatch(/set local lock_timeout = '5s';/);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql.indexOf("set local lock_timeout")).toBeGreaterThan(sql.indexOf("begin;"));
  });

  it("adds ONE nullable, two-valued column and writes no rows", () => {
    expect(TOP_LEVEL).toMatch(
      /alter table public\.treatment_images\s+add column if not exists capture_stage text\s+constraint treatment_images_capture_stage_check\s+check \(capture_stage in \('before', 'after'\)\);/,
    );
    expect(TOP_LEVEL).not.toMatch(/capture_stage text\s+not null/);
    expect(TOP_LEVEL).not.toMatch(/\bset not null\b/);
    expect(TOP_LEVEL).not.toMatch(/\bdefault\b/i);
    expect(TOP_LEVEL).not.toMatch(/\binsert into\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bdelete from\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bupdate public\./i);
    expect(TOP_LEVEL).not.toMatch(/\bcreate table\b/i);
  });

  it("adds exactly ONE trigger, and leaves the pinned 0168 commands alone", () => {
    // treatment_images' trigger set is pinned by the 0093/0168/0169 guards;
    // tests/db/treatment-image-write-commands.db.test.ts names this one.
    // Codex 4308037526: a photo that loses its visit (0092's ON DELETE SET
    // NULL) loses its label. It REPAIRS, never refuses, so a session delete
    // can never be blocked; and it is no CHECK, which would make the cascade
    // throw.
    const triggers = TOP_LEVEL.match(/\bcreate (or replace )?trigger\b/gi) ?? [];
    expect(triggers).toHaveLength(1);
    expect(TOP_LEVEL).toMatch(
      /create trigger treatment_images_clear_stage_without_session\s+before update on public\.treatment_images\s+for each row\s+when \(new\.session_id is null and new\.capture_stage is not null\)\s+execute function public\.treatment_images_clear_stage_without_session\(\);/,
    );
    const fn = sql.slice(sql.indexOf("create or replace function public.treatment_images_clear_stage_without_session()"));
    expect(fn.slice(0, fn.indexOf("$$;") + 3)).toMatch(/begin\s+new\.capture_stage := null;\s+return new;\s+end;/);
    expect(fn.slice(0, fn.indexOf("$$;"))).not.toMatch(/raise/i);
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(TOP_LEVEL).toMatch(
        new RegExp(`revoke execute on function public\\.treatment_images_clear_stage_without_session\\(\\) from ${role};`),
      );
    }
    expect(TOP_LEVEL).not.toMatch(/grant execute on function public\.treatment_images_clear_stage_without_session/);
    // No table CHECK ties the label to a session.
    expect(TOP_LEVEL).not.toMatch(/check \([^)]*session_id/i);
    for (const pinned of [
      "create_treatment_image_metadata",
      "set_treatment_image_note",
      "archive_treatment_image",
      "treatment_image_actor",
    ]) {
      expect(TOP_LEVEL, pinned).not.toMatch(new RegExp(`function public\\.${pinned}\\(`));
    }
  });
});

describe("0232's command", () => {
  const body = sql.slice(sql.indexOf(`create or replace function public.${COMMAND}(`));

  it("is SECURITY DEFINER with an empty search_path and resolves the actor per studio", () => {
    expect(body).toMatch(/security definer\s+set search_path = ''/);
    expect(body).toMatch(/from public\.treatment_image_actor\(v_studio\) a;/);
  });

  it("reads only the client's current photo, and discloses scope only after the actor", () => {
    expect(body).toMatch(/t\.client_id = p_client_id\s+and t\.deleted_at is null;/);
    const actor = body.indexOf("treatment_image_actor(v_studio)");
    const scope = body.indexOf("v_session is null then");
    expect(actor).toBeGreaterThan(-1);
    expect(scope).toBeGreaterThan(actor);
    expect(body).toMatch(/'Only a photo from a visit can be marked before or after\.'/);
  });

  it("refuses a photo on a legacy finalized/void session BEFORE any write, and revives no retired path (0159)", () => {
    const retired = body.indexOf("if v_record in ('finalized', 'void') then");
    expect(retired).toBeGreaterThan(body.indexOf("treatment_image_actor(v_studio)"));
    expect(retired).toBeLessThan(body.indexOf("update public.treatment_images t"));
    expect(body.slice(retired, retired + 80)).toMatch(/return null;/);
    for (const r of ["build_session_snapshot", "_apply_image_correction", "amend_finalized_session", "correct_finalized_session"]) {
      expect(EXECUTABLE, r).not.toMatch(new RegExp(r));
    }
  });

  it("writes only capture_stage, on the same scoped row", () => {
    expect(body).toMatch(
      /update public\.treatment_images t\s+set capture_stage = p_stage\s+where t\.id = p_image_id\s+and t\.studio_id = v_studio\s+and t\.client_id = p_client_id\s+and t\.deleted_at is null/,
    );
    expect(body).not.toMatch(/\bdelete from\b/i);
    expect(body).not.toMatch(/\bstorage\./i);
  });
});

describe("0232's grant posture (CLAUDE.md §5; clinical-rpc-grant-guard)", () => {
  it("the command is revoked from all four by name, then granted to authenticated ONLY", () => {
    expect(revokedRoles(EXECUTABLE, COMMAND, COMMAND_ARGS)).toEqual(REQUIRED_REVOKES);
    expect(grantedRoles(EXECUTABLE, COMMAND, COMMAND_ARGS)).toEqual(["authenticated"]);
  });

  it("carries no blanket function grant", () => {
    expect(EXECUTABLE).not.toMatch(BLANKET_FUNCTION_GRANT);
  });
});
