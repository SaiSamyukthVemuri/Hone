import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// Clicking an appointment on the desktop week grid opens an in-context PREP
// WORKSPACE instead of navigating away. The full detail route is preserved and
// reached via "Open full details".
//
// WHAT CHANGED, AND WHY THIS FILE CHANGED WITH IT.
// This guard previously pinned the drawer as strictly read-only and query-free:
// it asserted the file contained no `"use server"`, no `startTransition`, and
// none of the words intake/consent/payment/cancelAppointment. That encoded a
// real product decision — a preview that cost nothing and could not mutate —
// and the drawer's own header comment said "It runs NO new query of its own."
//
// That decision has been deliberately superseded: the drawer is now the surface
// a practitioner preps from, so it loads prep detail lazily and hosts the
// shared lifecycle actions. Leaving the old assertions would have blocked the
// change; deleting them outright would have thrown away the property they were
// really protecting.
//
// So the INTENT is kept and re-pointed. The rule was never "the drawer must not
// act" — it was "the drawer must not become a second implementation of the
// detail page". Every assertion below enforces that: the drawer may CALL an
// authority, and may not BE one.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
// Strips comments so a negative grep tests CODE, not this file's own prose or
// the drawer's explanatory header.
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const DAYCOL = read("app/(app)/calendar/DayColumn.tsx");
const PREVIEW = read("app/(app)/calendar/AppointmentPreviewDrawer.tsx");
const PREVIEW_CODE = code("app/(app)/calendar/AppointmentPreviewDrawer.tsx");
const MOBILE = read("app/(app)/calendar/MobileDayTimeline.tsx");
const CAL_PAGE = read("app/(app)/calendar/page.tsx");
const ACTION = read("app/(app)/calendar/appointment-preview-actions.ts");

describe("appointment card opens an in-context preview (not a navigation)", () => {
  it("the desktop card is a button that opens the preview, not a Link", () => {
    expect(DAYCOL).toMatch(/onClick=\{\(\) => setPreview\(a\)\}/);
    expect(DAYCOL).not.toMatch(/<Link[\s\S]{0,120}\/calendar\/\$\{a\.id\}/);
  });
  it("DayColumn renders the preview drawer with the appointment + returnTo + tz + timeFormat", () => {
    expect(DAYCOL).toMatch(/<AppointmentPreviewDrawer/);
    expect(DAYCOL).toMatch(/appointment=\{preview\}/);
    expect(DAYCOL).toMatch(/returnTo=\{returnTo\}/);
    expect(DAYCOL).toMatch(/studioTimezone=\{tz\}/);
    expect(DAYCOL).toMatch(/timeFormat=\{timeFormat\}/);
  });
});

