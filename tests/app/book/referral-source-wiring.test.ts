import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #163. Source-grep tests that pin the wiring of the new
// referral_source field across every surface it touches: the
// migration, the Appointment TS type, the public booking form, the
// public booking action, the practitioner notification email, the
// appointment detail page. A future refactor that drops one of the
// surfaces would either silently leak the field out of the practitioner
// view (no more attribution) or silently drop the value at insert (no
// more capture). Both are caught here.

const REPO_ROOT = path.resolve(__dirname, "../../..");

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

// ---------------------------------------------------------------------------
// Migration 0069 textual invariants.
// ---------------------------------------------------------------------------

describe("migration 0069 adds appointments.referral_source as nullable text", () => {
  const SQL = read("supabase/migrations/0069_appointment_referral_source.sql");

  it("adds a nullable text column on public.appointments", () => {
    expect(SQL).toMatch(
      /alter table public\.appointments[\s\S]*add column if not exists referral_source text/i,
    );
  });

  it("does NOT add a CHECK constraint on referral_source", () => {
    // The allowed value set is enforced at the action layer (see
    // lib/booking/referral-source.ts:parseReferralSource), not at
    // the DB layer. Pinning the option set at the DB would force a
    // migration every time the list grows.
    expect(SQL).not.toMatch(/check\s*\([^)]*referral_source/i);
  });

  it("does NOT run an UPDATE backfill on historical rows", () => {
    // Historical rows legitimately have no answer; null is the
    // honest representation. A backfill that invents values would
    // corrupt the attribution data this column exists to capture.
    expect(SQL).not.toMatch(/update\s+public\.appointments\s+set\s+referral_source/i);
  });

  it("documents the verification SQL the operator should run", () => {
    expect(SQL).toMatch(/information_schema\.columns/);
    expect(SQL).toMatch(/answered/);
    expect(SQL).toMatch(/unanswered/);
  });
});

// ---------------------------------------------------------------------------
// Appointment TS type carries the new field.
// ---------------------------------------------------------------------------

describe("Appointment TS type carries referral_source", () => {
  const DATABASE = read("lib/types/database.ts");

  it("Appointment type declares referral_source: string | null", () => {
    const apptBlock =
      DATABASE.match(/export type Appointment = \{[\s\S]*?\};/)?.[0] ?? "";
    expect(apptBlock).toMatch(/referral_source:\s*string\s*\|\s*null/);
  });
});

// ---------------------------------------------------------------------------
// Public booking form renders the dropdown bound to the shared helper.
// ---------------------------------------------------------------------------

