import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Migration 0114 + code PR: "Remove pass" = audited SOFT-DELETE of one
// treatment pass (an electrolysis_entries / laser_entries row), replacing the
// old bare-✕ HARD delete. The clinical record is preserved (deleted_at /
// deleted_by / delete_reason), hidden from every active view, and only the
// selected pass is voided — never the block/area, session, appointment, client,
// other passes, or photos.
//
// Source-level guarantees (matching the clinical-lineage / last-treatment-cleanup
// house style). True DB behavior (A stays after B removed, cross-studio reject,
// no double-void) is guaranteed by the code mechanisms asserted below and is a
// candidate for a follow-up db-integration test.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const MIGRATION = read("supabase/migrations/0114_entry_soft_delete.sql");
const SESSION_ACTIONS = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts",
);
const SESSION_ACTIONS_CODE = stripComments(SESSION_ACTIONS);
const QUERIES = read("lib/supabase/queries.ts");
const PREVIEWS = read("lib/dashboard/before-today-previews.ts");
const CLIENT_PAGE = read("app/(app)/clients/[id]/page.tsx");
const BLOCKS_VIEW = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx",
);
const SESSION_PAGE = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
);
const REMOVE_BTN = read("components/remove-pass-button.tsx");
const TYPES = read("lib/types/database.ts");

describe("0114 migration: additive soft-delete columns on both pass tables", () => {
  it("adds deleted_at/deleted_by/delete_reason to electrolysis_entries and laser_entries", () => {
    for (const tbl of ["electrolysis_entries", "laser_entries"]) {
      const chunk = MIGRATION.slice(MIGRATION.indexOf(`alter table public.${tbl}`));
      expect(chunk).toMatch(/add column if not exists deleted_at\s+timestamptz/);
      expect(chunk).toMatch(
        /add column if not exists deleted_by\s+uuid references public\.practitioners\(id\) on delete set null/,
      );
      expect(chunk).toMatch(/add column if not exists delete_reason text/);
    }
  });

  it("adds active partial indexes and is non-destructive (no backfill / no RLS change)", () => {
    expect(MIGRATION).toMatch(/electrolysis_entries_active_idx[\s\S]*where deleted_at is null/);
    expect(MIGRATION).toMatch(/laser_entries_active_idx[\s\S]*where deleted_at is null/);
    // Additive only — no update of existing rows, no RLS/policy change here.
    expect(MIGRATION).not.toMatch(/^\s*update\s/im);
    expect(MIGRATION).not.toMatch(/drop\s+policy/i);
    expect(MIGRATION).not.toMatch(/create\s+policy/i);
    expect(MIGRATION).not.toMatch(/enable row level security/i);
  });
});

