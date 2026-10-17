import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { guardBrowserEvent } from "@/lib/analytics/client-boundary";

// ===========================================================================
// #828 G-07/G-26 + G-08: no record id in what PostHog receives from the
// browser.
//
// L1. Marketing-page events are the only browser events allowed out, but their
// URL-valued properties named APP pages: a practitioner on /clients/<uuid> who
// follows a link to /pricing sends that URL as $referrer (same-origin
// navigations get the full referrer), and $initial_current_url /
// $session_entry_url carry the first app page a browser saw. guardBrowserEvent
// redacted token routes only. Now every URL-valued property (named keys plus
// any *_url / *_referrer / *_pathname), in `properties`, `$set` and
// `$set_once`, loses its record ids, by the same rules as Vercel Analytics.
//
// L2. posthog-js 1.404.1 sends person properties, including the first page this
// browser loaded, in every /flags request body, which before_send never sees.
// Hone uses no feature flags, so /flags is turned off; pinned below against
// both the config and the SDK's own gate.
//
// ZERO NETWORK: pure functions only, with fetch trapped and a positive control.
// All ids are SYNTHETIC. The oracle decodes percent-escapes to a fixed point.
// ===========================================================================

const CLIENT = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const SESSION = "0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9";
const APPT = "ABCDEF12-3456-4789-8ABC-DEF012345678";
// A PostHog-generated UUIDv7 ($session_id, distinct_id, uuid): NOT a Hone
// record id, and must be kept or analytics sessions break.
const PH_SESSION = "01928f3a-7b2c-7d4e-8f00-123456789abc";
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HOST = "https://hone.care";

