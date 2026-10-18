import { describe, expect, it } from "vitest";

import { guardBrowserEvent } from "@/lib/analytics/client-boundary";

// ===========================================================================
// #828 G-07/G-26 (Codex P1 4309025843, raised on #931): retained attribution
// VALUES carry no record id.
//
// Marketing URLs keep the reviewed utm_* params, and posthog-js ALSO copies
// campaign params into standalone event properties (utm_campaign,
// $initial_utm_campaign, $session_entry_utm_campaign, gclid, ...). Both kept
// the value verbatim, so `?utm_campaign=<uuid>` (or a click-id param carrying
// one) reached PostHog. Now a record id inside a retained value is replaced
// with [id], decoded to a fixed point first; the rest of the value is kept.
// All ids are SYNTHETIC.
// ===========================================================================

const CLIENT = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const HOST = "https://hone.care";
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function oracleDecode(text: string): string {
  let cur = text;
  for (let i = 0; i < 16; i += 1) {
    const next = cur.replace(/%([0-7][0-9a-f])/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

function pageview(props: Record<string, unknown>) {
  return guardBrowserEvent({ event: "$pageview", properties: { $current_url: `${HOST}/pricing`, ...props } })!;
}

describe("utm_* values inside retained URLs", () => {
  it.each(UTM_KEYS)("%s=<uuid> in $current_url and $referrer: the id becomes [id], the param is kept", (key) => {
    const out = pageview({
      $current_url: `${HOST}/pricing?${key}=spring-${CLIENT}`,
      $referrer: `${HOST}/pricing?${key}=${CLIENT.replace(/-/g, "%2D")}`,
    });
    const p = out.properties as Record<string, string>;
    expect(new URL(p.$current_url).searchParams.get(key)).toBe("spring-[id]");
    expect(new URL(p.$referrer).searchParams.get(key)).toBe("[id]");
    expect(UUID_ANYWHERE.test(oracleDecode(JSON.stringify(p)))).toBe(false);
  });

  it("non-id utm values are unchanged", () => {
    const url = `${HOST}/pricing?utm_source=newsletter&utm_campaign=spring%202026&utm_content=hero-cta`;
    const out = pageview({ $current_url: url });
    expect((out.properties as Record<string, string>).$current_url).toBe(url.replace("%20", "+"));
  });
});

describe("standalone campaign properties posthog-js copies into the event", () => {
  const keys = [
    ...UTM_KEYS,
    ...UTM_KEYS.map((k) => `$initial_${k}`),
    ...UTM_KEYS.map((k) => `$session_entry_${k}`),
    "gclid",
    "fbclid",
    "msclkid",
    "$initial_gclid",
  ];

  it.each(keys)("%s=<uuid>: the id becomes [id]", (key) => {
    const out = pageview({ [key]: `a ${CLIENT} b` });
    expect((out.properties as Record<string, string>)[key]).toBe("a [id] b");
  });

  it("the same keys in $set_once", () => {
    const out = guardBrowserEvent({
      event: "$pageview",
      properties: { $current_url: `${HOST}/pricing` },
      $set_once: { $initial_utm_campaign: CLIENT, $initial_gclid: CLIENT },
    })!;
    expect(out.$set_once).toEqual({ $initial_utm_campaign: "[id]", $initial_gclid: "[id]" });
  });

  it("non-id campaign values are unchanged, and PostHog's own ids are kept", () => {
    const own = "01928f3a-7b2c-7d4e-8f00-123456789abc";
    const out = pageview({ utm_campaign: "spring 2026", gclid: "Cj0KCQjw-synthetic", $session_id: own, distinct_id: own });
    const p = out.properties as Record<string, string>;
    expect(p.utm_campaign).toBe("spring 2026");
    expect(p.gclid).toBe("Cj0KCQjw-synthetic");
    expect(p.$session_id).toBe(own);
    expect(p.distinct_id).toBe(own);
  });

  it("an undecodable or over-encoded value fails closed to [token]", () => {
    const p = pageview({ utm_campaign: "%E0%A4%A", utm_term: "%2525252525252D" }).properties as Record<string, string>;
    expect(p.utm_campaign).toBe("[token]");
    expect(p.utm_term).toBe("[token]");
  });
});

describe("repeat calls stay correct (no global-regex lastIndex carry-over)", () => {
  it("redacts the same shape every time", async () => {
    const { redactIdsInValue } = await import("@/lib/analytics/path-ids");
    for (let i = 0; i < 5; i += 1) expect(redactIdsInValue(`x ${CLIENT}`)).toBe("x [id]");
  });
});

// ===========================================================================
// Codex 4309044244: nothing passes through sanitizeProps unexamined. An
// over-depth container used to be returned AS IS, so a nested URL property
// (patient_url: "/clients/<uuid>") reached PostHog raw.
// ===========================================================================
describe("sanitizeProps fails closed on every branch", () => {
  function nest(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
    let v: Record<string, unknown> = leaf;
    for (let i = 0; i < depth; i += 1) v = { level: v };
    return v;
  }
  const leakFree = (v: unknown) => expect(UUID_ANYWHERE.test(oracleDecode(JSON.stringify(v ?? null)))).toBe(false);

  it.each([9, 10, 15])("a URL key nested %i levels deep is never delivered raw", (depth) => {
    const out = pageview({ custom: nest(depth, { patient_url: `/clients/${CLIENT}` }) });
    leakFree(out.properties);
    expect(JSON.stringify(out.properties)).toContain("[depth-limited]");
  });

  it("an array of objects deep in the tree is depth-limited too", () => {
    const out = pageview({ list: nest(8, { items: [{ patient_url: `/clients/${CLIENT}` }] }) });
    leakFree(out.properties);
  });

  it("toJSON objects are sanitized as what they serialize to (URL, custom)", () => {
    const out = pageview({
      when: new Date("2026-10-18T00:00:00.000Z"),
      link: new URL(`${HOST}/clients/${CLIENT}`),
      custom: { toJSON: () => ({ patient_url: `/clients/${CLIENT}` }) },
    });
    const p = out.properties as Record<string, unknown>;
    expect(p.when).toBe("2026-10-18T00:00:00.000Z");
    leakFree(p);
  });

  it("Map, Set and class instances become [unsupported]; bigint, symbol and functions are dropped", () => {
    class Box { constructor(public url = `/clients/${CLIENT}`) {} }
    const out = pageview({
      map: new Map([["u", `/clients/${CLIENT}`]]),
      set: new Set([`/clients/${CLIENT}`]),
      box: new Box(),
      big: BigInt(42),
      sym: Symbol("x"),
      fn: () => CLIENT,
    });
    const p = out.properties as Record<string, unknown>;
    expect(p.map).toBe("[unsupported]");
    expect(p.set).toBe("[unsupported]");
    expect(p.box).toBe("[unsupported]");
    expect(p.big).toBeUndefined();
    expect(p.sym).toBeUndefined();
    expect(p.fn).toBeUndefined();
    leakFree({ ...p, big: undefined });
  });

  it("a path-like string under ANY key loses its id; bare PostHog ids are kept", () => {
    const own = "01928f3a-7b2c-7d4e-8f00-123456789abc";
    const out = pageview({ page: `/clients/${CLIENT}/sessions`, $device_id: own, $window_id: own });
    const p = out.properties as Record<string, string>;
    expect(p.page).toBe("/clients/[id]/sessions");
    expect(p.$device_id).toBe(own);
    expect(p.$window_id).toBe(own);
  });

  it("object KEYS lose record ids, collisions keep every value", () => {
    const out = pageview({ nested: { [`/clients/${CLIENT}`]: 1, [CLIENT]: 2, "[id]": 3 } });
    const nested = (out.properties as unknown as Record<string, Record<string, number>>).nested;
    expect(Object.values(nested).sort()).toEqual([1, 2, 3]);
    leakFree(Object.keys(nested));
  });
});

// Bare UUID strings under non-URL keys are KEPT because, today, every browser
// event property is generated by posthog-js itself, and its bare UUIDs are its
// own ids. Hone code makes NO custom browser capture/register/people call. This
// guard keeps that true: a new one must be reviewed for record ids first.
describe("no custom browser PostHog properties exist (the premise of keeping bare UUIDs)", () => {
  it("app/, lib/ and components/ make no posthog.capture / register / people / group / setPersonProperties call", async () => {
    const { execSync } = await import("node:child_process");
    const hits = execSync(
      "git grep -n -E 'posthog\\.(capture|register|register_once|people|group|setPersonProperties|identify)\\(' -- app lib components || true",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter((l) => l && !l.startsWith("lib/analytics/server.ts"));
    expect(hits).toEqual([]);
  });
});
