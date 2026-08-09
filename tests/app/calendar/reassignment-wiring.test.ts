import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR B Part 4 Item 7 — owner-only practitioner reassignment on the SHARED Move
// workflow. The DB authority (same-row reassignment, shadow re-key, audit,
// rollback, inactive/ineligible/cross-studio/member/pause) is proven by the
// move_or_reassign_appointment DB suite; these pin the app + UI + notification
// contract and the single-shared-path constraint.

const root = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const ACTIONS = read("app/(app)/calendar/move-appointment-actions.ts");
const DIALOG = read("app/(app)/calendar/MoveAppointmentDialog.tsx");
const BUTTON = read("app/(app)/calendar/MoveAppointmentButton.tsx");
const NOTIFY = read("lib/email/notify-appointment-moved.ts");
const DETAIL = read("app/(app)/calendar/[id]/page.tsx");
const DRAWER = read("app/(app)/calendar/AppointmentPreviewDrawer.tsx");

describe("Item 7 server — reassignment context + target-aware slots + submit", () => {
  it("loadMoveSlotsAction returns owner-only reassignment context + accepts a target", () => {
    expect(ACTIONS).toMatch(/targetPractitionerId\?: string \| null/);
    expect(ACTIONS).toMatch(/reassignEnabled:/);
    expect(ACTIONS).toMatch(/eligiblePractitioners:/);
    expect(ACTIONS).toMatch(/currentPractitionerValid:/);
    // owner + capacity ON only.
    expect(ACTIONS).toMatch(/const reassignEnabled =\s*\n?\s*practitioner\.role === "owner" && studio\.practitioner_capacity_enabled === true/);
    // eligibility via service_practitioners (active, same-studio, display names only).
    expect(ACTIONS).toMatch(/\.from\("service_practitioners"\)/);
    expect(ACTIONS).toMatch(/displayName: p\.display_name/);
    expect(ACTIONS).not.toMatch(/\.select\("id, email/);
  });
  it("fails closed on an eligibility lookup error + resolves NO slots when reassignment is required", () => {
    expect(ACTIONS).toMatch(/if \(error\) return null; \/\/ fail closed/);
    expect(ACTIONS).toMatch(/slotTarget = null; \/\/ reassignment required/);
  });
  it("moveAppointmentAction re-validates the target and never trusts a member/forged one", () => {
    expect(ACTIONS).toMatch(/if \(reassignEnabled && requestedTarget && requestedTarget !== appt\.practitioner_id\)/);
    expect(ACTIONS).toMatch(/if \(!eligible\.some\(\(p\) => p\.id === requestedTarget\)\)/);
    expect(ACTIONS).toMatch(/p_target_practitioner_id: target/);
    // the offered-slot recheck runs against the FINAL target.
    expect(ACTIONS).toMatch(/const slotTarget = target \?\? appt\.practitioner_id/);
  });
  it("maps the reassignment failure codes + computes the committed result kind", () => {
    for (const code of ["outside_availability", "practitioner_closed", "invalid_practitioner", "not_eligible", "booking_paused", "practitioner_reassignment_required"]) {
      expect(ACTIONS).toContain(`case "${code}":`);
    }
    expect(ACTIONS).toMatch(/const resultKind: MoveResultKind =/);
    expect(ACTIONS).toMatch(/resultKind,/); // passed to the notification + returned
    expect(ACTIONS).toMatch(/Appointment \$\{verb\}/);
  });
});

describe("Item 7 UI — shared MoveAppointmentDialog reassignment", () => {
  it("shows the selector only when reassignEnabled and blocks confirmation without a valid target", () => {
    expect(DIALOG).toMatch(/\{reassignEnabled && \(/);
    expect(DIALOG).toMatch(/aria-label="Practitioner"/);
    expect(DIALOG).toMatch(/const targetChosen = !reassignEnabled \|\| eligible\.some\(\(p\) => p\.id === target\)/);
    expect(DIALOG).toMatch(/canConfirm =\s*\n?\s*targetChosen &&/);
  });
  it("changing the target clears the selected slot + reloads target-specific slots (stale-guarded)", () => {
    expect(DIALOG).toMatch(/const onPickTarget = \(t: string\) => \{/);
    expect(DIALOG).toMatch(/setSelected\(null\)/);
    expect(DIALOG).toMatch(/if \(t\) load\(date, t\)/);
    expect(DIALOG).toMatch(/const loadReq = useRef\(0\)/);
    expect(DIALOG).toMatch(/if \(req !== loadReq\.current\) return/);
  });
  it("distinguishes move / reassign / move-and-reassign in the title, button + From→To", () => {
    expect(DIALOG).toMatch(/const isReassign = reassignEnabled && !!target && target !== currentPractitionerId/);
    expect(DIALOG).toMatch(/"Move and reassign appointment"/);
    expect(DIALOG).toMatch(/"Reassign appointment"/);
    expect(DIALOG).toMatch(/"Confirm reassign"/);
    expect(DIALOG).toMatch(/data-testid="reassign-from-to"/);
    expect(DIALOG).toMatch(/\{submitting \? opBusy : opVerb\}/);
    // reassignment-required state when the current practitioner is inactive/ineligible.
    expect(DIALOG).toMatch(/data-testid="reassignment-required"/);
  });
  it("submits the proposed target only for an owner (members/Legacy send null)", () => {
    expect(DIALOG).toMatch(/targetPractitionerId: reassignEnabled \? target : null/);
  });
});

describe("Item 7 notification — truthful per-kind copy", () => {
  it("distinguishes moved / reassigned / moved_and_reassigned and never claims a time change for a reassignment", () => {
    expect(NOTIFY).toMatch(/resultKind\?: MoveNotificationKind/);
    expect(NOTIFY).toMatch(/Your appointment has a new practitioner\./);
    expect(NOTIFY).toMatch(/The time is unchanged\./);
    expect(NOTIFY).toMatch(/Your appointment time and practitioner have changed\./);
    expect(NOTIFY).toMatch(/Your appointment time has changed\./); // plain move unchanged
    // Includes the display name, never a practitioner id.
    // PRE-0174 COMPATIBILITY: 0174 gives `appointments` three more FKs to
    // `practitioners`, after which a bare `practitioners(...)` embed raises
    // PGRST201 at runtime. The qualified form is valid on BOTH schemas
    // (`appointments_practitioner_same_studio_fk` exists since 0151), which is
    // why it ships before the migration. Pinned WITH the constraint name so a
    // silent revert to the ambiguous form fails here rather than in production.
    expect(NOTIFY).toMatch(
      /practitioner:practitioners!appointments_practitioner_same_studio_fk\(display_name\)/,
    );
    expect(NOTIFY).not.toMatch(/practitioner_id/);
  });
});

describe("Item 7 — single shared workflow (no parallel implementation)", () => {
  it("the button surfaces the per-kind success message", () => {
    expect(BUTTON).toMatch(/setNotice\(r\.message\)/);
  });
  it("BOTH render sites use the shared MoveAppointmentButton", () => {
    expect(DETAIL).toMatch(/<MoveAppointmentButton/);
    expect(DRAWER).toMatch(/<MoveAppointmentButton/);
  });
});
