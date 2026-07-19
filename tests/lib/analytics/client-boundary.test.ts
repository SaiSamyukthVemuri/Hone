import { describe, expect, it } from "vitest";
import {
  AUTOCAPTURE_URL_ALLOWLIST,
  guardOutgoingEvent,
  isAutocaptureAllowedPath,
  sanitizeTokenPaths,
  sanitizeUrl,
} from "@/lib/analytics/client-boundary";

// Behavioral tests for the client analytics privacy boundary
// (P1-ANALYTICS-01 / P1-ANALYTICS-02). These exercise the actual functions the
// PostHog config runs (url_allowlist regexes + the before_send guard), with
// synthetic events shaped like real serialized autocapture payloads — not
// source-string scans. All tokens and names below are synthetic.

const HOST = "https://hone.care";

const MARKETING_PATHS = [
  "/",
  "/pricing",
  "/electrolysis-software",
  "/features/treatment-memory",
  "/features/booking-calendar",
  "/features/charting-records",
  "/resources",
  "/resources/electrolysis-treatment-record-checklist",
  "/demo",
  "/privacy",
  "/terms",
];

const TOKEN_ROUTE_URLS = [
  "/cancel/tok_SYNTH_cancel_1",
  "/reschedule/tok_SYNTH_res_1",
  "/manage/tok_SYNTH_manage_1",
  "/intake/tok_SYNTH_intake_1",
  "/portal/verify/tok_SYNTH_portal_1",
  "/calendar-feed/tok_SYNTH_feed_1.ics",
];

const AUTHENTICATED_APP_PATHS = [
  "/dashboard",
  "/clients",
  "/clients/abc-123",
  "/clients/abc-123/sessions/def-456",
  "/calendar",
  "/calendar/upcoming",
  "/records",
  "/settings/booking",
  "/notifications",
  "/admin",
  "/getting-started",
];

const OTHER_EXCLUDED_PATHS = [
  "/login",
  "/book/willow-electrolysis", // public booking collects client identity
  "/portal",
  "/portal/login",
  "/no-access",
];

describe("autocapture surface allowlist (explicit allow, default deny)", () => {
  it("allows exactly the public marketing surfaces", () => {
    for (const p of MARKETING_PATHS) {
      expect(isAutocaptureAllowedPath(p), `${p} should be allowed`).toBe(true);
    }
  });

  it("denies every token-bearing route", () => {
    for (const p of TOKEN_ROUTE_URLS) {
      expect(isAutocaptureAllowedPath(p), `${p} must be denied`).toBe(false);
    }
  });

  it("denies every authenticated app route", () => {
    for (const p of AUTHENTICATED_APP_PATHS) {
      expect(isAutocaptureAllowedPath(p), `${p} must be denied`).toBe(false);
    }
  });

  it("denies login, public booking, and portal", () => {
    for (const p of OTHER_EXCLUDED_PATHS) {
      expect(isAutocaptureAllowedPath(p), `${p} must be denied`).toBe(false);
    }
  });

  it("SDK url_allowlist regexes match marketing URLs and nothing sensitive", () => {
    const matches = (url: string) =>
      AUTOCAPTURE_URL_ALLOWLIST.some((re) => re.test(url));
    for (const p of MARKETING_PATHS) {
      expect(matches(`${HOST}${p}`), `${p} should match`).toBe(true);
    }
    for (const p of [
      ...TOKEN_ROUTE_URLS,
      ...AUTHENTICATED_APP_PATHS,
      ...OTHER_EXCLUDED_PATHS,
    ]) {
      expect(matches(`${HOST}${p}`), `${p} must NOT match`).toBe(false);
    }
    // Query strings / fragments on allowed pages still match.
    expect(matches(`${HOST}/pricing?utm_source=x#plans`)).toBe(true);
  });
});

