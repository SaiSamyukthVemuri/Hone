import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MARKETING_PAGES } from "@/lib/marketing/content";
import { TOKEN_ROUTE_PREFIXES } from "@/lib/security/token-routes";
import {
  redactVercelAnalyticsUrl,
  redactVercelEvent,
} from "@/lib/analytics/vercel-url-redaction";

// HIPAA-READY-01 G-07 (issue #828). Vercel Web Analytics and Speed Insights
// run on the authenticated app, /admin and /book. These tests feed real
// route shapes, with synthetic ids, through the actual `beforeSend` boundary.
// All ids, slugs and tokens below are synthetic.

const HOST = "https://hone.care";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const SLUG = "synthetic-studio-slug";

describe("redactVercelAnalyticsUrl", () => {
  it.each([
    [`${HOST}/clients/${CLIENT}`, `${HOST}/clients/[id]`],
    [
      `${HOST}/clients/${CLIENT}/sessions/${SESSION}`,
      `${HOST}/clients/[id]/sessions/[id]`,
    ],
    [`${HOST}/clients/${CLIENT}/clinical-notes/print`, `${HOST}/clients/[id]/clinical-notes/print`],
    [`${HOST}/calendar/${SESSION}`, `${HOST}/calendar/[id]`],
    [`${HOST}/admin/studios/${CLIENT}`, `${HOST}/admin/studios/[id]`],
    [`${HOST}/book/${SLUG}`, `${HOST}/book/[studio]`],
    [`${HOST}/book/${SLUG}/confirm`, `${HOST}/book/[studio]/confirm`],
    [`${HOST}/dashboard`, `${HOST}/dashboard`],
    [`${HOST}/invoices/123456`, `${HOST}/invoices/[id]`],
    [`${HOST}/x/AbCdEf0123456789_-AbCdEf`, `${HOST}/x/[token]`],
  ])("%s → %s", (input, expected) => {
    expect(redactVercelAnalyticsUrl(input)).toBe(expected);
  });

  it("drops the query string and fragment on non-marketing routes", () => {
    const out = redactVercelAnalyticsUrl(
      `${HOST}/calendar?client=${CLIENT}&email=synthetic%40example.test#appt-${SESSION}`,
    );
    expect(out).toBe(`${HOST}/calendar`);
  });

  it("redacts a percent-encoded id segment", () => {
    const encoded = encodeURIComponent(CLIENT).replace(/-/g, "%2D");
    expect(redactVercelAnalyticsUrl(`${HOST}/clients/${encoded}`)).toBe(
      `${HOST}/clients/[id]`,
    );
  });

  it("drops every route in the canonical bearer-token registry", () => {
    // Derived from lib/security/token-routes.ts, so a new token route is
    // covered without editing this test (Codex P1 on #842: /invitation).
    expect(TOKEN_ROUTE_PREFIXES).toContain("/invitation");
    for (const prefix of TOKEN_ROUTE_PREFIXES) {
      for (const p of [prefix, `${prefix}/tok_SYNTH`, `${prefix}/tok_SYNTH/step/2`]) {
        expect(redactVercelAnalyticsUrl(`${HOST}${p}`)).toBeNull();
      }
    }
  });

  it("drops an all-letter invitation token (no digit to match on)", () => {
    const letters = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijkl";
    expect(redactVercelAnalyticsUrl(`${HOST}/invitation/${letters}`)).toBeNull();
  });

  it("redacts a 32+ character all-letter segment outside the token routes", () => {
    const letters = "abcdefghijklmnopqrstuvwxyzabcdef";
    expect(redactVercelAnalyticsUrl(`${HOST}/x/${letters}`)).toBe(`${HOST}/x/[token]`);
    // Ordinary route words stay readable.
    expect(redactVercelAnalyticsUrl(`${HOST}/settings/getting-started`)).toBe(
      `${HOST}/settings/getting-started`,
    );
  });

  it("drops an unparsable URL", () => {
    expect(redactVercelAnalyticsUrl("not a url")).toBeNull();
  });

  it("keeps marketing pages with only the reviewed attribution params", () => {
    for (const { path: p } of MARKETING_PAGES) {
      const out = redactVercelAnalyticsUrl(
        `${HOST}${p}?utm_source=synthetic&email=synthetic%40example.test#x`,
      );
      expect(out).toBe(`${HOST}${p}?utm_source=synthetic`);
    }
  });
});

describe("redactVercelEvent (the beforeSend both components receive)", () => {
  it("keeps the event shape, including a Speed Insights route template", () => {
    const vital = {
      type: "vital" as const,
      url: `${HOST}/clients/${CLIENT}`,
      route: "/clients/[id]",
    };
    expect(redactVercelEvent(vital)).toEqual({
      type: "vital",
      url: `${HOST}/clients/[id]`,
      route: "/clients/[id]",
    });
  });

  it("returns null so the SDK cancels the event", () => {
    expect(
      redactVercelEvent({ type: "pageview" as const, url: `${HOST}/cancel/tok_SYNTH` }),
    ).toBeNull();
  });
});

// Every dynamic page under a tree that mounts SafeAnalytics, with each
// [param] filled by a synthetic id, must leave no trace of that id. A new
// dynamic route is covered without editing this test.
describe("every dynamic route under the analytics-mounted trees", () => {
  const ROOT = path.resolve(__dirname, "../../..");
  const TREES = ["app/(app)", "app/admin", "app/book"];

  function pages(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) out.push(...pages(full));
      else if (name === "page.tsx") out.push(dir);
    }
    return out;
  }

  const routes = TREES.flatMap((t) =>
    pages(path.join(ROOT, t)).map((d) =>
      path
        .relative(path.join(ROOT, "app"), d)
        .split(path.sep)
        .filter((s) => !/^\(.*\)$/.test(s))
        .join("/"),
    ),
  ).filter((r) => r.includes("["));

  it("finds the dynamic routes (guards against an empty walk)", () => {
    expect(routes).toEqual(expect.arrayContaining(["clients/[id]", "book/[slug]"]));
  });

  it.each(routes)("/%s leaks no synthetic id", (route) => {
    const synthetic = route.replace(/\[[^\]]+\]/g, () =>
      route.startsWith("book/") ? SLUG : CLIENT,
    );
    const out = redactVercelAnalyticsUrl(`${HOST}/${synthetic}`);
    expect(out).not.toBeNull();
    expect(out).not.toContain(CLIENT);
    expect(out).not.toContain(SLUG);
  });
});

describe("SafeAnalytics wiring", () => {
  it("passes the redaction boundary to both Vercel components", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../../app/_components/SafeAnalytics.tsx"),
      "utf8",
    );
    expect(src).toMatch(/<Analytics\s+beforeSend=\{redactVercelEvent\}\s*\/>/);
    expect(src).toMatch(/<SpeedInsights\s+beforeSend=\{redactVercelEvent\}\s*\/>/);
    expect(src).not.toMatch(/<Analytics\s*\/>/);
    expect(src).not.toMatch(/<SpeedInsights\s*\/>/);
  });
});
