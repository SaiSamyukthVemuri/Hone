import { describe, expect, it } from "vitest";
import { MARKETING_PAGES } from "@/lib/marketing/content";
import {
  AUTOCAPTURE_URL_ALLOWLIST,
  guardBrowserEvent,
  isMarketingPath,
  sanitizeMarketingUrl,
} from "@/lib/analytics/client-boundary";

// Behavioral tests for the fail-closed browser-event boundary
// (P1-ANALYTICS-01/-02). Real event-shaped payloads (as PostHog serializes
// them) are run through the actual `before_send` guard, not source-string
// scans. All UUIDs/tokens/names below are synthetic.

const HOST = "https://hone.care";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

const MARKETING_ROUTES = MARKETING_PAGES.map((p) => p.path);

function ev(
  name: string,
  url: string | null,
  extraProps: Record<string, unknown> = {},
) {
  const properties: Record<string, unknown> = { ...extraProps };
  if (url !== null) properties.$current_url = url;
  return { event: name, properties };
}

const TOKEN_ROUTE_URLS = [
  `${HOST}/cancel/tok_SYNTH_cancel`,
  `${HOST}/reschedule/tok_SYNTH_res`,
  `${HOST}/manage/tok_SYNTH_manage`,
  `${HOST}/intake/tok_SYNTH_intake`,
  `${HOST}/portal/verify/tok_SYNTH_portal`,
  `${HOST}/calendar-feed/tok_SYNTH_feed.ics`,
];

const AUTHENTICATED_URLS = [
  `${HOST}/dashboard`,
  `${HOST}/clients`,
  `${HOST}/clients/${U1}`,
  `${HOST}/clients/${U1}/sessions/${U2}`,
  `${HOST}/clients/${U1}/images`,
  `${HOST}/records`,
  `${HOST}/calendar`,
  `${HOST}/settings/booking`,
  `${HOST}/notifications`,
  `${HOST}/admin/studios`,
];

describe("marketing surface derivation", () => {
  it("MARKETING_ROUTES equals the 12 canonical marketing pages", () => {
    expect(MARKETING_ROUTES).toHaveLength(12);
    for (const p of MARKETING_ROUTES) expect(isMarketingPath(p)).toBe(true);
  });
});

describe("Scenario 8: the 12 exact marketing paths permit $pageview/$pageleave", () => {
  for (const path of MARKETING_ROUTES) {
    it(`allows $pageview on ${path}`, () => {
      expect(guardBrowserEvent(ev("$pageview", `${HOST}${path}`))).not.toBeNull();
    });
    it(`allows $pageleave on ${path}`, () => {
      expect(guardBrowserEvent(ev("$pageleave", `${HOST}${path}`))).not.toBeNull();
    });
  }
});

describe("Scenarios 1-3: authenticated pageview/pageleave dropped", () => {
  it("drops $pageview from an authenticated client route (/clients/<uuid>)", () => {
    expect(guardBrowserEvent(ev("$pageview", `${HOST}/clients/${U1}`))).toBeNull();
  });
  it("drops $pageview from a session route (/clients/<uuid>/sessions/<uuid>)", () => {
    expect(
      guardBrowserEvent(ev("$pageview", `${HOST}/clients/${U1}/sessions/${U2}`)),
    ).toBeNull();
  });
  it("drops $pageleave + $pageview + $autocapture from every authenticated route", () => {
    for (const url of AUTHENTICATED_URLS) {
      expect(guardBrowserEvent(ev("$pageleave", url)), url).toBeNull();
      expect(guardBrowserEvent(ev("$pageview", url)), url).toBeNull();
      expect(guardBrowserEvent(ev("$autocapture", url)), url).toBeNull();
    }
  });
});

describe("Scenario 4: token-route browser events dropped, not redacted", () => {
  for (const url of TOKEN_ROUTE_URLS) {
    it(`drops every event on ${new URL(url).pathname.split("/")[1]}`, () => {
      for (const name of ["$pageview", "$pageleave", "$autocapture", "$rageclick"]) {
        expect(guardBrowserEvent(ev(name, url)), `${name} ${url}`).toBeNull();
      }
    });
  }
});

describe("Scenario 5: public booking browser events dropped", () => {
  it("drops events on /book/*", () => {
    expect(guardBrowserEvent(ev("$pageview", `${HOST}/book/willow-electrolysis`))).toBeNull();
    expect(guardBrowserEvent(ev("$autocapture", `${HOST}/book/willow-electrolysis`))).toBeNull();
  });
});

describe("Scenario 6: portal events dropped", () => {
  it("drops events on /portal and /portal/login", () => {
    expect(guardBrowserEvent(ev("$pageview", `${HOST}/portal`))).toBeNull();
    expect(guardBrowserEvent(ev("$pageview", `${HOST}/portal/login`))).toBeNull();
  });
});

describe("Scenario 7: login/auth events dropped", () => {
  it("drops events on /login and /auth/*", () => {
    expect(guardBrowserEvent(ev("$pageview", `${HOST}/login`))).toBeNull();
    expect(guardBrowserEvent(ev("$pageview", `${HOST}/auth/callback`))).toBeNull();
  });
});

describe("Scenario 9: unknown route under an allowed prefix is denied", () => {
  it("denies /resources/future-user-content (no prefix escalation)", () => {
    expect(
      guardBrowserEvent(ev("$pageview", `${HOST}/resources/future-user-content`)),
    ).toBeNull();
    // The exact allowed resource articles still pass.
    expect(
      guardBrowserEvent(
        ev("$pageview", `${HOST}/resources/electrolysis-treatment-record-checklist`),
      ),
    ).not.toBeNull();
  });
});

