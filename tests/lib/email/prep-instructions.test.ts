import { describe, expect, it } from "vitest";
import {
  buildClientConfirmationEmail,
  buildPractitionerNotificationEmail,
} from "@/lib/email/templates/appointment";
import {
  build24hReminderEmail,
  build2hReminderEmail,
} from "@/lib/email/templates/reminders";

// PR #160. Chloe's smoke-test bug: the confirmation email rendered a
// hardcoded "Please arrive 5 minutes early. Wear comfortable clothing.
// Avoid caffeine before your appointment." paragraph above any
// per-service prep block. Chloe wanted to own that wording and to be
// able to delete it when it did not apply. This file pins the new
// invariants:
//
//   1. No hardcoded prep paragraph in the confirmation email (HTML or
//      text) regardless of whether preCareInstructions is set.
//   2. Per-service preCareInstructions IS rendered when set.
//   3. When preCareInstructions is null, no prep block renders at all
//      (no leftover "Before your appointment" caption, no empty card).
//   4. Reminder templates were already on the editable-only path and
//      stay there.

const TZ = "America/Toronto";
const STARTS_AT = new Date("2026-06-09T15:00:00Z");
const ENDS_AT = new Date("2026-06-09T16:00:00Z");

const HARDCODED_PREP_FRAGMENTS = [
  "Please arrive 5 minutes early",
  "Wear comfortable clothing",
  "Avoid caffeine before your appointment",
];

function baseConfirmation(overrides: Partial<{ preCareInstructions: string | null }> = {}) {
  return {
    clientName: "Sarah Wong",
    studioName: "Willow Electrolysis",
    studioAddress: "123 Bloor St W",
    studioEmail: "willow@example.com",
    practitionerName: "Chloe",
    serviceName: "60-minute electrolysis",
    durationMinutes: 60,
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    timezone: TZ,
    cancellationUrl: "https://example.com/cancel/abc",
    rescheduleUrl: "https://example.com/reschedule/abc",
    intakeUrl: null,
    preCareInstructions: overrides.preCareInstructions ?? null,
    treatmentTimeLine: null,
  };
}

describe("confirmation email no longer carries the hardcoded prep paragraph", () => {
  it("html with empty preCareInstructions does not include the hardcoded fragments", () => {
    const out = buildClientConfirmationEmail(baseConfirmation({ preCareInstructions: null }));
    for (const fragment of HARDCODED_PREP_FRAGMENTS) {
      expect(out.html).not.toContain(fragment);
    }
  });

  it("text with empty preCareInstructions does not include the hardcoded fragments", () => {
    const out = buildClientConfirmationEmail(baseConfirmation({ preCareInstructions: null }));
    for (const fragment of HARDCODED_PREP_FRAGMENTS) {
      expect(out.text).not.toContain(fragment);
    }
  });

  it("html with preCareInstructions set ALSO does not include the hardcoded fragments", () => {
    // Belt and braces: even when Chloe sets her own per-service text,
    // the prior bug duplicated both. The hardcoded fragments must be
    // gone in every render path.
    const out = buildClientConfirmationEmail(
      baseConfirmation({
        preCareInstructions: "Skin should be free of lotion or makeup.",
      }),
    );
    for (const fragment of HARDCODED_PREP_FRAGMENTS) {
      expect(out.html).not.toContain(fragment);
    }
  });

  it("text with preCareInstructions set ALSO does not include the hardcoded fragments", () => {
    const out = buildClientConfirmationEmail(
      baseConfirmation({
        preCareInstructions: "Skin should be free of lotion or makeup.",
      }),
    );
    for (const fragment of HARDCODED_PREP_FRAGMENTS) {
      expect(out.text).not.toContain(fragment);
    }
  });
});

describe("confirmation email renders the per-service preCareInstructions when set", () => {
  it("html contains the editable text in the Before your appointment block", () => {
    const customText = "Shave the treatment area 24 hours in advance.";
    const out = buildClientConfirmationEmail(
      baseConfirmation({ preCareInstructions: customText }),
    );
    expect(out.html).toContain("Before your appointment");
    expect(out.html).toContain(customText);
  });

  it("text body contains the editable text under the Before your appointment heading", () => {
    const customText = "Shave the treatment area 24 hours in advance.";
    const out = buildClientConfirmationEmail(
      baseConfirmation({ preCareInstructions: customText }),
    );
    expect(out.text).toMatch(
      /Before your appointment:\nShave the treatment area 24 hours in advance\./,
    );
  });
});

describe("confirmation email omits the prep block when preCareInstructions is null", () => {
  it("html does not render a Before your appointment heading", () => {
    const out = buildClientConfirmationEmail(
      baseConfirmation({ preCareInstructions: null }),
    );
    expect(out.html).not.toContain("Before your appointment");
  });

  it("text does not render a Before your appointment heading", () => {
    const out = buildClientConfirmationEmail(
      baseConfirmation({ preCareInstructions: null }),
    );
    expect(out.text).not.toContain("Before your appointment");
  });
});

