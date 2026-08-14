import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #252 (migration 0089): Imported Treatment Memory schema. Source-grep
// pins on the migration SQL so a future re-edit cannot silently drop the
// required tables/columns, weaken the not-null / FK posture, relax the
// owner-only write + no-delete RLS, remove the audit trail, or introduce
// raw-CSV / file / image / OCR storage. The behavioral proofs live in
// tests/db/imported-treatment-memory.db.test.ts (real migrated DB).

const MIGRATION = readFileSync(
  path.resolve(__dirname, "../../supabase/migrations/0089_imported_treatment_memory.sql"),
  "utf8",
);

describe("0089: required tables", () => {
  it("creates import_batches", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.import_batches/);
  });
  it("creates imported_treatment_memories", () => {
    expect(MIGRATION).toMatch(
      /create table if not exists public\.imported_treatment_memories/,
    );
  });
  it("creates the dedicated audit table", () => {
    expect(MIGRATION).toMatch(
      /create table if not exists public\.imported_treatment_memory_audit_events/,
    );
  });
});

describe("0089: import_batches columns + provenance constraint", () => {
  it("studio-scoped with cascade", () => {
    expect(MIGRATION).toMatch(
      /studio_id uuid not null\s*\n?\s*references public\.studios\(id\) on delete cascade/,
    );
  });
  it("source_type is constrained to the known set", () => {
    expect(MIGRATION).toMatch(
      /source_type text not null default 'other'\s*\n?\s*check \(source_type in \(\s*'paper_card',\s*'jane',\s*'fresha',\s*'spreadsheet',\s*'other'\s*\)\)/,
    );
  });
  it("carries batch-level soft-void columns", () => {
    for (const col of ["voided_at timestamptz", "void_reason text", "completed_at timestamptz"]) {
      expect(MIGRATION).toMatch(new RegExp(col.replace(/[()]/g, "\\$&")));
    }
    expect(MIGRATION).toMatch(/voided_by uuid references auth\.users\(id\) on delete set null/);
    expect(MIGRATION).toMatch(/created_by uuid references auth\.users\(id\) on delete set null/);
  });
});

describe("0089: imported_treatment_memories identity + text-heavy columns", () => {
  it("client_id is REQUIRED (not null)", () => {
    expect(MIGRATION).toMatch(
      /client_id uuid not null\s*\n?\s*references public\.clients\(id\) on delete cascade/,
    );
  });
  it("import_batch_id is REQUIRED and on delete RESTRICT", () => {
    expect(MIGRATION).toMatch(
      /import_batch_id uuid not null\s*\n?\s*references public\.import_batches\(id\) on delete restrict/,
    );
  });
  it("preserves messy original date text alongside a clean parsed date", () => {
    expect(MIGRATION).toMatch(/occurred_on date,/);
    expect(MIGRATION).toMatch(/occurred_on_text text,/);
  });
  it("keeps imported clinical values as TEXT (not forced into structured charting)", () => {
    for (const col of [
      "treatment_area_text text",
      "modality text",
      "method_or_machine text",
      "probe_type text",
      "probe_size text",
      "probe_lot text",
      "tolerance_text text",
      "reaction_text text",
      "caution_note text",
      "next_visit_note text",
      "imported_note text",
    ]) {
      expect(MIGRATION).toMatch(new RegExp(`\\b${col}\\b`));
    }
    expect(MIGRATION).toMatch(/aftercare_marked boolean,/);
  });
  it("carries per-row soft-void columns", () => {
    expect(MIGRATION).toMatch(/voided_by uuid references auth\.users\(id\) on delete set null/);
    expect(MIGRATION).toMatch(/imported_by uuid references auth\.users\(id\) on delete set null/);
  });
});

