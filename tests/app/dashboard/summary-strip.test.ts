import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));

const { SummaryStrip } = await import("@/app/(app)/dashboard/summary-strip");
const { computeTimeInsights, formatInsightHours, insightPeriod } = await import("@/lib/calendar/time-insights");

const ALL = { mode: "all" as const, ids: new Set<string>() };
const day = insightPeriod(new Date("2026-11-02T05:00:00Z"), new Date("2026-11-03T05:00:00Z"));

describe("summary strip (fidelity A)", () => {
  it("renders the three labelled values", () => {
    const out = renderToStaticMarkup(
      createElement(SummaryStrip, { appointmentCount: 4, clientCount: 3, bookedTime: "5 h 30 min", clientsToReview: "7" }),
    );
    expect(out).toContain("Appointments");
    expect(out).toContain("Booked time");
    expect(out).toContain("Clients to review");
    expect(out).toContain('data-testid="summary-appointments-value">4<');
    expect(out).toContain("5 h 30 min");
    expect(out).toContain("3 clients");
    expect(renderToStaticMarkup(createElement(SummaryStrip, { appointmentCount: 0, clientCount: 0, bookedTime: "0 h", clientsToReview: "0" }))).not.toContain("clients<");
  });
  it("booked time is the calendar definition: cancelled excluded, only minutes inside the day", () => {
    const m = computeTimeInsights({
      appointments: [
        { id: "a", status: "scheduled", starts_at: "2026-11-02T15:00:00Z", ends_at: "2026-11-02T16:30:00Z", practitioner_id: null },
        { id: "b", status: "cancelled", starts_at: "2026-11-02T17:00:00Z", ends_at: "2026-11-02T19:00:00Z", practitioner_id: null },
        { id: "c", status: "completed", starts_at: "2026-11-02T20:00:00Z", ends_at: "2026-11-02T21:00:00Z", practitioner_id: null },
      ],
      period: day,
      selection: ALL,
    });
    expect(m).toEqual({ minutes: 150, count: 2 });
    expect(formatInsightHours(m.minutes)).toBe("2 h 30 min");
  });
});

