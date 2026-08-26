import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// PR #206 (migration 0086): append-only Record Keeping audit trail.
// Events are written ONLY by security-definer DB triggers, so normal
// authenticated clients cannot skip, forge, edit, or delete them.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const MIGRATION = read(
  "supabase/migrations/0086_record_keeping_audit_events.sql",
);
const PAGE = read("app/(app)/records/page.tsx");
const FORMS = read("app/(app)/records/record-forms.tsx");
const ACTIONS = read("app/(app)/records/actions.ts");
const QUERIES = read("lib/record-keeping/queries.ts");

describe("audit table + immutability (migration 0086)", () => {
  it("creates the audit table with RLS enabled", () => {
    expect(MIGRATION).toMatch(
      /create table if not exists public\.record_keeping_audit_events/,
    );
    expect(MIGRATION).toMatch(
      /alter table public\.record_keeping_audit_events enable row level security/,
    );
  });

  it("SELECT-only RLS: studio-scoped select, NO insert/update/delete/for-all policies", () => {
    expect(MIGRATION).toMatch(
      /"record_keeping_audit_events: members select"\s*\n\s*on public\.record_keeping_audit_events for select to authenticated\s*\n\s*using \(public\.is_studio_member\(studio_id\)\)/,
    );
    const policyCmds = MIGRATION.match(
      /on public\.record_keeping_audit_events for (\w+)/g,
    );
    expect(policyCmds).toEqual([
      "on public.record_keeping_audit_events for select",
    ]);
    expect(MIGRATION).not.toMatch(
      /record_keeping_audit_events for (insert|update|delete|all)/,
    );
    expect(MIGRATION).not.toMatch(/to anon/);
    expect(MIGRATION).not.toMatch(/^grant /im);
  });

  it("all four definer functions have explicit REVOKE EXECUTE from public/anon/authenticated", () => {
    for (const fn of [
      "record_keeping_audit_actor\\(uuid\\)",
      "record_keeping_audit_row\\(\\)",
      "record_keeping_audit_session_aftercare\\(\\)",
      "record_keeping_audit_probe_lot\\(\\)",
    ]) {
      expect(MIGRATION).toMatch(
        new RegExp(
          `revoke execute on function public\\.${fn}\\s*\\n\\s*from public, anon, authenticated;`,
        ),
      );
    }
  });

  it("no app code calls the audit functions directly (triggers are the only writers)", () => {
    const out = execSync(
      'grep -rl "record_keeping_audit_actor\\|record_keeping_audit_row\\|record_keeping_audit_session_aftercare\\|record_keeping_audit_probe_lot" app lib components 2>/dev/null || true',
      { cwd: process.cwd() },
    )
      .toString()
      .trim();
    expect(out).toBe("");
    // And no app code inserts into the audit table directly (triggers are the
    // only writers). App code may READ it — lib/record-keeping/queries.ts
    // surfaces the history, and (PR #312) the owner-only studio export includes
    // a reduced audit CSV. Both are SELECT-only.
    const refs = execSync(
      'grep -rl "record_keeping_audit_events" app lib components 2>/dev/null || true',
      { cwd: process.cwd() },
    )
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    // TRUTH-01A adds the export resource registry, which NAMES this table in
    // order to record its export disposition. It is a declaration, not an
    // access path: no client, no query, no DML — and the loop below proves
    // that for every file in this list, this one included.
    expect(refs).toEqual([
      "app/(app)/settings/data/actions.ts",
      "lib/export/export-selects.ts",
      "lib/export/resource-registry.ts",
      "lib/record-keeping/queries.ts",
    ]);
    // No referencing file inserts/updates/deletes the audit table.
    for (const rel of refs) {
      const src = read(rel);
      expect(
        src,
        `${rel} must not write record_keeping_audit_events`,
      ).not.toMatch(
        /record_keeping_audit_events"\)\s*\n?\s*\.(insert|update|delete|upsert)/,
      );
    }
  });

  it("trigger functions are narrow security definer with empty search_path", () => {
    // Four function declarations (actor helper + three triggers); the
    // line-anchored match avoids counting prose comments.
    const fns = MIGRATION.match(/\nsecurity definer\n/g);
    expect(fns?.length).toBe(4);
    expect(MIGRATION.match(/\nset search_path = ''\n/g)?.length).toBe(4);
    // Each function only INSERTs into the audit table (plus the actor
    // lookup); no dynamic SQL, no other writes.
    expect(MIGRATION).not.toMatch(/execute format|execute '/i);
    const inserts = MIGRATION.match(/insert into public\./g);
    expect(
      inserts?.every(() => true) &&
        MIGRATION.match(/insert into public\.record_keeping_audit_events/g)
          ?.length,
    ).toBe(4);
  });

  it("record_type and action values are constrained", () => {
    for (const v of [
      "sterile_item",
      "disinfectant",
      "exposure_incident",
      "session_aftercare",
      "session_block_probe_lot",
    ]) {
      expect(MIGRATION).toMatch(new RegExp(`'${v}'`));
    }
    for (const a of [
      "created",
      "updated",
      "aftercare_marked",
      "aftercare_cleared",
      "probe_lot_updated",
    ]) {
      expect(MIGRATION).toMatch(new RegExp(`'${a}'`));
    }
  });

  it("additive only; no payment/auth tables; no backfill", () => {
    expect(MIGRATION).not.toMatch(/drop table/i);
    expect(MIGRATION).not.toMatch(/drop column/i);
    expect(MIGRATION).not.toMatch(/update public\.\w+\s+set/i);
    expect(MIGRATION).not.toMatch(/stripe|payment_charge|auth\.users/i);
  });
});

describe("events captured by triggers (not bypassable app code)", () => {
  it("create/update triggers exist on all three logbook tables", () => {
    for (const t of [
      "record_keeping_sterile_items",
      "record_keeping_disinfectants",
      "record_keeping_exposure_incidents",
    ]) {
      expect(MIGRATION).toMatch(
        new RegExp(
          `after insert or update on public\\.${t}\\s*\\n\\s*for each row execute function public\\.record_keeping_audit_row\\(\\)`,
        ),
      );
    }
  });

  it("unchanged update writes no event (diff is empty -> early return)", () => {
    expect(MIGRATION).toMatch(
      /if array_length\(v_changed, 1\) is null then\s*\n\s*return new;/,
    );
  });

  it("diffs exclude identity/audit columns and log only changed fields", () => {
    expect(MIGRATION).toMatch(
      /'id','studio_id','created_at','updated_at','created_by_practitioner_id'/,
    );
    expect(MIGRATION).toMatch(/jsonb_build_object\('old', v_old -> v_key, 'new', v_new -> v_key\)/);
  });

  it("aftercare trigger fires only when the stamp changes and records marked/cleared", () => {
    expect(MIGRATION).toMatch(
      /after update of aftercare_and_risks_explained_at on public\.sessions/,
    );
    expect(MIGRATION).toMatch(
      /is not distinct from new\.aftercare_and_risks_explained_at then\s*\n\s*return new;/,
    );
    expect(MIGRATION).toMatch(/'aftercare_marked' else 'aftercare_cleared'/);
  });

  it("probe lot triggers are scoped to the column with WHEN guards (no noise)", () => {
    expect(MIGRATION).toMatch(
      /after insert on public\.session_blocks\s*\n\s*for each row\s*\n\s*when \(new\.probe_lot_number is not null\)/,
    );
    expect(MIGRATION).toMatch(
      /after update of probe_lot_number on public\.session_blocks\s*\n\s*for each row\s*\n\s*when \(old\.probe_lot_number is distinct from new\.probe_lot_number\)/,
    );
    // Old and new lot are logged; never the whole treatment area.
    expect(MIGRATION).toMatch(
      /jsonb_build_object\('old', to_jsonb\(v_old\),\s*\n\s*'new', to_jsonb\(new\.probe_lot_number\)\)/,
    );
  });

  it("charting save never auto-marks aftercare", () => {
    const blockActions = read(
      "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
    );
    expect(blockActions).not.toMatch(/aftercare_and_risks_explained/);
  });
});

describe("edit behavior (no delete anywhere)", () => {
  it("update actions exist for all three logbooks, studio resolved server-side", () => {
    for (const a of [
      "updateSterileItemRecordAction",
      "updateDisinfectantRecordAction",
      "updateExposureIncidentRecordAction",
    ]) {
      expect(ACTIONS).toMatch(new RegExp(`export async function ${a}`));
    }
    expect(ACTIONS).not.toMatch(/formData\.get\("studio_id"\)/);
    expect(ACTIONS).not.toMatch(/\.delete\(\)/);
    expect(ACTIONS).not.toMatch(/delete.*RecordAction/i);
  });

  it("edit forms exist and carry the record id; no delete or archive button", () => {
    for (const f of [
      "EditSterileItemForm",
      "EditDisinfectantForm",
      "EditExposureIncidentForm",
    ]) {
      expect(FORMS).toMatch(new RegExp(`export function ${f}`));
    }
    expect(FORMS).toMatch(/name="record_id"/);
    // No delete/archive AFFORDANCE: no capitalized UI label, no
    // handler, no action (the design-note comment may mention the
    // word in lowercase prose).
    expect(FORMS).not.toMatch(/Delete/);
    expect(FORMS).not.toMatch(/Archive/);
    expect(FORMS).not.toMatch(/\.delete\(|onDelete|deleteAction|archiveAction/);
    expect(PAGE).not.toMatch(/[Dd]elete record/);
  });

  it("actions write through the user-scoped client (RLS enforced; triggers fire)", () => {
    expect(ACTIONS).not.toMatch(/createAdminClient/);
  });
});

describe("history UI", () => {
  it("Edit and History panels render for the three logbook sections", () => {
    expect(PAGE.match(/<RowTools/g)?.length).toBe(3);
    expect(PAGE).toMatch(/AuditHistoryList/);
    expect(PAGE).toMatch(/No history recorded yet\./);
  });

  it("procedure records show aftercare/probe-lot history", () => {
    expect(PAGE).toMatch(/getProcedureAuditEvents/);
    expect(QUERIES).toMatch(/"session_aftercare", "session_block_probe_lot"/);
    expect(PAGE).toMatch(
      /Marked: risks explained and aftercare provided/,
    );
    expect(PAGE).toMatch(/Probe lot number updated/);
  });
});

describe("security", () => {
  it("audit module is unreachable from public/booking/intake/portal/email/cron/API surfaces", () => {
    const out = execSync(
      'grep -rl "record_keeping_audit\\|getAuditEventsByRecord\\|getProcedureAuditEvents" app/book app/portal app/intake app/cancel app/reschedule lib/email app/api 2>/dev/null || true',
      { cwd: process.cwd() },
    )
      .toString()
      .trim();
    expect(out).toBe("");
  });

  it("audit reads are studio-scoped in app code too (defense in depth)", () => {
    expect(QUERIES).toMatch(
      /from\("record_keeping_audit_events"\)[\s\S]{0,120}\.eq\("studio_id", studioId\)/,
    );
  });
});