describe("0089: RLS, member read, owner-only write, NO delete", () => {
  it("enables RLS on all three tables", () => {
    for (const t of [
      "import_batches",
      "imported_treatment_memories",
      "imported_treatment_memory_audit_events",
    ]) {
      expect(MIGRATION).toMatch(
        new RegExp(`alter table public\\.${t}\\s*\\n?\\s*enable row level security`),
      );
    }
  });
  it("SELECT is studio-member-scoped on the import tables", () => {
    expect(MIGRATION).toMatch(
      /"import_batches: members select"[\s\S]*?for select to authenticated\s*\n?\s*using \(public\.is_studio_member\(studio_id\)\)/,
    );
    expect(MIGRATION).toMatch(
      /"imported_treatment_memories: members select"[\s\S]*?for select to authenticated\s*\n?\s*using \(public\.is_studio_member\(studio_id\)\)/,
    );
  });
  it("INSERT and UPDATE are OWNER-ONLY (is_studio_owner)", () => {
    expect(MIGRATION).toMatch(
      /"import_batches: owner insert"[\s\S]*?for insert to authenticated\s*\n?\s*with check \(public\.is_studio_owner\(studio_id\)\)/,
    );
    expect(MIGRATION).toMatch(
      /"import_batches: owner update"[\s\S]*?for update to authenticated\s*\n?\s*using \(public\.is_studio_owner\(studio_id\)\)\s*\n?\s*with check \(public\.is_studio_owner\(studio_id\)\)/,
    );
    expect(MIGRATION).toMatch(
      /"imported_treatment_memories: owner insert"[\s\S]*?with check \(public\.is_studio_owner\(studio_id\)\)/,
    );
    expect(MIGRATION).toMatch(
      /"imported_treatment_memories: owner update"[\s\S]*?using \(public\.is_studio_owner\(studio_id\)\)/,
    );
  });
  it("grants NO delete policy to anyone (soft void only)", () => {
    expect(MIGRATION).not.toMatch(/for delete/i);
  });

  it("revokes TRUNCATE + DELETE at the privilege layer (RLS does not gate TRUNCATE)", () => {
    expect(MIGRATION).toMatch(
      /revoke truncate, delete on\s*\n?\s*public\.import_batches,\s*\n?\s*public\.imported_treatment_memories,\s*\n?\s*public\.imported_treatment_memory_audit_events\s*\n?\s*from anon, authenticated/,
    );
    // The audit table additionally revokes direct insert/update (trigger-only).
    expect(MIGRATION).toMatch(
      /revoke insert, update on public\.imported_treatment_memory_audit_events\s*\n?\s*from anon, authenticated/,
    );
  });
  it("the audit trail is SELECT-only for members (append-only)", () => {
    expect(MIGRATION).toMatch(
      /"imported_treatment_memory_audit_events: members select"[\s\S]*?for select to authenticated\s*\n?\s*using \(public\.is_studio_member\(studio_id\)\)/,
    );
    // No insert/update/for-all policy on the audit table.
    expect(MIGRATION).not.toMatch(/imported_treatment_memory_audit_events" for (insert|update|all)/);
  });
});

describe("0089: audit trigger + updated_at trigger, no raw-blob storage", () => {
  it("defines a dedicated SECURITY DEFINER audit trigger function and revokes execute", () => {
    expect(MIGRATION).toMatch(
      /create or replace function public\.imported_treatment_memory_audit_row\(\)[\s\S]*?security definer[\s\S]*?set search_path = ''/,
    );
    expect(MIGRATION).toMatch(
      /revoke execute on function public\.imported_treatment_memory_audit_row\(\)\s*\n?\s*from public, anon, authenticated/,
    );
  });
  it("attaches the audit trigger to both import tables", () => {
    expect(MIGRATION).toMatch(
      /create trigger import_batches_audit\s*\n?\s*after insert or update on public\.import_batches/,
    );
    expect(MIGRATION).toMatch(
      /create trigger imported_treatment_memories_audit\s*\n?\s*after insert or update on public\.imported_treatment_memories/,
    );
  });
  it("reuses set_updated_at for both import tables", () => {
    expect(MIGRATION).toMatch(/create trigger import_batches_set_updated_at[\s\S]*?execute function public\.set_updated_at\(\)/);
    expect(MIGRATION).toMatch(/create trigger imported_treatment_memories_set_updated_at[\s\S]*?execute function public\.set_updated_at\(\)/);
  });
  it("does NOT modify the Record Keeping audit infrastructure (only reuses the read-only actor helper)", () => {
    const exec = MIGRATION.split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    // No write to / alter of / redefinition of the record-keeping audit
    // table or its generic trigger function.
    expect(exec).not.toMatch(/insert into public\.record_keeping_audit_events/i);
    expect(exec).not.toMatch(/alter table public\.record_keeping/i);
    expect(exec).not.toMatch(/(create|drop)[\s\S]{0,40}record_keeping_audit_row/i);
    expect(exec).not.toMatch(/(create|drop)[\s\S]{0,40}record_keeping_audit_events/i);
    // The only record-keeping reference allowed is the read-only actor helper.
    expect(exec).toMatch(/public\.record_keeping_audit_actor\(new\.studio_id\)/);
  });
  it("stores NO raw CSV/TSV/file/image/OCR content", () => {
    // Executable SQL only: the header comment legitimately states that
    // paper scans / images / OCR are NOT stored.
    const exec = MIGRATION.split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(exec).not.toMatch(/raw_csv|raw_tsv|file_contents|raw_file|image|scan|ocr|bytea/i);
  });
});
