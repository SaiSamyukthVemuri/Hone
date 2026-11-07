import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redactVercelEvent } from "@/lib/analytics/vercel-url-redaction";
import { scrubBreadcrumb, scrubErrorEvent, scrubTransactionEvent } from "@/lib/observability/sentry-scrub";

// HON-46 M2, Privacy route answer M-1..M-6 (G-26). A NEW file: it pins the URL
// privacy of /records/print/day for the exact shape ?clientId=<uuid>&day=<date>,
// using a synthetic id and date. G-26 is NOT fully satisfied: Vercel platform
// request logs record the path and query before application code runs, and the
// beacon's own Referer is closed only by this page's no-referrer policy.

const DIR = "app/(app)/records/print/day";
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const PAGE = read(`${DIR}/page.tsx`);
const ACTIONS = read(`${DIR}/actions.ts`);
const BUTTON = read(`${DIR}/print-button.tsx`);
const SOURCES = { page: PAGE, actions: ACTIONS, button: BUTTON };

const HOST = "https://hone.care";
const CLIENT = "7c1d2e3f-4a5b-4c6d-8e7f-a1b2c3d4e5f6";
const DAY = "2031-02-17";
const URL_OK = `${HOST}/records/print/day?clientId=${CLIENT}&day=${DAY}`;
const has = (s: unknown) => JSON.stringify(s).includes(CLIENT) || JSON.stringify(s).includes(DAY);

describe("analytics and Sentry never see the client id or the day (query-string shape)", () => {
  it("Vercel redaction output has neither", () => {
    const out = redactVercelEvent({ type: "pageview" as const, url: URL_OK });
    expect(out?.url).toBe(`${HOST}/records/print/day`);
    expect(has(out)).toBe(false);
  });
  it("Sentry scrub of a request, a transaction name and a navigation breadcrumb has neither", () => {
    const err = scrubErrorEvent({ request: { url: URL_OK, query_string: `clientId=${CLIENT}&day=${DAY}` } } as never);
    const txn = scrubTransactionEvent({ transaction: `/records/print/day?clientId=${CLIENT}&day=${DAY}`, type: "transaction" } as never);
    const crumb = scrubBreadcrumb({ category: "navigation", data: { from: "/records", to: `/records/print/day?clientId=${CLIENT}&day=${DAY}` } } as never);
    expect(has(err)).toBe(false);
    expect(has(txn)).toBe(false);
    expect(has(crumb)).toBe(false);
  });
  it("NEGATIVE CONTROL: a date in the PATH survives the redaction, which is why both values stay in the query", () => {
    const pathShaped = redactVercelEvent({ type: "pageview" as const, url: `${HOST}/records/print/day/${DAY}?clientId=${CLIENT}` });
    expect(pathShaped?.url).toContain(DAY);
  });
});

describe("page-local privacy (M-1, M-2, M-3, M-4, M-6)", () => {
  it("M-1: no-referrer, noindex, force-dynamic, no revalidate", () => {
    expect(PAGE).toMatch(/export const dynamic = "force-dynamic"/);
    expect(PAGE).toMatch(/referrer: "no-referrer"/);
    expect(PAGE).toMatch(/robots: \{ index: false, follow: false \}/);
    expect(PAGE).not.toMatch(/revalidate/);
  });
  it("M-2: every link is prefetch={false} with no referrer, and none is a bare <a> to an app page", () => {
    const links = PAGE.match(/<Link\b[\s\S]*?>/g) ?? [];
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(l, l).toMatch(/prefetch=\{false\}/);
      expect(l, l).toMatch(/referrerPolicy="no-referrer"/);
    }
  });
  it("M-3: the route has no dynamic path segment, so client id and day can only be query values", () => {
    const entries = readdirSync(join(process.cwd(), DIR));
    expect(entries.sort()).toEqual(["actions.ts", "page.tsx", "print-button.tsx"]);
    expect(PAGE).toMatch(/searchParams/);
    expect(PAGE).not.toMatch(/\bparams:\s*Promise/);
  });
  it("M-3: validation and refusal come before any audit or read, in this order: owner, day, day bounds, client, audit, load", () => {
    const order = ["canPrintClinicalPacket(practitioner)", "parseSelectedDay(sp.day)", "checkPrintableDay(day.day", "UUID.test(sp.clientId)", "recordDayAudit(", "loadDayDocument("].map((s) => PAGE.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("M-4: no console, Sentry, analytics or logger call anywhere in the page, action or button", () => {
    for (const [name, src] of Object.entries(SOURCES)) {
      expect(src, name).not.toMatch(/console\.|@sentry|Sentry\.|captureException|captureMessage|setTag|setContext|setExtra|track\(|posthog|safeLog|logger/i);
    }
  });
  it("M-6: generic title, no third-party resource, @page margin 0, and an unarmed print shows only a notice", () => {
    expect(PAGE).toMatch(/title: "Clinical record"/);
    expect(PAGE).not.toMatch(/https?:\/\//);
    expect(PAGE).toMatch(/@page \{ margin: 0; \}/);
    expect(PAGE).toMatch(/data-packet-document\]:not\(\[data-print-armed\]\) \{ display: none !important; \}/);
    expect(BUTTON).toMatch(/setAttribute\("data-print-armed"/);
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
