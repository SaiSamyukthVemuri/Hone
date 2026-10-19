import { describe, expect, it, vi } from "vitest";

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

  it("Date and URL are serialized; a custom toJSON object is not (see 4309252682 below)", () => {
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

// ===========================================================================
// Codex 4309069519 / 4309069522 (review of b9eabedd): URL-shaped values are
// sanitized AS URLs whatever their key (query and fragment dropped), and keys
// and values are judged on their DECODED text, never on a raw-text signal.
// ===========================================================================
describe("URL-shaped values and decode-first decisions", () => {
  const ENC = `%36${CLIENT.slice(1)}`; // the first hex digit percent-encoded
  // A hex digit encoded MID-UUID: no raw-text UUID survives in the key.
  const ENC_MID = CLIENT.replace("-4a5b-", "-%34a5b-");

  it("a URL INSTANCE under a non-URL key: no query, no fragment, id redacted", () => {
    const out = pageview({ link: new URL(`${HOST}/clients/${CLIENT}?email=patient@example.com#notes`) });
    const link = (out.properties as Record<string, string>).link;
    expect(link).toBe(`${HOST}/clients/[id]`);
    expect(link).not.toMatch(/[?#@]|email/);
  });

  it.each([
    ["an absolute URL string", `${HOST}/clients/${CLIENT}?email=patient@example.com#x`, `${HOST}/clients/[id]`],
    ["an app-relative path string", `/clients/${CLIENT}?email=patient@example.com`, "/clients/[id]"],
    ["a protocol-relative string", `//hone.care/clients/${CLIENT}?email=patient@example.com`, "/clients/[id]"],
    ["an encoded app path", `%2Fclients%2F${CLIENT}%3Femail%3Dp%40e.com`, "/clients/[id]"],
  ])("%s under a non-URL key is sanitized as a URL", (_label, input, expected) => {
    const out = pageview({ note: input });
    const v = (out.properties as Record<string, string>).note;
    expect(v).toBe(expected);
    expect(v).not.toMatch(/[?#@]|email/);
  });

  it("a KEY with an encoded hex digit in its UUID loses the id", () => {
    const out = pageview({ nested: { [`/clients/${ENC_MID}`]: 1, [ENC_MID]: 2 } });
    const keys = Object.keys((out.properties as unknown as Record<string, Record<string, number>>).nested);
    expect(UUID_ANYWHERE.test(oracleDecode(JSON.stringify(keys)))).toBe(false);
  });

  it("a VALUE with a double-encoded slash or an encoded hex digit loses the id", () => {
    const out = pageview({ a: `x%252Fclients%252F${CLIENT}`, b: `ref ${ENC}`, c: `ref ${ENC_MID}` });
    expect(UUID_ANYWHERE.test(oracleDecode(JSON.stringify(out.properties)))).toBe(false);
  });

  it("bare unencoded PostHog ids are still kept", () => {
    const own = "01928f3a-7b2c-7d4e-8f00-123456789abc";
    const p = pageview({ $session_id: own, distinct_id: own }).properties as Record<string, string>;
    expect(p.$session_id).toBe(own);
    expect(p.distinct_id).toBe(own);
  });
});

// ===========================================================================
// Codex 4309131383 (review of 0d12a8ab): a URL under a scheme other than
// http(s) is handled by what it IS, never by the shape of its text: a URL
// INSTANCE is checked before toJSON, and a non-http(s) URL string anywhere
// (any key, encoded or not) becomes the fixed "[url]" placeholder.
// ===========================================================================
describe("non-http(s) URLs fail closed to [url]", () => {
  const schemes = [
    `ftp://files.example/clients/${CLIENT}?email=patient@example.com#x`,
    "mailto:patient@example.com?subject=hi",
    `data:text/plain,client%20${CLIENT}%20patient@example.com`,
    `javascript:alert('${CLIENT}')`,
    `hone-app://open/clients/${CLIENT}?email=patient@example.com`,
    `file:///Users/x/clients/${CLIENT}.pdf`,
  ];
  const clean = (v: unknown) => {
    const text = oracleDecode(JSON.stringify(v));
    expect(UUID_ANYWHERE.test(text)).toBe(false);
    expect(text).not.toMatch(/@|email|subject|alert/);
  };

  it.each(schemes)("URL instance %s → [url] (checked before toJSON)", (raw) => {
    const out = pageview({ link: new URL(raw) });
    expect((out.properties as Record<string, unknown>).link).toBe("[url]");
    clean(out.properties);
  });

  it.each(schemes)("string %s under a non-URL key → [url]", (raw) => {
    const out = pageview({ note: raw });
    expect((out.properties as Record<string, unknown>).note).toBe("[url]");
    clean(out.properties);
  });

  it.each(schemes)("string %s under a URL key ($referrer) → [url]", (raw) => {
    const out = pageview({ $referrer: raw });
    expect((out.properties as Record<string, unknown>).$referrer).toBe("[url]");
    clean(out.properties);
  });

  it("an ENCODED non-http URL string → [url]", () => {
    const out = pageview({ note: encodeURIComponent("mailto:patient@example.com") });
    expect((out.properties as Record<string, unknown>).note).toBe("[url]");
  });

  it("ordinary values are not mistaken for URLs; http(s) URL instances still keep their shape", () => {
    const own = "01928f3a-7b2c-7d4e-8f00-123456789abc";
    const out = pageview({
      $title: "Pricing: Hone",
      $session_id: own,
      $raw_user_agent: "Mozilla/5.0 (X11; Linux x86_64)",
      when: "2026-10-18T00:00:00.000Z",
      link: new URL(`${HOST}/clients/${CLIENT}?email=x@y.z`),
    });
    const p = out.properties as Record<string, string>;
    expect(p.$title).toBe("Pricing: Hone");
    expect(p.$session_id).toBe(own);
    expect(p.$raw_user_agent).toBe("Mozilla/5.0 (X11; Linux x86_64)");
    expect(p.when).toBe("2026-10-18T00:00:00.000Z");
    expect(p.link).toBe(`${HOST}/clients/[id]`);
  });
});

// ===========================================================================
// Codex 4309185282 (review of 3a2bbf9f): OVER-redaction. Only UNAMBIGUOUS
// non-http(s) URL strings become [url]: an authority form (scheme://) or a
// path-less data scheme (mailto:, data:, javascript:, blob:, tel:, sms:,
// file:). Any other "word:rest" string is ordinary text: kept, with record
// ids inside it redacted. PostHog's autocapture structural fields are never
// URL-classified but still lose ids. URL INSTANCES are unchanged.
// ===========================================================================
describe("only unambiguous non-http URL strings become [url]", () => {
  const chain = 'a.btn:attr__href="/pricing"attr__class="btn"nth-child="1"nth-of-type="1";div.hero:nth-child="2"';

  it("campaign values and autocapture's $elements_chain are kept as they are", () => {
    const p = pageview({ utm_campaign: "summer:sale", $elements_chain: chain, label: "plan:pro" }).properties as Record<string, string>;
    expect(p.utm_campaign).toBe("summer:sale");
    expect(p.$elements_chain).toBe(chain);
    expect(p.label).toBe("plan:pro");
  });

  it("an id inside a word:rest string or the elements chain is still redacted, shape kept", () => {
    const p = pageview({
      note: `word:${CLIENT}`,
      utm_campaign: `summer:${CLIENT}`,
      $elements_chain: `a:attr__href="/clients/${CLIENT}"nth-child="1"`,
    }).properties as Record<string, string>;
    expect(p.note).toBe("word:[id]");
    expect(p.utm_campaign).toBe("summer:[id]");
    expect(p.$elements_chain).toBe('a:attr__href="/clients/[id]"nth-child="1"');
  });

  it.each([
    `ftp://files.example/clients/${CLIENT}?email=patient@example.com`,
    "mailto:patient@example.com",
    "data:text/plain,hello",
    "javascript:void(0)",
    "blob:https://hone.care/0b1c2d3e",
    "tel:+15555550100",
    "sms:+15555550100",
    "custom-app://open/x?email=patient@example.com",
  ])("%s is still [url]", (raw) => {
    expect((pageview({ note: raw }).properties as Record<string, string>).note).toBe("[url]");
  });

  it("URL INSTANCES under any scheme are unchanged: non-http(s) still [url]", () => {
    const p = pageview({ a: new URL("custom:summer"), b: new URL("mailto:x@y.z") }).properties as Record<string, string>;
    expect(p.a).toBe("[url]");
    expect(p.b).toBe("[url]");
  });
});

// ===========================================================================
// Codex 4309252679 (review of 0f1aa9f1): http(s) URLs are recognised by
// PARSING, as a browser would, never by a textual prefix. Leading whitespace
// or control characters, backslash separators, a missing "//" or an embedded
// newline still make an http(s) URL, so the query (?email=…) is dropped and
// the path's ids redacted. WHATWG-special non-http schemes (ftp, ws, wss,
// file) with backslashes are [url].
// ===========================================================================
describe("http(s) URL strings are classified by parsing, not by prefix", () => {
  it.each([
    ` https:\\\\hone.care\\clients\\${CLIENT}?email=patient@example.com`,
    `\thttps://hone.care/clients/${CLIENT}?email=patient@example.com`,
    `\u0000https://hone.care/clients/${CLIENT}?email=patient@example.com`,
    `https:hone.care/clients/${CLIENT}?email=patient@example.com`,
    `HTTPS:\\\\hone.care/clients/${CLIENT}?email=patient@example.com`,
    `ht\ntps://hone.care/clients/${CLIENT}?email=patient@example.com`,
    ` https:%5C%5Chone.care%5Cclients%5C${CLIENT}%3Femail%3Dpatient%40example.com`,
  ])("%j loses its query and its id", (raw) => {
    const note = (pageview({ note: raw }).properties as Record<string, string>).note;
    expect(note).not.toContain("email");
    expect(note).not.toContain("patient");
    expect(note).not.toContain(CLIENT);
    expect(note).toBe("https://hone.care/clients/[id]");
  });

  it.each([
    ` /clients/${CLIENT}?email=patient@example.com`,
    `\\clients\\${CLIENT}?email=patient@example.com`,
  ])("app-relative %j loses its query and its id", (raw) => {
    const note = (pageview({ note: raw }).properties as Record<string, string>).note;
    expect(note).toBe("/clients/[id]");
  });

  it("the same variants under a URL key ($referrer) lose the query too", () => {
    const p = pageview({ $referrer: ` https:\\\\hone.care\\clients\\${CLIENT}?email=patient@example.com` })
      .properties as Record<string, string>;
    expect(p.$referrer).toBe("https://hone.care/clients/[id]");
  });

  it.each([
    "ftp:\\\\files.example\\x?email=patient@example.com",
    " wss:\\\\socket.example\\x?email=patient@example.com",
  ])("WHATWG-special non-http %j is [url]", (raw) => {
    expect((pageview({ note: raw }).properties as Record<string, string>).note).toBe("[url]");
  });

  it("ordinary values are still not URLs", () => {
    const p = pageview({ utm_campaign: "summer:sale", note: "localhost:3000" }).properties as Record<string, string>;
    expect(p.utm_campaign).toBe("summer:sale");
    expect(p.note).toBe("localhost:3000");
  });
});

// ===========================================================================
// Codex 4309252682 (review of 0f1aa9f1): only Date and URL are serialized. An
// unknown class or object with a toJSON can serialize hidden state, so it
// becomes [unsupported] and its toJSON is never invoked.
// ===========================================================================
describe("object serialization avoids overridden methods", () => {
  it("ignores own and subclass Date serialization overrides", () => {
    const iso = "2026-10-18T00:00:00.000Z";
    const override = vi.fn(() => "patient@example.com");
    const own = new Date(iso);
    own.toISOString = override;
    own.getTime = override as unknown as () => number;
    class CustomDate extends Date {
      toISOString() { return override(); }
      getTime() { override(); return 0; }
    }
    const p = pageview({ own, subclass: new CustomDate(iso), invalid: new Date(NaN) }).properties;
    expect(p).toMatchObject({ own: iso, subclass: iso, invalid: null });
    expect(override).not.toHaveBeenCalled();
  });

  it("reads URL internal state without own or subclass accessors", () => {
    const href = vi.fn(() => `${HOST}/patient@example.com`);
    const protocol = vi.fn(() => "mailto:");
    const raw = `${HOST}/clients/${CLIENT}?email=patient@example.com#notes`;
    const own = new URL(raw);
    Object.defineProperties(own, { href: { get: href }, protocol: { get: protocol } });
    class CustomURL extends URL {
      get href() { return href(); }
      get protocol() { return protocol(); }
    }
    const p = pageview({ own, subclass: new CustomURL(raw), nonHttp: new CustomURL("mailto:patient@example.com") }).properties;
    expect(p).toMatchObject({ own: `${HOST}/clients/[id]`, subclass: `${HOST}/clients/[id]`, nonHttp: "[url]" });
    expect(href).not.toHaveBeenCalled();
    expect(protocol).not.toHaveBeenCalled();
  });

  it("an unknown class with toJSON over hidden state is [unsupported], toJSON not called", () => {
    const toJSON = vi.fn(function (this: { secret: string }) { return { email: this.secret }; });
    class Hidden {
      #email = "patient@example.com";
      get secret() { return this.#email; }
      toJSON = toJSON;
    }
    const out = pageview({ hidden: new Hidden() });
    expect((out.properties as Record<string, unknown>).hidden).toBe("[unsupported]");
    expect(toJSON).not.toHaveBeenCalled();
    expect(JSON.stringify(out.properties)).not.toContain("patient");
  });

  it("a prototype toJSON on a class is not called either", () => {
    const spy = vi.fn(() => ({ email: "patient@example.com" }));
    class Proto { toJSON() { return spy(); } }
    const out = pageview({ v: new Proto() });
    expect((out.properties as Record<string, unknown>).v).toBe("[unsupported]");
    expect(spy).not.toHaveBeenCalled();
  });

  it("a plain object carrying a toJSON is [unsupported], toJSON not called", () => {
    const toJSON = vi.fn(() => ({ email: "patient@example.com" }));
    const out = pageview({ v: { toJSON } });
    expect((out.properties as Record<string, unknown>).v).toBe("[unsupported]");
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("Date is still serialized through intrinsics (a toJSON override is ignored)", () => {
    const d = new Date("2026-10-18T00:00:00.000Z");
    const override = vi.fn(() => "patient@example.com");
    (d as unknown as { toJSON: () => string }).toJSON = override;
    const p = pageview({ when: new Date("2026-10-18T00:00:00.000Z"), overridden: d }).properties as Record<string, unknown>;
    expect(p.when).toBe("2026-10-18T00:00:00.000Z");
    expect(p.overridden).toBe("2026-10-18T00:00:00.000Z");
    expect(override).not.toHaveBeenCalled();
  });

  it("plain objects and arrays keep the normal recursion", () => {
    const p = pageview({ obj: { a: `/clients/${CLIENT}` }, arr: [`/clients/${CLIENT}`, "ok"] })
      .properties as Record<string, unknown>;
    expect(p.obj).toEqual({ a: "/clients/[id]" });
    expect(p.arr).toEqual(["/clients/[id]", "ok"]);
  });
});