// ---------------------------------------------------------------------------
// Reminder emails were already on the editable-only path BEFORE PR
// #160; pin that so a future refactor that re-introduces a hardcoded
// paragraph in reminders is caught immediately.
// ---------------------------------------------------------------------------

const reminderFixture = (preCareInstructions: string | null) => ({
  clientName: "Sarah Wong",
  studioName: "Willow Electrolysis",
  studioAddress: null,
  practitionerName: "Chloe",
  serviceName: "60-minute electrolysis",
  durationMinutes: 60,
  startsAt: STARTS_AT,
  endsAt: ENDS_AT,
  timezone: TZ,
  cancellationUrl: "https://example.com/cancel/abc",
  rescheduleUrl: null,
  preCareInstructions,
  treatmentTimeLine: null,
});

describe("reminder emails stay on the editable-only path", () => {
  it("24h reminder html with preCareInstructions set contains the editable text only", () => {
    const customText = "Avoid sun exposure on the area for 24h before your visit.";
    const out = build24hReminderEmail(reminderFixture(customText));
    expect(out.html).toContain(customText);
    for (const fragment of HARDCODED_PREP_FRAGMENTS) {
      expect(out.html).not.toContain(fragment);
    }
  });

  it("24h reminder html with null preCareInstructions has no prep block", () => {
    const out = build24hReminderEmail(reminderFixture(null));
    expect(out.html).not.toContain("Before your appointment");
  });

  it("2h reminder text with preCareInstructions set contains only the editable text", () => {
    const customText = "Bring a water bottle.";
    const out = build2hReminderEmail(reminderFixture(customText));
    expect(out.text).toMatch(/Before your appointment:\nBring a water bottle\./);
    for (const fragment of HARDCODED_PREP_FRAGMENTS) {
      expect(out.text).not.toContain(fragment);
    }
  });
});

// ---------------------------------------------------------------------------
// Source-grep: lib/email/templates/appointment.ts no longer carries
// the PREP_INSTRUCTIONS constant. PR #160 deleted it; this is the
// regression guard against a future revert.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";

describe("appointment template source has no PREP_INSTRUCTIONS constant", () => {
  it("the constant is gone from lib/email/templates/appointment.ts", () => {
    const text = readFileSync(
      path.resolve(__dirname, "../../../lib/email/templates/appointment.ts"),
      "utf8",
    );
    // We allow the string in commentary that EXPLAINS the removal;
    // pin the absence of an actual `const PREP_INSTRUCTIONS = "..."`
    // declaration.
    expect(text).not.toMatch(/^const PREP_INSTRUCTIONS\s*=/m);
    // Also no longer rendered via escapeHtml(PREP_INSTRUCTIONS).
    expect(text).not.toMatch(/escapeHtml\(PREP_INSTRUCTIONS\)/);
  });
});

// ---------------------------------------------------------------------------
// Settings UI surface pins the new label + hint so a copy regression
// is caught immediately. Practitioner-facing copy is part of the
// contract Chloe was promised when she asked for this PR.
// ---------------------------------------------------------------------------

describe("Settings -> Services exposes the editable Pre-appointment instructions field", () => {
  it("renders the textarea bound to the service.pre_care_instructions field", () => {
    const text = readFileSync(
      path.resolve(__dirname, "../../../app/(app)/settings/services/page.tsx"),
      "utf8",
    );
    expect(text).toContain('name="pre_care_instructions"');
    expect(text).toContain("Pre-appointment instructions");
  });

  it("hint mentions both the email AND the portal Care instructions surface", () => {
    const text = readFileSync(
      path.resolve(__dirname, "../../../app/(app)/settings/services/page.tsx"),
      "utf8",
    );
    expect(text).toContain("confirmation and reminder emails");
    expect(text).toContain("Care instructions");
  });

  it("the practitioner notification email still renders (sanity check, not changed by PR #160)", () => {
    // Practitioner notification does not carry prep instructions; it
    // is the inbound-booking summary for Chloe. We assert it builds
    // cleanly so a refactor that broke it would be caught here.
    const out = buildPractitionerNotificationEmail({
      practitionerName: "Chloe",
      clientName: "Sarah Wong",
      clientEmail: "sarah@example.com",
      clientPhone: null,
      studioName: "Willow Electrolysis",
      serviceName: "60-minute electrolysis",
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
      timezone: TZ,
      notes: null,
      appointmentUrl: "https://example.com/calendar/abc",
    });
    expect(out.html).toContain("60-minute electrolysis");
  });
});
