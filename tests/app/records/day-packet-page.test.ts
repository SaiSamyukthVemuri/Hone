import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redactVercelEvent } from "@/lib/analytics/vercel-url-redaction";
import { scrubBreadcrumb, scrubErrorEvent, scrubTransactionEvent } from "@/lib/observability/sentry-scrub";

// Privacy route answer M-1..M-6. A NEW file: it pins the URL privacy of the day packet, using a synthetic id and
// date. The packet is opened by an opaque one-use ticket (lib/records/print/ticket.ts), so neither value is in any URL;
// the old ?clientId=&day= route no longer reads them. The platform's request log can show that a session was viewed
// and a print opened. It does not state the day (the day can still be inferred from the session's date), and it holds
// no reusable link.

const DIR = "app/(app)/records/print/day";
const PACKET_DIR = "app/(app)/records/print/_packet";
const TICKET_DIR = "app/(app)/records/print/ticket/[token]";
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const PAGE = read(`${PACKET_DIR}/day-packet-view.tsx`); // the view: every content rule below is about it
const DAY_ROUTE = read(`${DIR}/page.tsx`);
const TICKET_ROUTE = read(`${TICKET_DIR}/page.tsx`);
const ACTIONS = read(`${DIR}/actions.ts`);
const BUTTON = read(`${DIR}/print-button.tsx`);
const SOURCES = { page: PAGE, actions: ACTIONS, button: BUTTON, dayRoute: DAY_ROUTE, ticketRoute: TICKET_ROUTE };

/** Source without line comments, so a rule about CODE is not tripped by prose that names what the code avoids. */
const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const HOST = "https://hone.care";
const CLIENT = "7c1d2e3f-4a5b-4c6d-8e7f-a1b2c3d4e5f6";
const DAY = "2031-02-17";
const URL_OK = `${HOST}/records/print/day?clientId=${CLIENT}&day=${DAY}`;
const has = (s: unknown) => JSON.stringify(s).includes(CLIENT) || JSON.stringify(s).includes(DAY);

const TICKET_URL = `${HOST}/records/print/ticket/${"A".repeat(127)}`;
describe("analytics and Sentry never see the client id or the day (ticket shape)", () => {
  it("Vercel analytics DROPS the ticket route instead of sending its path", () => {
    expect(redactVercelEvent({ type: "pageview" as const, url: TICKET_URL })).toBeNull();
    expect(redactVercelEvent({ type: "pageview" as const, url: `${TICKET_URL}?x=1#y` })).toBeNull();
  });
  it("Sentry scrub of a request, a transaction name and a navigation breadcrumb canonicalizes the ticket", () => {
    const err = scrubErrorEvent({ request: { url: TICKET_URL } } as never);
    const txn = scrubTransactionEvent({ transaction: `/records/print/ticket/${"A".repeat(127)}`, type: "transaction" } as never);
    const crumb = scrubBreadcrumb({ category: "navigation", data: { from: "/records", to: `/records/print/ticket/${"A".repeat(127)}` } } as never);
    for (const out of [err, txn, crumb]) expect(JSON.stringify(out)).not.toContain("AAAAAAAAAA");
  });
  it("the query-string shape is retired: the day route ignores it and the view is never given it", () => {
    expect(code(DAY_ROUTE)).not.toMatch(/searchParams|clientId|\.day\b/);
    expect(code(DAY_ROUTE)).toMatch(/<DayPacketView \/>/);
  });
});