describe("Clients to review comes from the Needs attention model", () => {
  const stack = readFileSync("app/(app)/dashboard/secondary-stack.tsx", "utf8");
  const page = readFileSync("app/(app)/dashboard/page.tsx", "utf8");
  it("one builder serves the panel and the strip, and the strip reads .clients.length", () => {
    expect(stack).toMatch(/async function resolveNeedsAttentionInput\(/);
    expect(stack).toMatch(/needs=\{buildNeedsAttention\(await resolveNeedsAttentionInput\(props\)\)\}/);
    expect(stack).toMatch(/async function resolveClientReviewCount[\s\S]*?buildNeedsAttention\(await resolveNeedsAttentionInput\(props\)\)[\s\S]*?\.clients\.length/);
    expect(page).toMatch(/<ClientsToReview\b/);
  });
  it("a failed read says Unavailable, never 0", async () => {
    const mod = await import("@/app/(app)/dashboard/secondary-stack");
    const { ClientsToReview } = mod;
    const rejected = Promise.reject(new Error("x"));
    rejected.catch(() => undefined);
    const wrapper = ClientsToReview({
      attentionSources: rejected as never,
      staffManaged: Promise.resolve(false),
      procedureActions: rejected as never,
      upcomingVisitClients: rejected as never,
      clientsNeedingAttention: rejected as never,
      followUpAssistant: rejected as never,
      expiringSupplies: rejected as never,
      isOwner: true,
      todayLocal: "2026-11-02",
    });
    // the wrapper is a Suspense around the async value; resolve the async child directly
    const child = (wrapper.props as { children: { type: (p: unknown) => Promise<unknown>; props: unknown } }).children;
    const out = renderToStaticMarkup((await child.type(child.props)) as never);
    expect(out).toContain("Unavailable");
    expect(out).not.toMatch(/>0</);
  });
});

describe("an unavailable intake-review check is never a definite client count (Codex P2)", () => {
  const resolved = (intakes: unknown) => ({
    attentionSources: Promise.resolve([intakes, 1, null, []]) as never,
    staffManaged: Promise.resolve(false),
    procedureActions: Promise.resolve({ detailGaps: [], recordsMissingDetails: 0, reviewedSessions: 0 }) as never,
    upcomingVisitClients: Promise.resolve(new Set<string>()) as never,
    clientsNeedingAttention: Promise.resolve({ clients: [], totalClients: 0 }) as never,
    followUpAssistant: Promise.resolve({ items: [], totalFound: 0 }) as never,
    expiringSupplies: Promise.resolve([]) as never,
    isOwner: false,
    todayLocal: "2026-11-02",
  });
  const render = async (el: { props: unknown }) => {
    const child = (el.props as { children: { type: (p: unknown) => Promise<unknown>; props: unknown } }).children;
    return renderToStaticMarkup((await child.type(child.props)) as never);
  };
  it("the strip says Unavailable when the intake check could not run, never 0", async () => {
    const { ClientsToReview } = await import("@/app/(app)/dashboard/secondary-stack");
    const out = await render(ClientsToReview(resolved("unavailable")) as never);
    expect(out).toContain("Unavailable");
    expect(out).not.toMatch(/>0</);
  });
  it("the header pill says Unavailable too", async () => {
    const { NeedsAttentionCountPill } = await import("@/app/(app)/dashboard/secondary-stack");
    const out = await render(NeedsAttentionCountPill(resolved("unavailable")) as never);
    expect(out).toContain("Unavailable");
    expect(out).not.toContain("0 clients");
  });
  it("with the check available, the same inputs give a real count (0 is honest then)", async () => {
    const { ClientsToReview } = await import("@/app/(app)/dashboard/secondary-stack");
    const out = await render(ClientsToReview(resolved([])) as never);
    expect(out).not.toContain("Unavailable");
    expect(out).toMatch(/>0</);
  });
});

describe("booked time counts a midnight-crossing visit (Codex P2)", () => {
  const page = readFileSync("app/(app)/dashboard/page.tsx", "utf8");
  const day = { startUtc: new Date("2026-11-02T00:00:00Z"), endUtc: new Date("2026-11-03T00:00:00Z") };
  const appt = (id: string, status: string, starts_at: string, ends_at: string) => ({ id, status, starts_at, ends_at, practitioner_id: null });
  it("a 23:30-00:30 visit from the day before adds its 30 minutes inside the day; it is clipped, not counted whole", () => {
    const inDay = appt("a", "confirmed", "2026-11-02T10:00:00Z", "2026-11-02T11:00:00Z");
    const crosser = appt("b", "confirmed", "2026-11-01T23:30:00Z", "2026-11-02T00:30:00Z");
    const run = (rows: ReturnType<typeof appt>[]) =>
      computeTimeInsights({ appointments: rows, period: insightPeriod(day.startUtc, day.endUtc), selection: { mode: "all", ids: new Set() } }).minutes;
    expect(run([inDay])).toBe(60);
    expect(run([inDay, crosser])).toBe(90);
  });
  it("the dashboard reads the boundary rows through the calendar's own function, for booked time only", () => {
    expect(page).toMatch(/getBoundaryCrossingAppointments\(studio\.id, startUtc\)/);
    expect(page).toMatch(/\[\.\.\.visibleAppointments, \.\.\.boundaryCrossers\]\.map/);
    // the roster, the appointment count and the client count never see them
    expect(page).toMatch(/appointmentCount=\{visibleAppointments\.length\}/);
    expect(page).toMatch(/new Set\(visibleAppointments\.map\(\(a\) => a\.client_id\)\)/);
    expect((page.match(/boundaryCrossers/g) ?? []).length).toBe(3);
  });
  it("a failed boundary read says Unavailable, never an undercount", () => {
    expect(page).toMatch(/boundaryCrossers === null\s*\?\s*"Unavailable"/);
    expect(page).toMatch(/getBoundaryCrossingAppointments\(studio\.id, startUtc\)\.catch\(\s*\(\) => null/);
  });
});

describe("panel headers share one top edge (fidelity B)", () => {
  const page = readFileSync("app/(app)/dashboard/page.tsx", "utf8");
  const stack = readFileSync("app/(app)/dashboard/secondary-stack.tsx", "utf8");
  it("both column header rows have the same minimum height, and Needs attention carries a client-count pill from the same model", () => {
    expect((page.match(/<div className="flex min-h-\[44px\]/g) ?? []).length).toBe(2);
    expect(page).toMatch(/<NeedsAttentionCountPill/);
    expect(stack).toMatch(/clients\.length[\s\S]{0,400}needs-attention-count-pill|needs-attention-count-pill[\s\S]{0,400}clients/);
    expect(stack).toMatch(/async function ClientCountPillValue[\s\S]*?resolveClientReviewCount\(props\)/);
    expect(stack).toMatch(/async function resolveClientReviewCount[\s\S]*?buildNeedsAttention\(await resolveNeedsAttentionInput\(props\)\)[\s\S]*?"intake review"[\s\S]*?\.clients\.length/);
  });
});

describe("Practice snapshot is one integrated card (fidelity E)", () => {
  const snap = readFileSync("app/(app)/dashboard/practice-snapshot.tsx", "utf8");
  const stack = readFileSync("app/(app)/dashboard/secondary-stack.tsx", "utf8");
  it("header with the segmented period control top-right, three columns, capacity row inside", () => {
    expect(snap).toMatch(/justify-between[\s\S]{0,200}<h2 className="text-lg font-medium">Practice snapshot<\/h2>[\s\S]{0,200}role="group"/);
    expect(snap).toMatch(/lg:grid-cols-3/);
    expect(snap).toMatch(/\{children\}/);
    expect(stack).toMatch(/<PracticeSnapshot[\s\S]{0,400}\{capacityLink\}[\s\S]{0,40}<\/PracticeSnapshot>/);
  });
  it("stays owner-only and keeps the existing metric definitions (no new read or card)", () => {
    expect(stack).toMatch(/\{isOwner && practiceMetrics && \(\s*<PracticeSnapshot/);
    expect(stack).toMatch(/\{isOwner && !practiceMetrics && capacityLink\}/);
  });
});

describe("Birthdays: compact block top-right on desktop (fidelity G)", () => {
  const page = readFileSync("app/(app)/dashboard/page.tsx", "utf8");
  const stack = readFileSync("app/(app)/dashboard/secondary-stack.tsx", "utf8");
  it("the greeting and Birthdays share the top row of ONE grid; Birthdays is the last grid child so a phone shows it below the operational work", () => {
    expect(page).toMatch(/lg:col-start-1 lg:row-start-1/);
    expect(stack).toMatch(/lg:col-start-2 lg:row-start-1/);
    const grid = page.indexOf("lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]");
    expect(grid).toBeGreaterThan(-1);
    const greeting = page.indexOf("<DashboardGreeting");
    const appts = page.indexOf('aria-label="Appointments"');
    const needs = page.indexOf('id="needs-attention-heading"');
    const birthdays = page.indexOf("<BirthdaysTopRight");
    expect(grid).toBeLessThan(greeting);
    expect(greeting).toBeLessThan(appts);
    expect(appts).toBeLessThan(needs);
    expect(needs).toBeLessThan(birthdays);
  });
  it("is no longer rendered in the secondary stack, has its own boundary, and drops nobody (rest sit in a details)", () => {
    const stackBody = stack.slice(stack.indexOf("export async function SecondaryStack"));
    expect(stackBody).not.toContain("<BirthdaysThisMonth");
    expect(stack).toMatch(/<Suspense fallback=\{null\}>\s*<BirthdaysFromBundle/);
    expect(stack).toMatch(/<details>[\s\S]*?more this month/);
    expect(stack).toMatch(/\.\.\.birthdays\.filter\(\(b\) => b\.day === todayDay\)/);
  });
  it("onboarding still precedes Today and spans both columns", () => {
    expect(page).toMatch(/lg:col-span-2[\s\S]{0,80}<OnboardingSurface/);
  });
});

describe("compact appointment rows (fidelity C)", () => {
  const page = readFileSync("app/(app)/dashboard/page.tsx", "utf8");
  const row = page.slice(page.indexOf("function AppointmentRow("), page.indexOf("function AppointmentStatusPill("));
  const link = row.slice(row.indexOf("<PendingContainerLink"), row.indexOf("</PendingContainerLink>"));
  const details = row.slice(row.indexOf('<details data-testid="today-row-details"'), row.indexOf("</details>"));
  it("the collapsed row keeps time+end, name, service, practitioner, status, pinned note and allergy flag", () => {
    for (const marker of ["today-row-end-time", "clientDisplayName", "serviceName", "performerName", "AppointmentStatusPill", "Allergies", "Pinned"]) {
      expect(link).toContain(marker);
    }
  });
  it("Insurance D-1: the closed row also shows the caution line (full, wrapped) and the intake pill; a plan note is a cue", () => {
    expect(link).toContain("<IntakePill");
    expect(details).not.toContain("<IntakePill");
    expect(link).toMatch(/data-testid="today-row-caution"[\s\S]{0,200}whitespace-pre-wrap break-words/);
    expect(link).toContain("Caution: {workflow.caution}");
    expect(details).not.toContain("Caution: {workflow.caution}");
    expect(row).toMatch(/data-testid="today-row-plan-cue"[\s\S]{0,160}Plan note on record/);
    // the plan note itself, last treatment, setup, chips, previous-treatment strip stay inside
    for (const m of ["Remember: {workflow.remember}", "Latest setup:", "missing-record-chip", "<DashboardTreatmentMemory"]) expect(details).toContain(m);
  });
  it("Insurance E-1: a failed Before-Today read says so ON the compact row, never as a silently absent caution", () => {
    expect(link).toMatch(/\(workflow \? workflow\.unavailable : prepSummary\.unavailable\) && \(/);
    expect(link).toMatch(/data-testid="today-row-unavailable"[\s\S]{0,160}\{CLINICAL_UNAVAILABLE_HEADLINE\}/);
    // the marker sits before the caution line and is not gated on history or caution
    expect(link.indexOf("today-row-unavailable")).toBeLessThan(link.indexOf("today-row-caution"));
    // and it is not the same node as the details' own line
    expect(details).toContain("today-before-today-unavailable");
    expect(details).not.toContain("today-row-unavailable");
    // the caution line itself still refuses to render off a failed read
    expect(link).toMatch(/workflow && !workflow\.unavailable && workflow\.hasHistory && workflow\.caution/);
  });
  it("the pinned note TEXT is visible and wrapped in the collapsed row, never truncated or inside details", () => {
    expect(link).toMatch(/whitespace-pre-wrap break-words[\s\S]{0,120}\{note\.text\}/);
    expect(details).not.toContain("note.text");
  });
  it("everything else is MOVED into the details, not deleted", () => {
    for (const marker of ["Before today", "Latest setup:", "<DashboardTreatmentMemory", "today-consultation-notes", "today-review-intake", "<TodayPortalLinkButton", "dashboard-prep-remember"]) {
      expect(details, marker).toContain(marker);
      expect(link, marker).not.toContain(marker);
    }
  });
  it("the details are a sibling of the row-body link (nothing interactive inside the anchor) and closed by default", () => {
    expect(row.indexOf("</PendingContainerLink>")).toBeLessThan(row.indexOf("<details"));
    expect(row).not.toMatch(/<details[^>]*\bopen\b/);
    expect(link).not.toMatch(/<details|<summary/);
  });
  it("the card-on-file pill stays owner-only, and non-owners get no card read (#1309)", () => {
    expect(row).toMatch(/\{isOwner && <CardOnFilePill status=\{cardOnFile\} \/>\}/);
  });
});

describe("lower row: Charting and the booking card, moved not duplicated (fidelity F)", () => {
  const stack = readFileSync("app/(app)/dashboard/secondary-stack.tsx", "utf8");
  const snap = readFileSync("app/(app)/dashboard/practice-snapshot.tsx", "utf8");
  const row = stack.slice(stack.indexOf('data-testid="dashboard-lower-row"'));
  it("one lower row holds the charting card (owner: Charted within 24h; practitioner: their own figure) and the booking cards", () => {
    expect(row).toMatch(/<PersonalChartingCard/);
    expect(row).toMatch(/<ChartedWithin24hCard metrics=\{practiceMetrics\}/);
    expect(row).toMatch(/<SetupStateNotice state=\{setupCard\}/);
    expect(row).toMatch(/<BookingSetupCard readiness=\{readiness\}/);
  });
  it("each appears exactly once on the page (no duplicate)", () => {
    for (const marker of ["<PersonalChartingCard", "<ChartedWithin24hCard", "<SetupStateNotice", "<BookingSetupCard"]) {
      expect((stack.match(new RegExp(marker, "g")) ?? []).length, marker).toBe(1);
    }
    expect(snap).not.toMatch(/<Card title="Charted within 24h">[\s\S]*<Card title="Charted within 24h">/);
    // the snapshot grid no longer renders it; only the exported card does
    expect((snap.match(/title="Charted within 24h"/g) ?? []).length).toBe(1);
    expect(snap.indexOf('title="Charted within 24h"')).toBeGreaterThan(snap.indexOf("export function ChartedWithin24hCard"));
  });
  it("keeps the truthful intentional-off wording and the separate incomplete-setup checklist", () => {
    const notice = readFileSync("app/(app)/dashboard/setup-state-notice.tsx", "utf8");
    expect(notice).toContain("That is your setting, not unfinished setup");
    expect(row).toMatch(/readiness\.status !== "ready" &&\s*setupCard\.kind !== "paused_by_owner"/);
  });
  it("role gates unchanged: practitioners' charting card only for non-owners, studio-wide card only for owners", () => {
    expect(row).toMatch(/\{!isOwner && personalCharting !== null && \(/);
    expect(row).toMatch(/\{isOwner && practiceMetrics && <ChartedWithin24hCard/);
  });
});
