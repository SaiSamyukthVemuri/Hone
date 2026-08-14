import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolvePeriodRange,
  summarizeAppointments,
  summarizeProcedureCompleteness,
} from "@/lib/dashboard/practice-metrics";
import type { ClientProcedureRecord } from "@/lib/record-keeping/queries";

// PR #208: Practice Dashboard V1. Read-only metrics over existing
// tables; service VALUE wording (never revenue) while live payments
// are disabled; Hone-specific action cards; Today section preserved.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PAGE = read("app/(app)/dashboard/page.tsx");
const SNAPSHOT = read("app/(app)/dashboard/practice-snapshot.tsx");
const METRICS = read("lib/dashboard/practice-metrics.ts");
const LAYOUT = read("app/(app)/layout.tsx");

// ---------------------------------------------------------------------------
// Period ranges (pure)
// ---------------------------------------------------------------------------

describe("resolvePeriodRange", () => {
  it("today is a single local day", () => {
    expect(resolvePeriodRange("2026-06-11", "today")).toEqual({
      startLocal: "2026-06-11",
      endLocalExclusive: "2026-06-12",
      label: "today",
    });
  });

  // Dashboard V2 Part 1: the reporting week moved from a Monday anchor to the
  // calendar's SUNDAY anchor, so these two cases invert. 2026-06-11 is a
  // Thursday; its week now runs Sun 2026-06-07 .. Sat 2026-06-13.
  // Full boundary coverage, Sunday/Monday/Saturday, rollover, month, year,
  // leap day, DST, and a 365-day agreement check against the calendar helper,
  // lives in tests/lib/dashboard/practice-metrics-week.test.ts.
  it("week starts Sunday (2026-06-11 is a Thursday)", () => {
    expect(resolvePeriodRange("2026-06-11", "week")).toEqual({
      startLocal: "2026-06-07",
      endLocalExclusive: "2026-06-14",
      label: "this week",
    });
  });

  it("a Sunday starts its own week; the following Saturday belongs to it", () => {
    // 2026-06-07 is a Sunday, 2026-06-13 the Saturday that closes its week.
    expect(resolvePeriodRange("2026-06-07", "week").startLocal).toBe(
      "2026-06-07",
    );
    expect(resolvePeriodRange("2026-06-13", "week").startLocal).toBe(
      "2026-06-07",
    );
    // ...and the NEXT Sunday rolls over rather than extending it.
    expect(resolvePeriodRange("2026-06-14", "week").startLocal).toBe(
      "2026-06-14",
    );
  });

  it("month spans the calendar month, including December rollover", () => {
    expect(resolvePeriodRange("2026-06-11", "month")).toEqual({
      startLocal: "2026-06-01",
      endLocalExclusive: "2026-07-01",
      label: "this month",
    });
    expect(resolvePeriodRange("2026-12-15", "month").endLocalExclusive).toBe(
      "2027-01-01",
    );
  });
});

// ---------------------------------------------------------------------------
// Appointment metrics (pure)
// ---------------------------------------------------------------------------

const NOW = "2026-06-11T12:00:00.000Z";

