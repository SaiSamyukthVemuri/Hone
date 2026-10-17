import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, migrationVersions } from "./helpers/migration-state";
import {
  grantedRoles,
  revokedRoles,
  REQUIRED_REVOKES,
  BLANKET_FUNCTION_GRANT,
} from "./helpers/grant-posture";

// 0231 · FETT photos (HON-43): a client identification portrait. Source
// contract only; the behaviour (refusals, archive clears, actor) is proved
// against a real database in tests/db/client-identification-portrait.db.test.ts.

const VERSION = "0231";
const FILE = "supabase/migrations/0231_client_identification_portrait.sql";
const sql = readFileSync(FILE, "utf8");
/** Executable SQL only — line comments stripped before block comments. */
const EXECUTABLE = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
/** Top level only (function bodies blanked). */
const TOP_LEVEL = EXECUTABLE.replace(/\$\$[\s\S]*?\$\$/g, " <body> ");

const COMMAND = "set_client_portrait";
const COMMAND_ARGS = "uuid, uuid";
const TRIGGER_FNS = ["clients_portrait_integrity"];

describe("0231 sits correctly in the migration sequence", () => {
  it("is present exactly once, above the photo table and actor it builds on", () => {
    // NO isRepoMax PIN, for the reason 0225's and 0228's tests record: it is a
    // claim about which TREE the test runs in and goes red in composition.
    const versions = migrationVersions();
    expect(countVersion(VERSION)).toBe(1);
    expect(versions, "treatment_images is created by 0092").toContain("0092");
    expect(versions, "treatment_image_actor(studio) is 0178's").toContain("0178");
  });
});

describe("0231's transaction and shape", () => {
  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(sql).toMatch(/^begin;/m);
    expect(sql).toMatch(/set local lock_timeout = '5s';/);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql.indexOf("set local lock_timeout")).toBeGreaterThan(sql.indexOf("begin;"));
  });

  it("adds ONE nullable pointer column and writes no rows", () => {
    expect(TOP_LEVEL).toMatch(
      /alter table public\.clients\s+add column if not exists portrait_image_id uuid\s+references public\.treatment_images \(id\) on delete set null;/,
    );
    // Nullable: no NOT NULL on the new column, and no SET NOT NULL anywhere.
    expect(TOP_LEVEL).not.toMatch(/portrait_image_id uuid\s+not null/);
    expect(TOP_LEVEL).not.toMatch(/\bset not null\b/);
    expect(TOP_LEVEL).not.toMatch(/\binsert into\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bdelete from\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bupdate public\./i);
    expect(TOP_LEVEL).not.toMatch(/\bcreate table\b/i);
  });

  it("enforces same client + studio, client scope and not-archived IN THE DATABASE", () => {
    const body = sql.slice(sql.indexOf("function public.clients_portrait_integrity"));
    for (const clause of [
      "t.client_id = new.id",
      "t.studio_id = new.studio_id",
      "t.session_id is null",
      "t.session_block_id is null",
      "t.deleted_at is null",
    ]) {
      expect(body, clause).toContain(clause);
    }
    expect(TOP_LEVEL).toMatch(
      /before insert or update of portrait_image_id on public\.clients\s+for each row execute function public\.clients_portrait_integrity\(\);/,
    );
    // NO trigger on treatment_images: its trigger set is pinned by the 0093,
    // 0168 and 0169 guards (CI db lane), so this migration adds none there.
    expect(TOP_LEVEL).not.toMatch(/on public\.treatment_images/);
  });

  it("archive clears the portrait ATOMICALLY in the archive command (Codex P2 4302494067)", () => {
    const body = sql.slice(sql.indexOf("create or replace function public.archive_treatment_image"));
    expect(body).toMatch(/security definer\s+set search_path = ''/);
    expect(body).toMatch(
      /update public\.clients c\s+set portrait_image_id = null\s+where c\.id = p_client_id\s+and c\.studio_id = v_studio\s+and c\.portrait_image_id = v_id;/,
    );
    // The 0168 guards: no row or storage deletion in any image command.
    expect(EXECUTABLE).not.toMatch(/delete from/i);
    expect(EXECUTABLE).not.toMatch(/storage\./);
    // And the setter locks the photo row so a concurrent archive waits.
    const integrity = sql.slice(sql.indexOf("function public.clients_portrait_integrity"));
    expect(integrity).toMatch(/for share;/);
    expect(TOP_LEVEL).toMatch(/create index if not exists clients_portrait_image_id_idx/);
  });

  it("resolves the actor per studio through treatment_image_actor, non-disclosingly", () => {
    const body = sql.slice(sql.indexOf("function public.set_client_portrait"));
    expect(body).toMatch(/from public\.treatment_image_actor\(v_studio\) a;/);
    expect(body).toMatch(/'That client is not available\.'/);
    expect(body).toMatch(/security definer\s+set search_path = ''/);
  });
});

describe("0231's grant posture (CLAUDE.md §5; clinical-rpc-grant-guard)", () => {
  it("the command is revoked from all four by name, then granted to authenticated ONLY", () => {
    expect(revokedRoles(EXECUTABLE, COMMAND, COMMAND_ARGS)).toEqual(REQUIRED_REVOKES);
    expect(grantedRoles(EXECUTABLE, COMMAND, COMMAND_ARGS)).toEqual(["authenticated"]);
  });

  it("the trigger functions are revoked from all four and never granted back", () => {
    for (const fn of TRIGGER_FNS) {
      expect(revokedRoles(EXECUTABLE, fn, ""), fn).toEqual(REQUIRED_REVOKES);
      expect(grantedRoles(EXECUTABLE, fn, ""), fn).toEqual([]);
    }
  });

  it("the redefined archive command keeps its grant posture: revoked from all four, authenticated only", () => {
    expect(revokedRoles(EXECUTABLE, "archive_treatment_image", "uuid, uuid")).toEqual(REQUIRED_REVOKES);
    expect(grantedRoles(EXECUTABLE, "archive_treatment_image", "uuid, uuid")).toEqual(["authenticated"]);
  });

  it("carries no blanket function grant", () => {
    expect(EXECUTABLE).not.toMatch(BLANKET_FUNCTION_GRANT);
  });
});