describe("token sanitization (P1-ANALYTICS-01)", () => {
  it("redacts token segments in full URLs and bare paths", () => {
    expect(sanitizeUrl(`${HOST}/cancel/tok_SYNTH_abc`)).toBe(
      `${HOST}/cancel/[token]`,
    );
    expect(sanitizeTokenPaths("/manage/tok_SYNTH_xyz")).toBe(
      "/manage/[token]",
    );
    expect(
      sanitizeTokenPaths(`click ${HOST}/reschedule/tok_A and /intake/tok_B now`),
    ).toBe(`click ${HOST}/reschedule/[token] and /intake/[token] now`);
  });

  it("preserves non-token content", () => {
    expect(sanitizeTokenPaths(`${HOST}/pricing`)).toBe(`${HOST}/pricing`);
    expect(sanitizeTokenPaths("plain text")).toBe("plain text");
  });
});

function autocaptureEvent(url: string, elements: Record<string, unknown>[]) {
  return {
    event: "$autocapture",
    properties: {
      $current_url: url,
      $event_type: "click",
      $elements: elements,
      $elements_chain: elements
        .map((e) => `a:attr__href="${String(e.attr__href ?? "")}"`)
        .join(";"),
    },
  };
}

describe("before_send guard (guarantee layer)", () => {
  it("drops autocapture events from token-bearing routes entirely", () => {
    for (const p of TOKEN_ROUTE_URLS) {
      const ev = autocaptureEvent(`${HOST}${p}`, [
        { tag_name: "a", attr__href: "/cancel/tok_SYNTH_leak" },
      ]);
      expect(guardOutgoingEvent(ev), `${p} event must be dropped`).toBeNull();
    }
  });

  it("drops autocapture events from authenticated app routes entirely", () => {
    // Program test #4: a calendar appointment whose accessible attributes
    // contain a synthetic client name can never reach the payload — the whole
    // event is dropped because /calendar is not an allowed surface.
    const ev = autocaptureEvent(`${HOST}/calendar`, [
      {
        tag_name: "button",
        "attr__aria-label": "Edit appointment for Synthia Testcase",
      },
    ]);
    expect(guardOutgoingEvent(ev)).toBeNull();
  });

  it("drops rageclick/dead-click variants outside the allowlist too", () => {
    for (const name of ["$rageclick", "$dead_click"]) {
      expect(
        guardOutgoingEvent({
          event: name,
          properties: { $current_url: `${HOST}/dashboard` },
        }),
      ).toBeNull();
    }
  });

  it("fails closed on missing or unparsable $current_url", () => {
    expect(
      guardOutgoingEvent({ event: "$autocapture", properties: {} }),
    ).toBeNull();
    expect(
      guardOutgoingEvent({
        event: "$autocapture",
        properties: { $current_url: "not a url" },
      }),
    ).toBeNull();
  });

  it("keeps marketing autocapture but token-sanitizes $elements attributes (program test #3)", () => {
    const ev = autocaptureEvent(`${HOST}/pricing`, [
      { tag_name: "a", attr__href: `${HOST}/manage/tok_SYNTH_SECRET` },
      { tag_name: "a", attr__href: "/features/treatment-memory" },
    ]);
    const out = guardOutgoingEvent(ev);
    expect(out).not.toBeNull();
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("tok_SYNTH_SECRET");
    expect(serialized).toContain("/manage/[token]");
    expect(serialized).toContain("/features/treatment-memory");
    // elements_chain (the string-serialized form PostHog also sends) too.
    expect(
      (out?.properties as Record<string, unknown>).$elements_chain,
    ).not.toContain("tok_SYNTH_SECRET");
  });

  it("token-sanitizes non-autocapture events (pageviews) as well", () => {
    const out = guardOutgoingEvent({
      event: "$pageview",
      properties: {
        $current_url: `${HOST}/cancel/tok_SYNTH_pv`,
        $referrer: `${HOST}/manage/tok_SYNTH_ref`,
      },
    });
    expect(out).not.toBeNull();
    const s = JSON.stringify(out);
    expect(s).not.toContain("tok_SYNTH_pv");
    expect(s).not.toContain("tok_SYNTH_ref");
  });

  it("passes null through and never throws on odd shapes", () => {
    expect(guardOutgoingEvent(null)).toBeNull();
    expect(
      guardOutgoingEvent({ event: "custom", properties: undefined }),
    ).toEqual({ event: "custom", properties: undefined });
  });
});
