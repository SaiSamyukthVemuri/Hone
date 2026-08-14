import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// PR #205 (migration 0085): Record Keeping tab + probe lot numbers.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PAGE = read("app/(app)/records/page.tsx");
const FORMS = read("app/(app)/records/record-forms.tsx");
const ACTIONS = read("app/(app)/records/actions.ts");
const QUERIES = read("lib/record-keeping/queries.ts");
const LAYOUT = read("app/(app)/layout.tsx");
const MIGRATION = read(
  "supabase/migrations/0085_record_keeping_and_probe_lot_numbers.sql",
);
const FORM = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
);
const BLOCK_ACTIONS = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
);
const BLOCKS_VIEW = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx",
);

describe("Record Keeping navigation", () => {
  it("is a top-level nav tab, not under Settings", () => {
    expect(LAYOUT).toMatch(/href="\/records"/);
    expect(LAYOUT).toMatch(/Record Keeping/);
    expect(() => read("app/(app)/settings/records/page.tsx")).toThrow();
  });

  it("the page is inside the authenticated (app) layout and resolves the studio server-side", () => {
    expect(PAGE).toMatch(/getCurrentPractitionerWithStudio/);
    expect(PAGE).not.toMatch(/"use client"/);
  });

  it("has the four sections", () => {
    expect(PAGE).toMatch(/Sterile Items/);
    expect(PAGE).toMatch(/Disinfectants/);
    expect(PAGE).toMatch(/Exposure Incidents/);
    // PR #238 (Chloe pilot): friendlier nav label; the printed
    // document keeps its formal title.
    expect(PAGE).toMatch(/label: "Procedure records"/);
    expect(PAGE).not.toMatch(/label: "Client Procedure Records"/);
  });
});