describe("Scenario 10: marketing URLs drop unapproved query params + fragments", () => {
  it("keeps only reviewed attribution params on $current_url", () => {
    const out = guardBrowserEvent(
      ev(
        "$pageview",
        `${HOST}/pricing?utm_source=news&utm_campaign=q3&secret_ref=abc&email=a@b.com#plans`,
      ),
    );
    expect(out).not.toBeNull();
    const url = (out!.properties as Record<string, unknown>).$current_url as string;
    expect(url).toContain("utm_source=news");
    expect(url).toContain("utm_campaign=q3");
    expect(url).not.toContain("secret_ref");
    expect(url).not.toContain("email=");
    expect(url).not.toContain("#plans");
  });
});

describe("Scenario 11: marketing referrers cannot carry token paths or sensitive query", () => {
  it("redacts a token path and strips sensitive query in $referrer", () => {
    const out = guardBrowserEvent(
      ev("$pageview", `${HOST}/`, {
        $referrer: `${HOST}/manage/tok_SYNTH_SECRET?email=jane@example.com`,
      }),
    );
    expect(out).not.toBeNull();
    const ref = (out!.properties as Record<string, unknown>).$referrer as string;
    expect(ref).not.toContain("tok_SYNTH_SECRET");
    expect(ref).toContain("/manage/[token]");
    expect(ref).not.toContain("jane@example.com");
  });
  it("also sanitizes $initial_current_url inside $set_once", () => {
    const out = guardBrowserEvent(
      ev("$pageview", `${HOST}/`, {
        $set_once: {
          $initial_current_url: `${HOST}/cancel/tok_SYNTH_INIT?x=1`,
        },
      }),
    );
    const setOnce = (out!.properties as Record<string, Record<string, unknown>>)
      .$set_once;
    expect(String(setOnce.$initial_current_url)).not.toContain("tok_SYNTH_INIT");
    expect(String(setOnce.$initial_current_url)).toContain("/cancel/[token]");
    expect(String(setOnce.$initial_current_url)).not.toContain("x=1");
  });
});

describe("Scenario 12: $identify never leaves the browser", () => {
  it("drops $identify even on a marketing surface (identify is server-side)", () => {
    expect(
      guardBrowserEvent(
        ev("$identify", `${HOST}/`, { $set: { email: "jane@example.com" } }),
      ),
    ).toBeNull();
  });
});

describe("Scenario 13: unknown event names fail closed", () => {
  it("drops non-allowlisted event names even on marketing", () => {
    for (const name of ["$snapshot", "$web_vitals", "$feature_flag_called", "custom_event"]) {
      expect(guardBrowserEvent(ev(name, `${HOST}/pricing`)), name).toBeNull();
    }
  });
  it("allows explicitly-namespaced marketing:* events on marketing", () => {
    expect(guardBrowserEvent(ev("marketing:cta_click", `${HOST}/pricing`))).not.toBeNull();
  });
  it("drops marketing:* events OFF marketing surfaces", () => {
    expect(guardBrowserEvent(ev("marketing:cta_click", `${HOST}/dashboard`))).toBeNull();
  });
});

describe("fail-closed URL handling + shape safety", () => {
  it("drops events with missing or unparsable $current_url", () => {
    expect(guardBrowserEvent(ev("$pageview", null))).toBeNull();
    expect(guardBrowserEvent(ev("$pageview", "not a url"))).toBeNull();
  });
  it("drops events with no event name", () => {
    expect(
      guardBrowserEvent({ event: "", properties: { $current_url: `${HOST}/` } }),
    ).toBeNull();
  });
  it("passes null through", () => {
    expect(guardBrowserEvent(null)).toBeNull();
  });
});

describe("autocapture on marketing: token-sanitized $elements", () => {
  it("keeps the event but redacts token attr__href, strips query", () => {
    const out = guardBrowserEvent(
      ev("$autocapture", `${HOST}/pricing`, {
        $elements: [
          { tag_name: "a", attr__href: `${HOST}/manage/tok_SYNTH_LEAK` },
          { tag_name: "a", attr__href: `${HOST}/features/treatment-memory?ref=x` },
        ],
        $elements_chain: `a:attr__href="${HOST}/manage/tok_SYNTH_LEAK"`,
      }),
    );
    expect(out).not.toBeNull();
    const s = JSON.stringify(out);
    expect(s).not.toContain("tok_SYNTH_LEAK");
    expect(s).toContain("/manage/[token]");
    expect(s).not.toContain("ref=x");
  });
});

describe("sanitizeMarketingUrl unit behavior", () => {
  it("handles relative paths and drops fragments", () => {
    expect(sanitizeMarketingUrl("/pricing?utm_source=x&z=1#frag")).toBe(
      "/pricing?utm_source=x",
    );
    expect(sanitizeMarketingUrl("garbage://[")).toBe("[redacted]");
  });
});

describe("AUTOCAPTURE_URL_ALLOWLIST (SDK defence layer)", () => {
  it("matches marketing URLs and rejects sensitive ones", () => {
    const matches = (u: string) => AUTOCAPTURE_URL_ALLOWLIST.some((re) => re.test(u));
    expect(matches(`${HOST}/`)).toBe(true);
    expect(matches(`${HOST}/pricing?utm_source=x`)).toBe(true);
    expect(matches(`${HOST}/clients/${U1}`)).toBe(false);
    expect(matches(`${HOST}/manage/tok`)).toBe(false);
    expect(matches(`${HOST}/resources/future-user-content`)).toBe(false);
  });
});
