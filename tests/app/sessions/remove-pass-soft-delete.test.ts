import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Migration 0114 + code PR: "Remove pass" = audited SOFT-DELETE of one
// treatment pass (an electrolysis_entries / laser_entries row), replacing the
// old bare-✕ HARD delete. The clinical record is preserved (deleted_at /
// deleted_by / delete_reason), hidden from every active view, and only the
// selected pass is voided, never the block/area, session, appointment, client,
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
    // Additive only: no update of existing rows, no RLS/policy change here.
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
    // Scoped to the exact row + its session. Since migration 0169 the mutation
    // runs as service_role, which BYPASSES RLS, so these two predicates plus
    // assertSessionVisible ARE the tenant boundary, not a backstop to it.
    // Behaviourally proven in tests/db/remove-pass-soft-delete.db.test.ts.
    expect(SESSION_ACTIONS_CODE).toMatch(/\.eq\("id", id\)/);
    expect(SESSION_ACTIONS_CODE).toMatch(/\.eq\("session_id", sessionId\)/);
  });

  it("the authorization sequence runs BEFORE the service-role client is built", () => {
    const fn = SESSION_ACTIONS_CODE.slice(
      SESSION_ACTIONS_CODE.indexOf("async function softDeleteEntry("),
    );
    const body = fn.slice(0, fn.indexOf("\nexport async function"));
    const actorAt = body.indexOf("getCurrentPractitionerWithStudio()");
    const lineageAt = body.indexOf("assertSessionVisible(");
    const adminAt = body.indexOf("createAdminClient()");
    expect(actorAt, "actor must be resolved").toBeGreaterThan(-1);
    expect(lineageAt, "lineage must be asserted").toBeGreaterThan(-1);
    expect(adminAt, "the service-role client must be built").toBeGreaterThan(-1);
    expect(actorAt, "actor resolution must precede service-role").toBeLessThan(adminAt);
    expect(lineageAt, "lineage assertion must precede service-role").toBeLessThan(adminAt);
  });

  it("deleted_by comes from the server-resolved practitioner, never from the form", () => {
    expect(SESSION_ACTIONS_CODE).toMatch(/deleted_by: practitioner\.id/);
    const fn = SESSION_ACTIONS_CODE.slice(
      SESSION_ACTIONS_CODE.indexOf("async function softDeleteEntry("),
    );
    const body = fn.slice(0, fn.indexOf("\nexport async function"));
    // The only formData reads are id / session_id / client_id / reason, no
    // practitioner or studio id can be supplied by the browser.
    const reads = [...body.matchAll(/formData\.get\("([a-z_]+)"\)/g)].map((m) => m[1]);
    expect(new Set(reads)).toEqual(new Set(["id", "session_id", "client_id", "reason"]));
  });

  it("requires exactly one changed row and keeps raw DB errors out of the response", () => {
    expect(SESSION_ACTIONS_CODE).toMatch(/data\.length !== 1/);
    // The old `Failed to remove pass: ${error.message}` leaked the raw database
    // message; with service_role that can name tables, columns and privilege
    // state. Fixed safe copy only.
    expect(SESSION_ACTIONS_CODE).not.toMatch(/Failed to remove pass: \$\{error\.message\}/);
    expect(SESSION_ACTIONS_CODE).toMatch(/Could not remove this pass\. Please try again\./);
    // The operator log carries the sqlstate + ids, never the raw message or any
    // clinical text.
    expect(SESSION_ACTIONS_CODE).toMatch(/event: "remove_pass_update_failed"/);
    const logBlock = SESSION_ACTIONS_CODE.slice(
      SESSION_ACTIONS_CODE.indexOf('event: "remove_pass_update_failed"'),
    ).slice(0, 400);
    expect(logBlock).not.toMatch(/error\.message/);
    expect(logBlock).not.toMatch(/reason|comments|observation|area\b/);
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
    // Charting unification: the Treatment Intelligence block query now ALSO embeds
    // observation_chips (to read the unified findings), but STILL embeds deleted_at
    // and filters voided passes so their hairs are never counted.
    expect(CLIENT_PAGE).toMatch(/electrolysis_entries\(hairs_treated, observation_chips, deleted_at\)/);
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
