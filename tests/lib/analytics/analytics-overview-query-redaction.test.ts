import { describe, expect, it } from "vitest";
import type { Breadcrumb, ErrorEvent, Event } from "@sentry/nextjs";

import { guardBrowserEvent } from "@/lib/analytics/client-boundary";
import { redactVercelAnalyticsUrl, redactVercelEvent } from "@/lib/analytics/vercel-url-redaction";
import { scrubBreadcrumb, scrubErrorEvent, scrubTransactionEvent } from "@/lib/observability/sentry-scrub";

// ===========================================================================
// The Analytics Overview (/financials/analytics) puts a chosen team member's id, and the dates, in its QUERY STRING. Nothing may carry that
// query to Vercel, PostHog or Sentry. These tests pin the three boundaries against every route of the feature BEFORE any navigation link to it is
// added. SYNTHETIC values only.
// ===========================================================================

const MEMBER = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const QUERY = `practitioner=${MEMBER}&period=custom&from=2026-01-05&to=2026-02-17&compare=last_year&series=visits`;
const ROUTES = ["/financials/analytics", "/financials/analytics/print", "/financials/analytics/export.csv"] as const;
const ORIGIN = "https://app.example.test";
const URLS = ROUTES.map((r) => `${ORIGIN}${r}?${QUERY}`);

/** Nothing of the query may survive: not the member id, not a date, not a parameter name. */
function expectNoQuery(value: unknown, where: string): void {
  const json = JSON.stringify(value);
  for (const needle of [MEMBER, "2026-01-05", "2026-02-17", "practitioner=", "from=", "to=", "compare=", "series="]) {
    expect(json.toLowerCase(), `${where} still carries ${needle}`).not.toContain(needle.toLowerCase());
  }
}

/** Free text (an error message, a console line) keeps the words of a URL, so its parameter NAMES and non-sensitive values (period=custom) may remain; the member id and the dates may not. */
function expectNoValues(value: unknown, where: string): void {
  const json = JSON.stringify(value).toLowerCase();
  for (const needle of [MEMBER, "2026-01-05", "2026-02-17"]) expect(json, `${where} still carries ${needle}`).not.toContain(needle.toLowerCase());
}

describe("Vercel Web Analytics and Speed Insights", () => {
  it("every route of the feature loses its whole query string; the path stays", () => {
    URLS.forEach((u, i) => {
      const out = redactVercelAnalyticsUrl(u);
      expect(out, u).toBe(`${ORIGIN}${ROUTES[i]}`);
      expectNoQuery(out, u);
    });
  });
  it("an encoded query, a repeated key and a fragment are dropped too", () => {
    for (const u of [
      `${ORIGIN}/financials/analytics?practitioner%3D${MEMBER}`,
      `${ORIGIN}/financials/analytics?practitioner=${MEMBER}&practitioner=${MEMBER}`,
      `${ORIGIN}/financials/analytics#practitioner=${MEMBER}`,
      `${ORIGIN}/financials/analytics?from=2026-01-05&to=2026-02-17`,
    ]) expectNoQuery(redactVercelAnalyticsUrl(u), u);
  });
  it("the event wrapper redacts the url of the event, with its other fields kept", () => {
    const e = redactVercelEvent({ type: "pageview", url: URLS[0], route: "/financials/analytics" });
    expect(e).toEqual({ type: "pageview", url: `${ORIGIN}/financials/analytics`, route: "/financials/analytics" });
    expectNoQuery(e, "event");
  });
});

describe("PostHog (browser boundary)", () => {
  const event = (url: string) => ({ event: "$pageview", properties: { $current_url: url, $referrer: url, $initial_current_url: url, $pathname: new URL(url).pathname } });
  it("an event from any route of the feature is dropped: it is not a marketing page", () => {
    for (const u of URLS) expect(guardBrowserEvent(event(u)), u).toBeNull();
  });
  it("a marketing event whose REFERRER is one of these URLs keeps neither the id nor the query", () => {
    for (const u of URLS) {
      const out = guardBrowserEvent({ event: "$pageview", properties: { $current_url: `${ORIGIN}/`, $referrer: u, $initial_referrer: u, $set_once: { $initial_referrer: u } }, $set_once: { $initial_referrer: u } });
      if (out !== null) expectNoQuery(out, `referrer ${u}`);
    }
  });
});

describe("Sentry", () => {
  const error = (over: Partial<ErrorEvent>): ErrorEvent => ({ type: undefined, ...over }) as ErrorEvent;
  it("the structured URL fields (request.url, request.query_string, headers, the transaction name) carry no part of the query", () => {
    for (const u of URLS) {
      const out = scrubErrorEvent(
        error({ request: { url: u, query_string: QUERY, headers: { referer: u } }, transaction: `GET ${new URL(u).pathname}?${QUERY}` }),
      );
      expectNoQuery(out, `error event for ${u}`);
    }
  });
  it("free text (the message and the exception value) keeps no member id and no date; the parameter names may remain (pinned, not hidden)", () => {
    for (const u of URLS) {
      const out = scrubErrorEvent(error({ message: `failed at ${u}`, exception: { values: [{ type: "Error", value: `bad request ${u}` }] } }));
      // Asserted on the scrubbed TEXT itself, field by field, so a later scrubber change that stops redacting the id or a date goes red here,
      // whatever shape the rest of the string takes.
      const texts = [out.message, out.exception?.values?.[0]?.value];
      for (const text of texts) {
        expect(typeof text, "the free text is still there").toBe("string");
        for (const secret of [MEMBER, MEMBER.toUpperCase(), "2026-01-05", "2026-02-17"]) expect(text as string, `${secret} in "${text}"`).not.toContain(secret);
      }
      expectNoValues(out, `free text for ${u}`);
      expect(JSON.stringify(out)).toContain("practitioner=[id]"); // the id is replaced, the name of the parameter is not a secret
    }
  });
  it("a navigation breadcrumb and a fetch breadcrumb with these URLs carry no part of the query (a console line keeps only parameter names)", () => {
    for (const u of URLS) {
      for (const b of [
        { category: "navigation", data: { from: u, to: u } },
        { category: "fetch", data: { url: u, method: "GET" } },
        { category: "console", message: `loading ${u}` },
      ] as Breadcrumb[]) {
        (b.category === "console" ? expectNoValues : expectNoQuery)(scrubBreadcrumb(b), `${b.category} breadcrumb for ${u}`);
      }
    }
  });
  it("a transaction with a span on these URLs carries no part of the query", () => {
    for (const u of URLS) {
      const tx = {
        type: "transaction",
        transaction: new URL(u).pathname + "?" + QUERY,
        request: { url: u },
        spans: [{ description: `GET ${u}`, data: { "http.url": u, "url.full": u, "http.query": QUERY, "url.query": QUERY } }],
        contexts: { trace: { data: { "http.url": u, "url.full": u, "http.query": QUERY } } },
      } as unknown as Event;
      expectNoQuery(scrubTransactionEvent(tx), `transaction for ${u}`);
    }
  });
});
