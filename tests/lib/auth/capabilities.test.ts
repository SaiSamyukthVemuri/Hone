import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  accessSummary,
  CAPABILITY_LABELS,
  DEACTIVATED_SUMMARY,
  ROLE_CAPABILITIES,
  type CapabilityKey,
  type StudioRole,
} from "@/lib/auth/capabilities";

// STUDIO-READY-02e (#824): the fixed role definitions, pinned to contract §2.2
// (#830) and to what the code enforces today. If a role gains or loses
// anything, this file must change in the same commit as the enforcement.

const ROLES: StudioRole[] = ["owner", "practitioner", "receptionist"];
const KEYS = Object.keys(CAPABILITY_LABELS) as CapabilityKey[];

describe("every role states every capability", () => {
  it("no capability is left undefined for any role", () => {
    for (const r of ROLES) expect(Object.keys(ROLE_CAPABILITIES[r]).sort(), r).toEqual([...KEYS].sort());
  });
});

describe("the receptionist", () => {
  const r = ROLE_CAPABILITIES.receptionist;

  it("never reaches clinical, financial, export, team or settings capabilities, and is never treating capacity", () => {
    for (const k of [
      "clinical_records",
      "clinical_images",
      "treatment_recording",
      "payments",
      "refunds",
      "exports",
      "team",
      "studio_settings",
      "treating_capacity",
    ] as const) {
      expect(r[k], k).toBe("no");
    }
  });

  it("sees the schedule, contacts and completion status, the three 0216 projections", () => {
    expect([r.schedule_view, r.client_contacts, r.intake_status]).toEqual(["yes", "yes", "yes"]);
  });

  it("booking is stated as NOT YET available, never promised", () => {
    expect([r.schedule_book_move, r.schedule_cancel]).toEqual(["not_yet", "not_yet"]);
    expect(accessSummary("receptionist").cannot).toContain("Book and move appointments (not available yet)");
    expect(accessSummary("receptionist").cannot).toContain("Cancel appointments (not available yet)");
  });
});

describe("the practitioner and the owner", () => {
  it("a practitioner charges and sends receipts, but refunds, finance, exports, team and settings are owner-only", () => {
    const p = ROLE_CAPABILITIES.practitioner;
    expect(p.payments).toBe("yes");
    for (const k of ["refunds", "exports", "team", "studio_settings"] as const) expect(p[k], k).toBe("no");
    expect(p.schedule_book_move).toBe("own");
  });

  it("the owner holds every capability", () => {
    for (const k of KEYS) expect(ROLE_CAPABILITIES.owner[k], k).toBe("yes");
  });
});

describe("the definitions match the enforcement they describe", () => {
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

  it("a practitioner moves only their own appointments, but may cancel anyone's (Codex P2 4243990812)", () => {
    // Move: a non-owner must be the treating practitioner and may not reassign.
    expect(read("supabase/migrations/0145_move_preserve_target_race_fix.sql")).toMatch(
      /if v_actor_role <> 'owner'\s+and \(v_appt\.practitioner_id is distinct from p_actor_practitioner_id or v_reassign\)/,
    );
    expect(ROLE_CAPABILITIES.practitioner.schedule_cancel).toBe("any");
    expect(accessSummary("practitioner").can).toContain("Cancel appointments (anyone's in the studio)");
  });

  it("claims nothing the product withholds: no record signing, no financial report, no role changes (Codex P1 4243990803, P2s 4243990815, 4243990818)", () => {
    const all = Object.values(CAPABILITY_LABELS).join(" | ").toLowerCase();
    // "signed forms" (consent forms) are real; signing a RECORD is what 0159 retired.
    expect(all).not.toMatch(/sign (treatment )?records|record signing/);
    expect(all).not.toMatch(/financial report|reports/);
    expect(all).not.toMatch(/change roles|role change/);
    // 0159 retired signed clinical records.
    expect(read("supabase/migrations/0159_retire_signed_clinical_records.sql").length).toBeGreaterThan(0);
  });

  it("refunds really are owner-only in both refund paths", () => {
    expect(read("app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts")).toMatch(
      /OWNER-ONLY, consistently across session payments and fees/,
    );
    expect(read("app/(app)/calendar/[id]/manual-fee-actions.ts")).toMatch(/OWNER-ONLY, consistently across session payments and fees/);
  });

  it("the front desk reads only through the three 0216 projections", () => {
    const projections = read("lib/receptionist/projections.ts");
    const rpcs = [...projections.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(rpcs).toEqual(["receptionist_calendar", "receptionist_calendar_closures", "receptionist_client_contacts"]);
  });

  it("the team page renders a summary for practitioners AND receptionists", () => {
    const page = read("app/(app)/settings/team/page.tsx");
    expect(page).toMatch(/<AccessSummary role=\{p\.role\} \/>/);
    expect(page).toMatch(/<AccessSummary role="receptionist" active=\{r\.active\} \/>/);
  });

  it("a DEACTIVATED receptionist's summary is a single denial, never the role's list (Codex P2 4243990807)", () => {
    const page = read("app/(app)/settings/team/page.tsx");
    expect(page).toMatch(/if \(!active\) return <p[^>]*>\{DEACTIVATED_SUMMARY\}<\/p>;/);
    expect(DEACTIVATED_SUMMARY).toMatch(/no access/);
  });
});