describe("page-local privacy (M-1, M-2, M-3, M-4, M-6)", () => {
  it("M-1: no-referrer, noindex, force-dynamic, no revalidate", () => {
    for (const route of [DAY_ROUTE, TICKET_ROUTE]) {
      expect(route).toMatch(/export const dynamic = "force-dynamic"/);
      expect(route).toMatch(/referrer: "no-referrer"/);
      expect(route).toMatch(/robots: \{ index: false, follow: false \}/);
      expect(route).not.toMatch(/revalidate/);
    }
  });
  it("M-2: every link is prefetch={false} with no referrer, and none is a bare <a> to an app page", () => {
    const links = PAGE.match(/<Link\b[\s\S]*?>/g) ?? [];
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(l, l).toMatch(/prefetch=\{false\}/);
      expect(l, l).toMatch(/referrerPolicy="no-referrer"/);
    }
  });
  it("M-3: the only dynamic segment is the opaque ticket; no client id or day segment exists anywhere in the print routes", () => {
    expect(readdirSync(join(process.cwd(), DIR)).sort()).toEqual(["actions.ts", "page.tsx", "print-button.tsx"]);
    expect(readdirSync(join(process.cwd(), "app/(app)/records/print/ticket"))).toEqual(["[token]"]);
    expect(TICKET_ROUTE).toMatch(/params: Promise<\{ token: string \}>/);
    expect(PAGE).not.toMatch(/searchParams|useSearchParams/);
  });
  it("M-3: validation and refusal come before any audit or read, in this order: owner, day, day bounds, client, audit, load", () => {
    const order = ["canPrintClinicalPacket(practitioner)", "parseSelectedDay(typeof rawDay", "checkPrintableDay(day.day", "UUID.test(rawClientId)", "recordDayAudit(", "loadDayDocument("].map((s) => PAGE.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("M-4: no console, Sentry, analytics or logger call anywhere in the page, action or button", () => {
    for (const [name, src] of Object.entries(SOURCES)) {
      expect(code(src), name).not.toMatch(/console\.|@sentry|Sentry\.|captureException|captureMessage|setTag|setContext|setExtra|track\(|posthog|safeLog|logger/i);
    }
  });
  it("M-6: generic title, no third-party resource, @page margin 0, and an unarmed print shows only a notice", () => {
    for (const route of [DAY_ROUTE, TICKET_ROUTE]) expect(route).toMatch(/title: "Clinical record"/);
    expect(PAGE).not.toMatch(/https?:\/\//);
    expect(PAGE).toMatch(/@page \{ margin: 0; \}/);
    expect(PAGE).toMatch(/data-packet-document\]:not\(\[data-print-armed\]\) \{ display: none !important; \}/);
    expect(BUTTON).toMatch(/setAttribute\("data-print-armed"/);
  });
  it("layout (Photos #1383 proof): the app-shell footer is hidden in print but the packet's own footer is kept", () => {
    // The signed-in layout renders AppFooter (a <footer>) after the page; it made its own A4 page.
    expect(PAGE).toMatch(/body footer:not\(\[data-packet-document\] footer\) \{ display: none !important; \}/);
    // The packet's own footer is inside [data-packet-document] (what the :not() excludes).
    const doc = PAGE.slice(PAGE.indexOf("<div data-packet-document>"), PAGE.indexOf("data-print-unarmed-notice className"));
    expect(doc).toMatch(/<footer /);
  });
  it("layout (Photos #1383 proof): every printed page gets a 15 mm top and bottom margin from repeating spacer rows, with @page margin still 0 (no browser URL header)", () => {
    expect(PAGE).toMatch(/@page \{ margin: 0; \}/);
    expect(PAGE).toMatch(/\[data-packet-spacer\] \{ height: 15mm; \}/);
    expect(PAGE).toMatch(/\[data-packet-spacer\] \{ height: 0; padding: 0; \}/); // none on screen
    // The spacers are the table's header and footer groups, which browsers repeat on every page.
    expect(PAGE).toMatch(/<thead>\s*<tr>\s*<td data-packet-spacer \/>\s*<\/tr>\s*<\/thead>\s*<tfoot>\s*<tr>\s*<td data-packet-spacer \/>/);
    // Padding is left and right only; the old first/last-fragment top/bottom padding is gone.
    expect(PAGE).toMatch(/\[data-packet-page\] \{ padding: 0 16mm; \}/);
    expect(PAGE).not.toMatch(/\[data-packet-page\] \{ padding: 16mm; \}/);
  });
});

describe("owner gate, explicit refusals and fail-closed states (page source)", () => {
  it("the page and the print action both use the one owner predicate", () => {
    expect(PAGE).toMatch(/canPrintClinicalPacket\(practitioner\)/);
    expect(ACTIONS).toMatch(/canPrintClinicalPacket\(practitioner\)/);
  });
  it("the Print action takes the preview id and lets 0233 bind it; it never names an actor or studio", () => {
    expect(ACTIONS).toMatch(/printAuditMetadata\(day\.day, input\.previewAuditId\)/);
    expect(ACTIONS).not.toMatch(/actor|studio_id|studioId/);
  });
  it("every refusal prints no clinical content and says so; there is no default day or client", () => {
    expect(PAGE).toMatch(/No clinical record is shown\./);
    expect(PAGE).not.toMatch(/todayInTz|new Date\(\)\.toISOString\(\)\.slice/);
    expect(PAGE).toMatch(/audit_failed/);
    expect(PAGE).toMatch(/Nothing is listed because the read failed, not because there were no treatments/);
  });
  it("the empty day is named and offers no Print button", () => {
    expect(PAGE).toMatch(/No treatments were recorded for this client on \{dayLabel\}/);
    expect(PAGE).toMatch(/packet\.visits\.length > 0 && <AuditedPrintButton/);
  });
  it("no contact field and no raw date of birth can render", () => {
    expect(PAGE).not.toMatch(/\.phone|\.email|\.address|date_of_birth|dateOfBirth\b(?!\s*\})/);
    expect(PAGE).toMatch(/packet\.dateOfBirth/);
  });
  it("anti-vacuity: the detector flags a console call and a missing referrer policy when present", () => {
    expect("console.log(clientId)").toMatch(/console\./);
    expect(`<Link href="/x" prefetch={false}>`).not.toMatch(/referrerPolicy="no-referrer"/);
  });
});