describe("server actions: audited soft-delete, no hard delete", () => {
  it("removes a pass via UPDATE of deleted_at/deleted_by/delete_reason (not DELETE)", () => {
    expect(SESSION_ACTIONS_CODE).toMatch(/deleted_at: new Date\(\)\.toISOString\(\)/);
    expect(SESSION_ACTIONS_CODE).toMatch(/deleted_by: practitioner\.id/);
    expect(SESSION_ACTIONS_CODE).toMatch(/delete_reason: reason/);
    // No hard delete remains on the pass tables anywhere in this file.
    expect(SESSION_ACTIONS_CODE).not.toMatch(
      /from\("electrolysis_entries"\)[\s\S]{0,80}\.delete\(\)/,
    );
    expect(SESSION_ACTIONS_CODE).not.toMatch(
      /from\("laser_entries"\)[\s\S]{0,80}\.delete\(\)/,
    );
  });

  it("guards active-only (no double-void) + active practitioner + session ownership + rejects already-removed", () => {
    expect(SESSION_ACTIONS_CODE).toMatch(/\.is\("deleted_at", null\)/);
    expect(SESSION_ACTIONS_CODE).toMatch(/practitioner\.active/);
    expect(SESSION_ACTIONS_CODE).toMatch(/assertSessionVisible\(studio\.id, clientId, sessionId\)/);
    expect(SESSION_ACTIONS_CODE).toMatch(/has already been removed/);
    // Scoped to the exact row + its session (cross-studio blocked by
    // assertSessionVisible + RLS; only this pass is touched).
    expect(SESSION_ACTIONS_CODE).toMatch(/\.eq\("id", id\)/);
    expect(SESSION_ACTIONS_CODE).toMatch(/\.eq\("session_id", sessionId\)/);
  });

  it("both delete-entry actions route through the soft-delete helper", () => {
    expect(SESSION_ACTIONS_CODE).toMatch(
      /deleteElectrolysisEntryAction[\s\S]{0,120}softDeleteEntry\("electrolysis_entries"/,
    );
    expect(SESSION_ACTIONS_CODE).toMatch(
      /deleteLaserEntryAction[\s\S]{0,120}softDeleteEntry\("laser_entries"/,
    );
  });
});

describe("read paths exclude voided passes (not counted as active anywhere)", () => {
  it("client + session loaders strip soft-deleted entries", () => {
    expect(QUERIES).toMatch(/function stripDeletedEntries/);
    expect(QUERIES).toMatch(/\.filter\(\s*\(e\) => !e\.deleted_at/);
    // getClientById maps sessions through the stripper; getSessionForClient too.
    expect(QUERIES).toMatch(/\.map\(\s*stripDeletedEntries/);
    expect(QUERIES).toMatch(/stripDeletedEntries\(data as SessionWithEntries\)/);
  });

  it("block-level + count + recent-entry loaders exclude voided passes", () => {
    // getSessionWithBlocks entries query filters deleted_at.
    expect(QUERIES).toMatch(
      /from\("electrolysis_entries"\)[\s\S]{0,120}\.is\("deleted_at", null\)/,
    );
    // laser treatment-count + recent-entry skip voided rows.
    expect(QUERIES).toMatch(/laser_entries\(zone, deleted_at\)/);
    expect(QUERIES).toMatch(/if \(e\.deleted_at\) continue/);
    expect(QUERIES).toMatch(/\.filter\(\(e\) => !e\.deleted_at\)/);
  });

  it("Treatment Intelligence + dashboard preview do not count voided-pass hairs", () => {
    expect(CLIENT_PAGE).toMatch(/electrolysis_entries\(hairs_treated, deleted_at\)/);
    expect(CLIENT_PAGE).toMatch(/\.filter\(\(e\) => !e\.deleted_at\)/);
    expect(PREVIEWS).toMatch(/electrolysis_entries\(hairs_treated, deleted_at\), laser_entries\(id, deleted_at\)/);
    expect(PREVIEWS).toMatch(/\.filter\(\s*\(e\) => !e\.deleted_at/);
  });

  it("entry types carry the soft-delete triad", () => {
    // Both ElectrolysisEntry and LaserEntry expose deleted_at (so filters typecheck).
    const el = TYPES.slice(TYPES.indexOf("export type ElectrolysisEntry"));
    expect(el.slice(0, el.indexOf("};"))).toMatch(/deleted_at: string \| null/);
    const la = TYPES.slice(TYPES.indexOf("export type LaserEntry"));
    expect(la.slice(0, la.indexOf("};"))).toMatch(/deleted_at: string \| null/);
  });
});

describe("UI: Remove pass with confirmation, no bare-✕ hard delete", () => {
  it("RemovePassButton shows the exact retrospective confirmation copy + optional reason", () => {
    expect(REMOVE_BTN).toMatch(
      /Remove this pass from the active treatment record\? Other passes for this\s*area will stay\./,
    );
    expect(REMOVE_BTN).toMatch(/name="reason"/);
    expect(REMOVE_BTN).toMatch(/Reason \(optional\)/);
  });

  it("both charting surfaces use RemovePassButton and drop the old ✕ delete form", () => {
    expect(BLOCKS_VIEW).toMatch(/<RemovePassButton/);
    expect(SESSION_PAGE).toMatch(/<RemovePassButton/);
    // The old bare-✕ "Delete entry" affordance is gone from both.
    expect(BLOCKS_VIEW).not.toMatch(/aria-label="Delete entry"/);
    expect(SESSION_PAGE).not.toMatch(/aria-label="Delete entry"/);
    expect(BLOCKS_VIEW).not.toMatch(/>✕</);
    expect(SESSION_PAGE).not.toMatch(/>✕</);
  });
});

describe("no unrelated behavior touched", () => {
  it("no photos deleted + no payment/email/SMS in the changed action file", () => {
    expect(SESSION_ACTIONS_CODE).not.toMatch(/treatment_images|storage|\.remove\(/);
    expect(SESSION_ACTIONS_CODE).not.toMatch(/stripe|payment_charge|resend|twilio|sendSms|sendEmail/i);
  });
});