describe("summarizeAppointments", () => {
  it("counts statuses and values from service prices", () => {
    const m = summarizeAppointments(
      [
        { status: "completed", starts_at: "2026-06-09T10:00:00Z", cancellation_reason: null, price_cents: 6000 },
        { status: "completed", starts_at: "2026-06-10T10:00:00Z", cancellation_reason: null, price_cents: 12000 },
        { status: "confirmed", starts_at: "2026-06-12T10:00:00Z", cancellation_reason: null, price_cents: 6000 },
        { status: "confirmed", starts_at: "2026-06-10T09:00:00Z", cancellation_reason: null, price_cents: 6000 },
        { status: "cancelled", starts_at: "2026-06-11T10:00:00Z", cancellation_reason: "late_cancellation", price_cents: 6000 },
        { status: "cancelled", starts_at: "2026-06-11T11:00:00Z", cancellation_reason: "client_request", price_cents: 6000 },
        { status: "no_show", starts_at: "2026-06-09T15:00:00Z", cancellation_reason: null, price_cents: 6000 },
      ],
      NOW,
    );
    expect(m.total).toBe(7);
    expect(m.completed).toBe(2);
    expect(m.upcoming).toBe(1); // only the future confirmed one
    expect(m.cancelled).toBe(2);
    expect(m.lateCancellations).toBe(1);
    expect(m.noShows).toBe(1);
    // Booked = completed + confirmed (active bookings); cancelled and
    // no-shows contribute nothing.
    expect(m.bookedValueCents).toBe(6000 + 12000 + 6000 + 6000);
    expect(m.completedValueCents).toBe(18000);
  });

  it("missing service price contributes nothing and never crashes", () => {
    const m = summarizeAppointments(
      [
        { status: "completed", starts_at: "2026-06-09T10:00:00Z", cancellation_reason: null, price_cents: null },
      ],
      NOW,
    );
    expect(m.completed).toBe(1);
    expect(m.bookedValueCents).toBe(0);
    expect(m.completedValueCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Procedure completeness (pure)
// ---------------------------------------------------------------------------

function record(over: Partial<ClientProcedureRecord>): ClientProcedureRecord {
  return {
    sessionId: "s",
    clientId: "c",
    startedAt: "2026-06-10T10:00:00Z",
    modality: "electrolysis",
    clientName: "Chloe Testing",
    dateOfBirth: "1990-01-01",
    phone: "555",
    email: "c@example.com",
    address: "1 Main St",
    operatorName: "Chloe Vemuri LE",
    aftercareExplainedAt: "2026-06-10T11:00:00Z",
    areas: [
      { name: "Chin", probeLabel: "F3", probeLotNumber: "460941", minutesPerformed: 15, machineFrequency: null },
    ],
    ...over,
  };
}

describe("summarizeProcedureCompleteness", () => {
  it("a fully complete record counts nowhere", () => {
    const m = summarizeProcedureCompleteness([record({})]);
    expect(m).toEqual({
      reviewedSessions: 1,
      incompleteRecords: 0,
      missingProbeLots: 0,
      aftercareNotMarked: 0,
      // Part 2B: the non-itemized half of `incompleteRecords`.
      recordsMissingDetails: 0,
    });
  });

  it("missing lot, aftercare, or demographics flag the record", () => {
    const m = summarizeProcedureCompleteness([
      record({
        areas: [
          { name: "Chin", probeLabel: null, probeLotNumber: null, minutesPerformed: null, machineFrequency: null },
          { name: "Lip", probeLabel: null, probeLotNumber: "1", minutesPerformed: null, machineFrequency: null },
        ],
      }),
      record({ aftercareExplainedAt: null }),
      record({ dateOfBirth: null }),
      record({}),
    ]);
    expect(m.reviewedSessions).toBe(4);
    expect(m.incompleteRecords).toBe(3);
    expect(m.missingProbeLots).toBe(1);
    expect(m.aftercareNotMarked).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Page / nav / wording pins
// ---------------------------------------------------------------------------

describe("dashboard placement", () => {
  it("top-level Dashboard nav exists; Record Keeping stays separate", () => {
    expect(LAYOUT).toMatch(/>\s*Dashboard\s*</);
    expect(LAYOUT).toMatch(/href="\/dashboard"/);
    expect(LAYOUT).toMatch(/Record Keeping/);
    // Not under Settings or Record Keeping.
    expect(() => read("app/(app)/settings/dashboard/page.tsx")).toThrow();
    expect(() => read("app/(app)/records/dashboard/page.tsx")).toThrow();
  });

  it("the page is protected (server component resolving studio) and is the login landing", () => {
    expect(PAGE).toMatch(/getCurrentPractitionerWithStudio/);
    expect(PAGE).not.toMatch(/^"use client"/);
  });

  it("period filters render with This week as the default", () => {
    expect(SNAPSHOT).toMatch(/label: "Today"/);
    expect(SNAPSHOT).toMatch(/label: "This week"/);
    expect(SNAPSHOT).toMatch(/label: "This month"/);
    expect(PAGE).toMatch(/:\s*"week";/);
  });
});

describe("service value wording (live payments disabled)", () => {
  it("uses service value labels with the required helper copy", () => {
    expect(SNAPSHOT).toMatch(/Booked service value/);
    expect(SNAPSHOT).toMatch(/Completed service value/);
    expect(SNAPSHOT).toMatch(
      /Values are based on booked service prices, not collected live\s*\n?\s*payments\./,
    );
  });

  it("never says revenue/sales/income/you made (outside the allowed status lines)", () => {
    expect(SNAPSHOT).not.toMatch(/You made/i);
    expect(SNAPSHOT).not.toMatch(/\bSales\b/i);
    expect(SNAPSHOT).not.toMatch(/\bIncome\b/i);
    expect(SNAPSHOT).not.toMatch(/Net revenue/i);
    // "Collected revenue" appears ONLY as the not-enabled status line.
    // Two rendered lines + one design-note comment.
    const revenueUses = SNAPSHOT.match(/revenue/gi) ?? [];
    expect(revenueUses.length).toBe(3);
    expect(SNAPSHOT).toMatch(/Collected revenue.*Not enabled yet/s);
    expect(SNAPSHOT).toMatch(
      /Collected revenue will appear after live payments are enabled\./,
    );
  });

  it("payments card: the Live payments state is mode-aware; test metrics stay explicit", () => {
    // The #323-promised copy fast-follow: every payment label is now
    // mode-aware. Test-mode copy stays in source for the test branch.
    expect(SNAPSHOT).toMatch(/label="Live payments" value=\{livemode \? "On" : "Off"\}/);
    expect(SNAPSHOT).toMatch(/label="Test payments" value="Available"/);
    expect(SNAPSHOT).toMatch(/Test mode only/);
    // DASH-TRUTH-03: the prepared row is gone, preparing a payment is
    // plumbing, not a practice KPI. The outcome rows stay.
    expect(SNAPSHOT).not.toMatch(/Test payments prepared/);
    expect(SNAPSHOT).toMatch(/Test payments charged/);
    expect(SNAPSHOT).toMatch(/Test refunds/);
  });

  it("payments card: NO test-mode copy can render in live mode (labels flip with the mode)", () => {
    // The heading and all three metric labels are ternaries on livemode,
    // live counts are never displayed under "Test mode only" copy.
    expect(SNAPSHOT).toMatch(/\{livemode \? "Live payments" : "Test mode only"\}/);
    // DASH-TRUTH-03: no prepared label in either mode.
    expect(SNAPSHOT).not.toMatch(/Payments prepared/);
    expect(SNAPSHOT).toMatch(/livemode \? "Payments charged" : "Test payments charged"/);
    expect(SNAPSHOT).toMatch(/livemode \? "Refunds" : "Test refunds"/);
    // The test-only status/revenue claims are hidden in live.
    expect(SNAPSHOT).toMatch(/\{!livemode && <Stat label="Test payments" value="Available" \/>\}/);
    expect(SNAPSHOT).toMatch(/\{!livemode && \(\s*\n?\s*<Stat label="Collected revenue" value="Not enabled yet" \/>/);
    expect(SNAPSHOT).toMatch(/Collected revenue will appear after live payments are enabled\./);
  });
});

describe("action metrics + Today section", () => {
  it("the three action COUNT TILES are gone; their work is itemized instead", () => {
    // Dashboard V2 Part 2B. The tiles asked for the same unresolved work the
    // missing-records assistant already itemizes per client, over a different
    // window and in a different unit (a count of PROCEDURE RECORDS vs a row per
    // SESSION). Aftercare and probe-lot are now per-client To-do rows; the
    // remainder, the part no per-item row covers, became ONE roll-up row.
    const MODEL = read("lib/dashboard/todo-model.ts");
    expect(SNAPSHOT).not.toMatch(/Incomplete procedure records/);
    expect(SNAPSHOT).not.toMatch(/Missing probe lot numbers/);
    expect(SNAPSHOT).not.toMatch(/href="\/records\?section=procedures"/);
    // The capability the tiles uniquely carried is preserved, once.
    expect(MODEL).toMatch(/records_details:studio/);
    expect(MODEL).toMatch(/missing client or operator details/);
    expect(MODEL).toMatch(/href: "\/records\?section=procedures"/);
    expect(
      MODEL.match(/records_details:studio/g)?.length,
      "the roll-up must be emitted exactly once",
    ).toBe(1);
  });

  it("recordsMissingDetails excludes the two itemized gaps", () => {
    // Aftercare-only and probe-lot-only records are counted by
    // `incompleteRecords` but MUST NOT be counted by the roll-up, or the
    // dashboard asks for the same work twice.
    const aftercareOnly = summarizeProcedureCompleteness([
      record({ aftercareExplainedAt: null }),
    ]);
    expect(aftercareOnly.incompleteRecords).toBe(1);
    expect(aftercareOnly.aftercareNotMarked).toBe(1);
    expect(aftercareOnly.recordsMissingDetails).toBe(0);

    const lotOnly = summarizeProcedureCompleteness([
      record({
        areas: [
          { name: "Chin", probeLabel: "F3", probeLotNumber: null, minutesPerformed: 15, machineFrequency: null },
        ],
      }),
    ]);
    expect(lotOnly.incompleteRecords).toBe(1);
    expect(lotOnly.missingProbeLots).toBe(1);
    expect(lotOnly.recordsMissingDetails).toBe(0);

    // ...but a demographic/operator gap IS the roll-up's job.
    const details = summarizeProcedureCompleteness([record({ dateOfBirth: null })]);
    expect(details.incompleteRecords).toBe(1);
    expect(details.recordsMissingDetails).toBe(1);
  });

  it("clients-with-watch-notes is explicitly deferred (not silently dropped)", () => {
    // Deferred per spec allowance; documented in docs/13.
    const DOCS = read("docs/13_BACKLOG_AND_DECISIONS.md");
    expect(DOCS).toMatch(/[Cc]lients (with watch notes|needing attention).*defer/s);
  });

  it("Today roster remains with its empty state", () => {
    expect(PAGE).toMatch(/>Today<\/h2>/);
    expect(PAGE).toMatch(/No appointments today\./);
  });
});

describe("data behavior safety", () => {
  it("metrics are read-only over existing tables; payment counts are CURRENT-mode scoped", () => {
    expect(METRICS).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    // Live mode counts only live attempts; test mode only test attempts.
    // (The pre-0101 "stripe_livemode=false by DB CHECK" claim is defunct,
    // the query must scope by the deployment mode, never a literal.)
    const block = METRICS.slice(METRICS.indexOf('.from("payment_charge_attempts")'));
    expect(block.slice(0, 400)).toMatch(/\.eq\("stripe_livemode", inferStripeLivemode\(\)\)/);
    expect(METRICS).not.toMatch(/stripe_livemode=false by DB CHECK/);
    expect(METRICS).not.toMatch(/\.eq\("stripe_livemode", (true|false)\)/);
    expect(METRICS).not.toMatch(/paymentIntents|stripeClient|getStripe/);
  });
});