describe("public booking form renders the 'How did you hear about us?' question", () => {
  const FORM = read("app/book/[slug]/PublicBookForm.tsx");

  it("imports REFERRAL_SOURCE_OPTIONS from the shared helper", () => {
    expect(FORM).toMatch(
      /import \{ REFERRAL_SOURCE_OPTIONS \} from "@\/lib\/booking\/referral-source"/,
    );
  });

  it("renders a Field labelled 'How did you hear about us?'", () => {
    expect(FORM).toContain("How did you hear about us?");
  });

  it("renders a <select> bound to the referralSource state", () => {
    expect(FORM).toMatch(
      /<select[\s\S]*?name="referral_source"[\s\S]*?value=\{referralSource\}/,
    );
  });

  it("renders an option for each entry in REFERRAL_SOURCE_OPTIONS", () => {
    expect(FORM).toMatch(
      /REFERRAL_SOURCE_OPTIONS\.map\(\(opt\)[\s\S]*?<option key=\{opt\.value\}[\s\S]*?\{opt\.label\}/,
    );
  });

  it("posts referral_source on the FormData submit payload", () => {
    expect(FORM).toMatch(/fd\.set\("referral_source",\s*referralSource\)/);
  });
});

// ---------------------------------------------------------------------------
// Public booking action validates and persists the field.
// ---------------------------------------------------------------------------

describe("public booking action validates + persists referral_source", () => {
  const ACTIONS = read("app/book/[slug]/actions.ts");

  it("imports parseReferralSource + referralSourceLabel from the shared helper", () => {
    expect(ACTIONS).toMatch(
      /import \{\s*parseReferralSource,\s*referralSourceLabel,\s*\} from "@\/lib\/booking\/referral-source"/,
    );
  });

  it("calls parseReferralSource on the form value and catches the throw", () => {
    expect(ACTIONS).toMatch(/parseReferralSource\(formData\.get\("referral_source"\)\)/);
    // Surrounded by try/catch so a tampered value surfaces the
    // generic visitor-safe banner instead of a stack trace.
    expect(ACTIONS).toMatch(/try \{[\s\S]*?parseReferralSource[\s\S]*?\} catch \{/);
  });

  it("inserts referral_source on the new appointment row", () => {
    expect(ACTIONS).toMatch(/referral_source:\s*referralSource/);
  });

  it("threads referralSourceLabel into the practitioner notification call", () => {
    expect(ACTIONS).toMatch(
      /referralSourceLabel:\s*referralSourceLabel\(referralSource\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// Practitioner notification email gained the new field.
// ---------------------------------------------------------------------------

describe("practitioner notification email renders How they heard about us when set", () => {
  const TEMPLATE = read("lib/email/templates/appointment.ts");

  it("NotifyPractitioner type carries referralSourceLabel: string | null", () => {
    const block =
      TEMPLATE.match(/type NotifyPractitioner = \{[\s\S]*?\};/)?.[0] ?? "";
    expect(block).toMatch(/referralSourceLabel:\s*string\s*\|\s*null/);
  });

  it("html body renders the row only when referralSourceLabel is truthy", () => {
    expect(TEMPLATE).toMatch(
      /\$\{p\.referralSourceLabel \? `[\s\S]*?How they heard about us:[\s\S]*?` : ""\}/,
    );
  });

  it("text body renders the row only when referralSourceLabel is truthy", () => {
    expect(TEMPLATE).toMatch(
      /\$\{p\.referralSourceLabel \? `How they heard about us:[\s\S]*?` : ""\}/,
    );
  });
});

describe("practitioner notification helper threads the new field", () => {
  const SEND = read("lib/email/send-appointment.ts");

  it("sendBookingNotificationToPractitioner accepts + forwards referralSourceLabel", () => {
    // The function spans roughly 40 lines; isolating its body via
    // brace-matching is brittle. Pin the contract textually: the
    // file contains the typed param AND the forward into
    // buildPractitionerNotificationEmail.
    expect(SEND).toMatch(/referralSourceLabel:\s*string\s*\|\s*null/);
    expect(SEND).toMatch(/referralSourceLabel:\s*params\.referralSourceLabel/);
  });
});

describe("practitioner-side booking action passes null (it never asked)", () => {
  const CALENDAR_ACTIONS = read("app/(app)/calendar/actions.ts");

  it("calendar bookAppointmentForClientAction sends referralSourceLabel: null", () => {
    expect(CALENDAR_ACTIONS).toMatch(/referralSourceLabel:\s*null/);
  });
});

// ---------------------------------------------------------------------------
// Calendar appointment detail page renders the row when set, omits when null.
// ---------------------------------------------------------------------------

describe("calendar appointment detail surfaces the practitioner-only row", () => {
  const PAGE = read("app/(app)/calendar/[id]/page.tsx");

  it("imports referralSourceLabel from the shared helper", () => {
    expect(PAGE).toMatch(
      /import \{ referralSourceLabel \} from "@\/lib\/booking\/referral-source"/,
    );
  });

  it("renders a section gated on data.referral_source truthy", () => {
    expect(PAGE).toMatch(
      /\{data\.referral_source && \([\s\S]*?How they heard about us[\s\S]*?\)\}/,
    );
  });

  it("uses the labelled value with a raw-value fallback", () => {
    expect(PAGE).toMatch(
      /referralSourceLabel\(data\.referral_source\)\s*\?\?\s*data\.referral_source/,
    );
  });
});

// ---------------------------------------------------------------------------
// CLIENT-FACING surfaces deliberately do NOT render referral source.
// ---------------------------------------------------------------------------

describe("client-facing emails + portal do NOT expose referral source", () => {
  it("client confirmation email body does not mention 'How they heard about us'", () => {
    const APPT = read("lib/email/templates/appointment.ts");
    // The string appears in the practitioner-notification branch
    // only. The client confirmation builder is buildClientConfirmation
    // Email; assert the substring count is exactly 2 (html + text in
    // the practitioner notification builder only). Both reside in
    // template fragments gated on p.referralSourceLabel.
    const matches = APPT.match(/How they heard about us/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("portal page does not render referral_source", () => {
    const PORTAL = read("app/portal/page.tsx");
    expect(PORTAL).not.toMatch(/referral_source/);
    expect(PORTAL).not.toMatch(/How they heard about us/);
  });

  it("reminder + postcare templates do not render referral_source", () => {
    const REMINDERS = read("lib/email/templates/reminders.ts");
    const POSTCARE = read("lib/email/templates/postcare.ts");
    expect(REMINDERS).not.toMatch(/referral_source|How they heard about us/);
    expect(POSTCARE).not.toMatch(/referral_source|How they heard about us/);
  });
});
