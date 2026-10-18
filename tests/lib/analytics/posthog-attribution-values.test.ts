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