describe("Sterile Items", () => {
  it("form has the BodySafe fields", () => {
    for (const f of [
      "date_purchased",
      "item_description",
      "manufacturer_name",
      "amount_purchased",
      "lot_number",
      "expiry_date",
    ]) {
      expect(FORMS).toMatch(new RegExp(`name="${f}"`));
    }
  });

  it("records list newest first with lot and expiry visible", () => {
    expect(QUERIES).toMatch(
      /from\("record_keeping_sterile_items"\)[\s\S]{0,200}order\("date_purchased", \{ ascending: false \}\)/,
    );
    expect(PAGE).toMatch(/Lot #:/);
    expect(PAGE).toMatch(/Expiry:/);
  });

  it("the action requires the required fields and resolves studio server-side", () => {
    expect(ACTIONS).toMatch(/Date purchased and item description are required\./);
    expect(ACTIONS).not.toMatch(/formData\.get\("studio_id"\)/);
  });
});

describe("Disinfectants", () => {
  it("form has the BodySafe fields", () => {
    for (const f of [
      "date_prepared",
      "disinfectant_name",
      "concentration",
      "date_discarded",
      "operator_name",
    ]) {
      expect(FORMS).toMatch(new RegExp(`name="${f}"`));
    }
  });

  it("list shows prepared and discarded dates clearly", () => {
    expect(PAGE).toMatch(/Prepared:/);
    expect(PAGE).toMatch(/Discarded:/);
  });
});

describe("Exposure Incidents (sensitive)", () => {
  it("form has the BodySafe fields", () => {
    for (const f of [
      "incident_date",
      "exposed_person_full_name",
      "exposed_person_address",
      "exposed_person_phone",
      "exposure_details",
      "action_taken",
      "staff_involved_name",
    ]) {
      expect(FORMS).toMatch(new RegExp(`name="${f}"`));
    }
  });

  it("no public/portal surface imports the record-keeping module", () => {
    const out = execSync(
      'grep -rl "record-keeping\\|record_keeping" app/book app/portal app/intake app/cancel app/reschedule lib/email app/api 2>/dev/null || true',
      { cwd: process.cwd() },
    )
      .toString()
      .trim();
    expect(out).toBe("");
  });
});

describe("Client Procedure Records (generated, never invented)", () => {
  it("builds from existing clients/sessions/blocks and renders missing as Not recorded", () => {
    expect(QUERIES).toMatch(/getClientProcedureRecords/);
    expect(QUERIES).toMatch(
      /clients\(id, name, date_of_birth, phone, email, address\)/,
    );
    expect(QUERIES).toMatch(/probe_lot_number/);
    expect(PAGE).toMatch(/Not recorded/);
  });

  it("shows operator, items used with lot numbers, and the aftercare status", () => {
    expect(PAGE).toMatch(/Operator:/);
    expect(PAGE).toMatch(/Items used/);
    expect(PAGE).toMatch(/<AftercareExplainedToggle/);
  });

  it("aftercare mark is explicit, reversible, and the only writer", () => {
    expect(ACTIONS).toMatch(/markAftercareExplainedAction/);
    // L18 Phase 3: both columns are now set/cleared together inside
    // set_session_aftercare_explained (migration 0167). The property is
    // unchanged and asserted MORE strongly there, the stamping practitioner
    // is derived from auth.uid() instead of being sent by the caller.
    expect(ACTIONS).toMatch(/rpc\("set_session_aftercare_explained"/);
    expect(ACTIONS).toMatch(/p_explained: explained/);
    const MIGRATION = readFileSync(
      "supabase/migrations/0167_session_write_commands.sql",
      "utf8",
    );
    expect(MIGRATION).toMatch(/aftercare_and_risks_explained_at\s*=/);
    expect(MIGRATION).toMatch(/aftercare_and_risks_explained_by\s*=/);
    expect(FORMS).toMatch(
      /Mark: procedure risks explained and aftercare information provided/,
    );
    expect(BLOCK_ACTIONS).not.toMatch(/aftercare_and_risks_explained/);
  });
});

describe("probe lot/batch number in charting", () => {
  it("renders inside the Probe section, after probe selection and before Mode", () => {
    const probeIdx = FORM.indexOf(">Probe</span>");
    const lotIdx = FORM.indexOf(">Probe lot/batch number</span>");
    const modeIdx = FORM.indexOf(">Mode</span>");
    expect(probeIdx).toBeGreaterThan(-1);
    expect(lotIdx).toBeGreaterThan(probeIdx);
    expect(modeIdx).toBeGreaterThan(lotIdx);
    expect(FORM).toMatch(
      /Used for health inspection and client procedure records\./,
    );
  });

  it("(0155) optional; saves the server-derived snapshot via both save paths; null-safe load", () => {
    expect(FORM).toMatch(
      /probeLotNumber: draft\.probeLotNumber\.trim\(\) \|\| null/,
    );
    expect(FORM).toMatch(/probeLotNumber: block\.probe_lot_number \?\? ""/);
    // Both actions now write the resolver's snapshot (DB-derived for a linked
    // lot, trimmed text for manual). The trim/120 lives in the validator.
    expect(
      BLOCK_ACTIONS.match(/probe_lot_number: inv\.probeLotNumber,/g)?.length,
    ).toBe(2);
  });

  it("shows in the treatment-area probe summary; null lots render as before", () => {
    expect(BLOCKS_VIEW).toMatch(/Lot #\$\{block\.probe_lot_number\.trim\(\)\}/);
    expect(BLOCKS_VIEW).toMatch(/block\.probe_lot_number\?\.trim\(\)/);
  });

  it("PR #204 charting order and PR #203 sticky frequency are intact", () => {
    const anchors = [
      // Migration 0128: the area section is now the multi-area editor, still first.
      "<MultiAreaEditor",
      ">Machine frequency</span>",
      ">Probe</span>",
      ">Mode</span>",
      ">Treatment readings</span>",
      ">Minutes performed (optional)</span>",
    ];
    let prev = -1;
    for (const a of anchors) {
      const i = FORM.indexOf(a);
      expect(i, a).toBeGreaterThan(prev);
      prev = i;
    }
    expect(FORM).toMatch(
      /machineFrequency: defaultMachineFrequency\?\.trim\(\) \|\| ""/,
    );
  });
});

describe("migration 0085: additive, RLS-enabled, no payment/auth tables", () => {
  it("creates the three studio-scoped tables with per-command RLS and NO delete", () => {
    for (const t of [
      "record_keeping_sterile_items",
      "record_keeping_disinfectants",
      "record_keeping_exposure_incidents",
    ]) {
      expect(MIGRATION).toMatch(
        new RegExp(`create table if not exists public\\.${t}`),
      );
      expect(MIGRATION).toMatch(
        new RegExp(`alter table public\\.${t} enable row level security`),
      );
      // Per-command policies: select (USING), insert (WITH CHECK),
      // update (USING + WITH CHECK).
      expect(MIGRATION).toMatch(
        new RegExp(`"${t}: members select"\\s*\\n\\s*on public\\.${t} for select to authenticated\\s*\\n\\s*using \\(public\\.is_studio_member\\(studio_id\\)\\)`),
      );
      expect(MIGRATION).toMatch(
        new RegExp(`"${t}: members insert"\\s*\\n\\s*on public\\.${t} for insert to authenticated\\s*\\n\\s*with check \\(public\\.is_studio_member\\(studio_id\\)\\)`),
      );
      expect(MIGRATION).toMatch(
        new RegExp(`"${t}: members update"\\s*\\n\\s*on public\\.${t} for update to authenticated\\s*\\n\\s*using \\(public\\.is_studio_member\\(studio_id\\)\\)\\s*\\n\\s*with check \\(public\\.is_studio_member\\(studio_id\\)\\)`),
      );
      // NO delete policy, and no FOR ALL on these sensitive tables.
      expect(MIGRATION).not.toMatch(new RegExp(`on public\\.${t} for delete`));
      expect(MIGRATION).not.toMatch(new RegExp(`on public\\.${t} for all`));
    }
    expect(MIGRATION).not.toMatch(/for delete/);
    // 3 tables x (1 select USING + 1 insert CHECK + 2 update) = 12.
    expect(MIGRATION.match(/is_studio_member\(studio_id\)/g)?.length).toBe(12);
  });

  it("adds the nullable block + session columns; additive only", () => {
    expect(MIGRATION).toMatch(/add column if not exists probe_lot_number text/);
    expect(MIGRATION).toMatch(
      /add column if not exists aftercare_and_risks_explained_at timestamptz/,
    );
    expect(MIGRATION).toMatch(
      /add column if not exists aftercare_and_risks_explained_by uuid/,
    );
    expect(MIGRATION).not.toMatch(/drop table/i);
    expect(MIGRATION).not.toMatch(/drop column/i);
    expect(MIGRATION).not.toMatch(/update public\./i);
    expect(MIGRATION).not.toMatch(/stripe|payment_charge|auth\.users/i);
    expect(MIGRATION).not.toMatch(/to anon/);
  });
});