function oracleDecode(text: string): string {
  let cur = text;
  for (let i = 0; i < 16; i += 1) {
    const next = cur.replace(/%([0-7][0-9a-f])/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

const networkCalls: string[] = [];
beforeAll(() => {
  vi.stubGlobal("fetch", (input: unknown) => {
    networkCalls.push(String(input));
    throw new Error("network egress is forbidden in this test");
  });
});
afterAll(() => vi.unstubAllGlobals());

/** A marketing $pageview whose URL properties name app pages, every way. */
function marketingEventCarryingAppUrls() {
  const appPage = `${HOST}/clients/${CLIENT}/sessions/${SESSION}?tab=photos`;
  return {
    event: "$pageview",
    uuid: PH_SESSION,
    properties: {
      $current_url: `${HOST}/pricing`,
      $pathname: "/pricing",
      $host: "hone.care",
      $session_id: PH_SESSION,
      distinct_id: PH_SESSION,
      $referrer: appPage,
      $referring_domain: "hone.care",
      $initial_current_url: `${HOST}/calendar/${APPT}`,
      $initial_pathname: `/calendar/${APPT}`,
      $initial_referrer: `${HOST}/clients/${CLIENT.replace(/-/g, "%2D")}`,
      $session_entry_url: `${HOST}/clients/%36${CLIENT.slice(1)}`,
      $session_entry_pathname: `/clients/${CLIENT}/intake`,
      $session_entry_referrer: `${HOST}/clients/${CLIENT}%252Fsessions`,
      $prev_pageview_pathname: `/clients/${CLIENT}/sessions/${SESSION}`,
      $appointment_url: `${HOST}/calendar/42`,
    },
    $set: { $current_url: appPage },
    $set_once: { $initial_current_url: appPage, $initial_pathname: `/clients/${CLIENT}` },
  };
}

describe("L1: marketing events carry no record id in any URL-valued property", () => {
  it("properties, $set and $set_once: no Hone record id survives, in any encoding", () => {
    const out = guardBrowserEvent(marketingEventCarryingAppUrls());
    expect(out).not.toBeNull();
    const urlish = JSON.stringify({
      ...Object.fromEntries(
        Object.entries(out!.properties ?? {}).filter(([k]) => !["$session_id", "distinct_id"].includes(k)),
      ),
      $set: out!.$set,
      $set_once: out!.$set_once,
    });
    const decoded = oracleDecode(urlish);
    for (const id of [CLIENT, SESSION, APPT]) expect(decoded.toLowerCase()).not.toContain(id.toLowerCase());
    expect(UUID_ANYWHERE.test(decoded), decoded).toBe(false);
    expect(decoded).not.toMatch(/\/calendar\/42\b/);
  });

  it("keeps the route shape, the marketing URL and PostHog's own ids (analytics still works)", () => {
    const out = guardBrowserEvent(marketingEventCarryingAppUrls())!;
    const p = out.properties as Record<string, string>;
    expect(p.$current_url).toBe(`${HOST}/pricing`);
    expect(p.$pathname).toBe("/pricing");
    expect(p.$referrer).toBe(`${HOST}/clients/[id]/sessions/[id]`);
    expect(p.$initial_pathname).toBe("/calendar/[id]");
    expect(p.$prev_pageview_pathname).toBe("/clients/[id]/sessions/[id]");
    expect(p.$appointment_url).toBe(`${HOST}/calendar/[id]`);
    // PostHog's own UUIDv7s are not Hone record ids and are kept:
    // the oracle above is not blind to UUIDs, it is scoped to URL fields.
    expect(p.$session_id).toBe(PH_SESSION);
    expect(p.distinct_id).toBe(PH_SESSION);
    expect(out.$set_once).toEqual({ $initial_current_url: `${HOST}/clients/[id]/sessions/[id]`, $initial_pathname: "/clients/[id]" });
  });

  it("long marketing slugs are not mistaken for tokens", () => {
    const out = guardBrowserEvent({
      event: "$pageview",
      properties: {
        $current_url: `${HOST}/pricing`,
        $referrer: `${HOST}/resources/electrolysis-treatment-record-checklist?utm_source=x`,
      },
    })!;
    expect((out.properties as Record<string, string>).$referrer).toBe(
      `${HOST}/resources/electrolysis-treatment-record-checklist?utm_source=x`,
    );
  });

  it("NEGATIVE CONTROL: an app-page event is still dropped whole (the boundary itself is unchanged)", () => {
    const ev = marketingEventCarryingAppUrls();
    ev.properties.$current_url = `${HOST}/clients/${CLIENT}`;
    expect(guardBrowserEvent(ev)).toBeNull();
  });
});

describe("L2: no /flags request leaves (Hone uses no feature flags)", () => {
  const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");

  it("instrumentation-client.ts sets advanced_disable_flags: true", () => {
    const src = read("instrumentation-client.ts").replace(/^\s*\/\/.*$/gm, "");
    expect(src).toMatch(/advanced_disable_flags:\s*true/);
  });

  it("the installed posthog-js gates its /flags request on that exact option name", () => {
    const pkg = JSON.parse(read("node_modules/posthog-js/package.json")) as { version: string };
    const dist = read("node_modules/posthog-js/dist/module.js");
    // The flags loader returns early when the instance reports flags disabled,
    // and that check reads `advanced_disable_flags`. If an upgrade renames the
    // option, this fails instead of silently re-enabling /flags.
    expect(dist, `posthog-js ${pkg.version}`).toContain('"advanced_disable_flags"in o?!!o.advanced_disable_flags');
    expect(dist).toContain('endpointFor("flags","/flags/?v=2")');
  });

  it("nothing in the app evaluates a feature flag (turning /flags off changes no behaviour)", () => {
    for (const f of ["instrumentation-client.ts"]) {
      expect(read(f)).not.toMatch(/isFeatureEnabled|getFeatureFlag|onFeatureFlags/);
    }
  });
});

describe("zero network", () => {
  it("no network call was made, and the trap really traps (positive control)", () => {
    expect(networkCalls).toEqual([]);
    expect(() => fetch("https://us.i.posthog.example.invalid/flags")).toThrow(/forbidden/);
    expect(networkCalls).toHaveLength(1);
    networkCalls.length = 0;
  });
});
