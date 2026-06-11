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

  it("week starts Monday (2026-06-11 is a Thursday)", () => {
    expect(resolvePeriodRange("2026-06-11", "week")).toEqual({
      startLocal: "2026-06-08",
      endLocalExclusive: "2026-06-15",
      label: "this week",
    });
  });

  it("a Monday starts its own week; Sunday belongs to the prior Monday", () => {
    expect(resolvePeriodRange("2026-06-08", "week").startLocal).toBe(
      "2026-06-08",
    );
    expect(resolvePeriodRange("2026-06-14", "week").startLocal).toBe(
      "2026-06-08",
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
      { name: "Chin", probeLabel: "F3", probeLotNumber: "460941", minutesPerformed: 15 },
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
    });
  });

  it("missing lot, aftercare, or demographics flag the record", () => {
    const m = summarizeProcedureCompleteness([
      record({
        areas: [
          { name: "Chin", probeLabel: null, probeLotNumber: null, minutesPerformed: null },
          { name: "Lip", probeLabel: null, probeLotNumber: "1", minutesPerformed: null },
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

  it("payments card keeps the test-mode posture explicit", () => {
    expect(SNAPSHOT).toMatch(/label="Live payments" value="Off"/);
    expect(SNAPSHOT).toMatch(/label="Test payments" value="Available"/);
    expect(SNAPSHOT).toMatch(/Test mode only/);
    expect(SNAPSHOT).toMatch(/Test payments prepared/);
    expect(SNAPSHOT).toMatch(/Test payments charged/);
    expect(SNAPSHOT).toMatch(/Test refunds/);
  });
});

describe("action metrics + Today section", () => {
  it("action cards render and link into Record Keeping procedures", () => {
    expect(SNAPSHOT).toMatch(/Incomplete procedure records/);
    expect(SNAPSHOT).toMatch(/Missing probe lot numbers/);
    expect(SNAPSHOT).toMatch(/Aftercare not marked/);
    expect(
      SNAPSHOT.match(/href="\/records\?section=procedures"/g)?.length,
    ).toBe(3);
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
  it("metrics are read-only over existing tables; test payments clearly scoped", () => {
    expect(METRICS).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(METRICS).toMatch(/stripe_livemode=false by DB CHECK/);
    expect(METRICS).not.toMatch(/paymentIntents|stripeClient|getStripe/);
  });
});