describe("preview keeps the summary it always had", () => {
  it("shows client, service, time range + duration, and status", () => {
    expect(PREVIEW).toMatch(/a\.client\?\.name/);
    expect(PREVIEW).toMatch(/a\.service\?\.name/);
    expect(PREVIEW).toMatch(/timeRangeLabel\(/);
    expect(PREVIEW).toMatch(/a\.duration_minutes/);
    expect(PREVIEW).toMatch(/appointmentDisplayStatus\(/);
  });
  it("respects the studio 12h/24h preference + timezone (never device-local)", () => {
    expect(PREVIEW).toMatch(/formatTimeForStudio\([^)]*timeFormat\)/);
    expect(PREVIEW).toMatch(/studioTimezone/);
    expect(PREVIEW_CODE).not.toMatch(/toLocaleTimeString|toLocaleString/);
  });
  it("includes an 'Open full details' deep link to /calendar/[id] with returnTo", () => {
    expect(PREVIEW).toMatch(/Open full details/);
    expect(PREVIEW).toMatch(/href=\{`\/calendar\/\$\{a\.id\}\$\{returnTo\}`\}/);
  });
  it("the full detail route still exists (not duplicated in the preview)", () => {
    expect(
      existsSync(path.resolve(__dirname, "../../../app/(app)/calendar/[id]/page.tsx")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The replacement for the old "READ-ONLY" section. The drawer may CALL an
// authority; it may not BE one.
// ---------------------------------------------------------------------------
describe("the drawer delegates every authority and defines none", () => {
  it("declares no server action of its own — it calls one that lives elsewhere", () => {
    expect(PREVIEW_CODE).not.toMatch(/"use server"/);
    expect(PREVIEW).toMatch(/loadAppointmentPreviewAction\(/);
  });

  it("holds no service-role or server-only code", () => {
    expect(PREVIEW_CODE).not.toMatch(
      /createAdminClient|admin-server|service_role|server-only/,
    );
    // It must not query the database directly either; the action does that.
    expect(PREVIEW_CODE).not.toMatch(/from\("appointments"\)|createClient\(/);
  });

  it("cancels through the shared PractitionerCancelForm, never a second cancel path", () => {
    expect(PREVIEW).toMatch(/<PractitionerCancelForm/);
    // NC6: duplicating the lifecycle mutation instead of mounting the shared
    // component turns this red.
    expect(PREVIEW_CODE).not.toMatch(/cancelAppointmentAction/);
    expect(PREVIEW_CODE).not.toMatch(/practitioner_cancel_appointment/);
  });

  it("reschedules through the shared MoveAppointmentButton, relabelled not forked", () => {
    expect(PREVIEW).toMatch(/<MoveAppointmentButton/);
    expect(PREVIEW).toMatch(/label="Reschedule"/);
    // The dialog and its actions stay behind the shared button.
    expect(PREVIEW_CODE).not.toMatch(/MoveAppointmentDialog|moveAppointmentAction/);
  });

  it("writes notes through the governed editor, never a second writer", () => {
    expect(PREVIEW).toMatch(/<AppointmentNotesEditor/);
    expect(PREVIEW_CODE).not.toMatch(/setAppointmentNotesAction|set_appointment_notes/);
  });

  it("renders last treatment with the shared component, not a local re-implementation", () => {
    expect(PREVIEW).toMatch(/<TodayTreatmentMemory/);
    // The selection rule and its helpers must not be restated here.
    expect(PREVIEW_CODE).not.toMatch(
      /hasChartedContent|pickNewestChartedSession|chartedSessionCandidates|buildAppointmentPrepMemory/,
    );
  });

  it("gates cancel/reschedule on the ONE shared predicate, not a local copy", () => {
    expect(PREVIEW).toMatch(/isAppointmentCancelable\(\{/);
    // NC3: showing Cancel unconditionally removes this gate and turns the
    // lifecycle cases in appointment-actionability.test.ts red.
    expect(PREVIEW).toMatch(/\{canAct && \(/);
  });
});

describe("intake routes to the authenticated practitioner surface only", () => {
  it("uses practitionerIntakeReviewHref and never hand-writes the path", () => {
    expect(PREVIEW).toMatch(/practitionerIntakeReviewHref\(/);
    // NC4: routing intake to the public token surface turns this red.
    expect(PREVIEW_CODE).not.toMatch(/href=\{`\/intake\//);
    expect(PREVIEW_CODE).not.toMatch(/\/intake\/\$\{/);
    expect(PREVIEW_CODE).not.toMatch(/token|bearer|magic/i);
  });
  it("mints no intake link", () => {
    expect(PREVIEW_CODE).not.toMatch(
      /generateIntakeLinkUrl|generateIntakeToken|mintIntake/,
    );
  });
  it("offers no review action for an unsubmitted or absent intake", () => {
    // in_progress renders state only. The two action branches are exactly
    // submitted and reviewed.
    expect(PREVIEW).toMatch(/Started, not yet submitted\./);
    expect(PREVIEW).toMatch(/No intake on file\./);
    const inProgressBranch = PREVIEW.slice(
      PREVIEW.indexOf('=== "in_progress"'),
      PREVIEW.indexOf("No intake on file."),
    );
    expect(inProgressBranch).not.toMatch(/practitionerIntakeReviewHref/);
  });
});

describe("the week grid still pays nothing (no N+1)", () => {
  it("the calendar RSC does not import the preview loader or its action", () => {
    expect(CAL_PAGE).not.toMatch(/appointment-preview-actions|appointment-preview-detail/);
    expect(CAL_PAGE).not.toMatch(/loadAppointmentPreviewAction|loadAppointmentPreviewDetail/);
  });
  it("DayColumn does not prefetch detail for the appointments it renders", () => {
    expect(DAYCOL).not.toMatch(/loadAppointmentPreviewAction/);
  });
  it("the load is triggered by an open drawer, keyed on the clicked appointment", () => {
    // Both properties are unchanged: the lazy load lives in an effect and is
    // keyed on the clicked appointment. The character window is wider only
    // because that effect now also publishes the live open-appointment id
    // before anything can read it.
    expect(PREVIEW).toMatch(/useEffect\(\(\) => \{[\s\S]{0,900}load\(appointmentId\)/);
    expect(PREVIEW).toMatch(/\}, \[appointmentId, load\]\)/);
  });
});

describe("the action boundary re-derives the caller and trusts only an id", () => {
  it("resolves practitioner + studio server-side and fails closed", () => {
    expect(ACTION).toMatch(/getCurrentPractitionerWithStudio\(\)/);
    expect(ACTION).toMatch(/catch \{[\s\S]{0,200}return \{ ok: false/);
  });
  it("takes an appointment id and nothing else from the browser", () => {
    expect(ACTION).toMatch(/loadAppointmentPreviewAction\(\s*appointmentId: string,?\s*\)/);
    expect(ACTION).not.toMatch(/studioId\s*[,:]\s*(input|args|params)/);
  });
  it("passes the SERVER-derived studio id to the loader", () => {
    expect(ACTION).toMatch(/studioId,/);
    expect(ACTION).toMatch(/const \{ studio \} = await getCurrentPractitionerWithStudio\(\)/);
  });
  it("does not reach for the service role", () => {
    expect(code("app/(app)/calendar/appointment-preview-actions.ts")).not.toMatch(
      /createAdminClient|admin-server|service_role/,
    );
  });
});

describe("other interactions unchanged", () => {
  it("blocked-time click still opens the block edit drawer in-place", () => {
    expect(DAYCOL).toMatch(/onClick=\{\(\) => setEditingBlock\(tb\)\}/);
    expect(DAYCOL).toMatch(/<TimedBlockEditDrawer/);
  });
  it("empty-slot click still opens QuickBookDrawer (exact-time booking)", () => {
    expect(DAYCOL).toMatch(/<QuickBookDrawer/);
    expect(DAYCOL).toMatch(/openDraftAtY/);
  });
  it("the mobile #380 day view still navigates via its appointment Link (unchanged)", () => {
    expect(MOBILE).toMatch(/href=\{`\/calendar\/\$\{a\.id\}\$\{returnTo\}`\}/);
    expect(MOBILE).not.toMatch(/AppointmentPreviewDrawer/);
  });
});
