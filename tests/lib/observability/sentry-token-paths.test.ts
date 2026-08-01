import { describe, expect, it } from "vitest";
import type { Breadcrumb, ErrorEvent, Event } from "@sentry/nextjs";
import {
  scrubBreadcrumb,
  scrubErrorEvent,
  scrubTransactionEvent,
  redactString,
} from "@/lib/observability/sentry-scrub";
import {
  TOKEN_ROUTE_PREFIXES,
  TOKEN_PLACEHOLDER,
  canonicalizeTokenPaths,
} from "@/lib/security/token-routes";

// F-PRIV-001 — bearer credentials in token-bearing URL PATHS must never reach
// Sentry.
//
// The pre-existing scrubbers already handled query strings, cookies, headers,
// emails, phones, JWTs, `Bearer ` prefixes and Supabase token shapes. None of
// those can see an ARBITRARY OPAQUE credential sitting in a path segment:
// /intake/9f3a...  is not JWT-shaped, carries no `Bearer ` prefix, and is not
// PII, so every existing pattern passes it straight through.
//
// The oracle throughout is deliberately brutal: serialize the ENTIRE scrubbed
// event and assert the raw canary appears nowhere in it. That catches a leak in
// any field, including ones added to Sentry's schema after this was written.

// Synthetic canaries. High-entropy, obviously fake, never a real credential.
// One per route family so a failure names the family that leaked.
const CANARY: Record<string, string> = {
  "/portal/verify": "CANARYPORTALq7Wm2xR8vLbT4nZpK6sJdH3gYcF9eA",
  "/cancel": "CANARYCANCEL5tGvB1nMxQ7wZrY2kLpD8fJsH4cVeR",
  "/reschedule": "CANARYRESCHED3hNbV6yTgC9mXwQ2dLpF7kJrZ8sYe",
  "/manage": "CANARYMANAGE8jKdP4vNbG2xTwR7mLqY5hZcF1sVeB",
  "/intake": "CANARYINTAKE6wRfT9pLmX3nQbV8kYdH2jZsG5cAeN",
  "/calendar-feed": "CANARYFEED2mQxJ7bWvD4tNpL9gYkR6hZfC3sVeA8u",
};

const ALL_CANARIES = Object.values(CANARY);

/** The real oracle: nothing token-derived survives anywhere in the payload. */
function expectNoCanary(payload: unknown, note: string) {
  const serialized = JSON.stringify(payload);
  for (const canary of ALL_CANARIES) {
    expect(serialized, `${note}: raw canary survived`).not.toContain(canary);
    // No prefix/suffix fingerprint either — a head or tail of a bearer token is
    // a brute-force head start, not a redaction.
    expect(serialized, `${note}: canary prefix survived`).not.toContain(
      canary.slice(0, 12),
    );
    expect(serialized, `${note}: canary suffix survived`).not.toContain(
      canary.slice(-12),
    );
  }
}

function errorEvent(over: Partial<ErrorEvent> = {}): ErrorEvent {
  return { event_id: "e1", ...over } as ErrorEvent;
}

describe("F-PRIV-001 A. request.url — every route family, every URL form", () => {
  for (const prefix of TOKEN_ROUTE_PREFIXES) {
    const token = CANARY[prefix];
    const forms = [
      `https://hone.care${prefix}/${token}`,
      `${prefix}/${token}`,
      `https://hone.care${prefix}/${token}?utm=email&x=1`,
      `https://hone.care${prefix}/${token}#section`,
      `https://hone.care${prefix}/${token}?a=1#frag`,
      `${prefix}/${token}/`,
      `${prefix}/${token}/step/2/confirm`,
      `${prefix}/${encodeURIComponent(token)}`,
      `${prefix}/${token}.json`,
    ];
    for (const url of forms) {
      it(`${prefix} :: request.url :: ${url.slice(0, 46)}`, () => {
        const out = scrubErrorEvent(errorEvent({ request: { url } }));
        expectNoCanary(out, `request.url ${url}`);
        // Diagnostics are PRESERVED: the route family still identifies where.
        expect(String(out.request?.url)).toContain(prefix);
        expect(String(out.request?.url)).toContain(TOKEN_PLACEHOLDER);
        // Query and fragment are gone with the credential.
        expect(String(out.request?.url)).not.toContain("?");
        expect(String(out.request?.url)).not.toContain("#");
      });
    }
  }
});

describe("F-PRIV-001 B. event.transaction — the surface with NO prior scrub", () => {
  for (const prefix of TOKEN_ROUTE_PREFIXES) {
    const token = CANARY[prefix];
    for (const transaction of [
      `${prefix}/${token}`,
      `https://hone.care${prefix}/${token}`,
      `GET ${prefix}/${token}`,
      `POST ${prefix}/${token}`,
      `GET ${prefix}/${token}/step/2`,
    ]) {
      it(`${prefix} :: transaction :: ${transaction.slice(0, 42)}`, () => {
        const err = scrubErrorEvent(errorEvent({ transaction }));
        expectNoCanary(err, `error transaction ${transaction}`);
        const txn = scrubTransactionEvent({
          type: "transaction",
          transaction,
          request: { url: `https://hone.care${prefix}/${token}` },
        } as Event);
        expectNoCanary(txn, `txn transaction ${transaction}`);
        expect(String(txn.transaction)).toContain(prefix);
      });
    }
  }

  it("an HTTP method prefix is preserved — it is diagnostic, not secret", () => {
    const out = scrubErrorEvent(
      errorEvent({ transaction: `GET /intake/${CANARY["/intake"]}` }),
    );
    expect(out.transaction).toBe(`GET /intake/${TOKEN_PLACEHOLDER}`);
  });

  it("an already-safe framework template canonicalizes to the same value", () => {
    // /intake/[token] leaks nothing, but must not become a SECOND distinct
    // shape, or grouping splits and reviewers cannot tell safe from unsafe.
    expect(canonicalizeTokenPaths("/intake/[token]")).toBe(
      `/intake/${TOKEN_PLACEHOLDER}`,
    );
    expect(canonicalizeTokenPaths("/portal/verify/[token]")).toBe(
      `/portal/verify/${TOKEN_PLACEHOLDER}`,
    );
  });
});

describe("F-PRIV-001 C. breadcrumbs", () => {
  for (const prefix of TOKEN_ROUTE_PREFIXES) {
    const token = CANARY[prefix];
    it(`${prefix} :: fetch/xhr/navigation URLs and message text`, () => {
      for (const category of ["fetch", "xhr", "navigation"]) {
        const out = scrubBreadcrumb({
          category,
          data: { url: `https://hone.care${prefix}/${token}?x=1` },
        } as Breadcrumb);
        expectNoCanary(out, `${category} breadcrumb`);
      }
      const msg = scrubBreadcrumb({
        category: "navigation",
        message: `navigated to https://hone.care${prefix}/${token} ok`,
      } as Breadcrumb);
      expectNoCanary(msg, "breadcrumb message");

      const nested = scrubBreadcrumb({
        category: "ui.click",
        data: { detail: { href: `${prefix}/${token}` } },
      } as Breadcrumb);
      expectNoCanary(nested, "nested breadcrumb data");
    });
  }

  it("fetch/xhr breadcrumb URLs still lose their query and fragment", () => {
    // Token removal on this surface is defended TWICE (the explicit URL
    // sanitize, and deepScrub routing every string through redactString), so a
    // token canary cannot prove the explicit call is doing anything. Its
    // unique contribution is stripping query/fragment from ORDINARY URLs —
    // Supabase/Stripe filters embed identifiers there. Asserted directly so
    // removing that call is caught.
    for (const category of ["fetch", "xhr"]) {
      const out = scrubBreadcrumb({
        category,
        data: { url: "https://hone.care/api/records?client=abc123&q=z#frag" },
      } as Breadcrumb);
      const url = String((out?.data as Record<string, unknown>)?.url);
      expect(url).toBe("https://hone.care/api/records");
      expect(url).not.toContain("?");
      expect(url).not.toContain("#");
      expect(url).not.toContain("abc123");
    }
  });

  it("breadcrumbs attached to an event are scrubbed too", () => {
    const out = scrubErrorEvent(
      errorEvent({
        breadcrumbs: TOKEN_ROUTE_PREFIXES.map((p) => ({
          category: "fetch",
          data: { url: `https://hone.care${p}/${CANARY[p]}` },
        })),
      }),
    );
    expectNoCanary(out, "in-event breadcrumbs");
  });
});

describe("F-PRIV-001 D. errors, spans and recursive containers", () => {
  for (const prefix of TOKEN_ROUTE_PREFIXES) {
    const token = CANARY[prefix];
    const url = `https://hone.care${prefix}/${token}`;
    it(`${prefix} :: message, exception, extra, contexts, tags`, () => {
      const out = scrubErrorEvent(
        errorEvent({
          message: `failed to load ${url}`,
          exception: { values: [{ type: "Error", value: `404 at ${url}` }] },
          extra: { requested: url, nested: { deep: [{ href: url }] } },
          contexts: { custom: { link: url } },
          tags: { route: url },
        }),
      );
      expectNoCanary(out, `error surfaces ${prefix}`);
    });

    it(`${prefix} :: span description and span data`, () => {
      const out = scrubTransactionEvent({
        type: "transaction",
        spans: [
          { description: `GET ${url}`, data: { "http.url": url } },
        ] as unknown as Event["spans"],
      } as Event);
      expectNoCanary(out, `span surfaces ${prefix}`);
    });
  }
});

describe("F-PRIV-001 E. credential shapes — independence from token syntax", () => {
  // The defect is precisely that the old value patterns only knew STRUCTURED
  // credentials. These are all opaque.
  const shapes: Record<string, string> = {
    base64url: "aGVsbG8td29ybGQtdG9rZW4tdmFsdWU_LWFiYw",
    uuid: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    "dotted non-JWT": "abc.def.ghi",
    "percent encoded": "tok%2Fen%3Dvalue%2Bhere",
    "mixed case": "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "long random": "z".repeat(180),
    short: "a1b2",
    punctuation: "tok~en_val-ue.seg",
  };
  for (const [name, token] of Object.entries(shapes)) {
    it(`opaque credential shape: ${name}`, () => {
      for (const prefix of TOKEN_ROUTE_PREFIXES) {
        const out = scrubErrorEvent(
          errorEvent({
            request: { url: `https://hone.care${prefix}/${token}?q=1` },
            transaction: `GET ${prefix}/${token}`,
          }),
        );
        expect(JSON.stringify(out), `${name} @ ${prefix}`).not.toContain(token);
        expect(String(out.request?.url)).toBe(
          `https://hone.care${prefix}/${TOKEN_PLACEHOLDER}`,
        );
      }
    });
  }
});

describe("F-PRIV-001 F. non-regression — diagnostics stay useful", () => {
  it("ordinary routes keep their identifiers", () => {
    for (const url of [
      "https://hone.care/dashboard",
      "https://hone.care/calendar/appt-8821",
      "https://hone.care/clients/client-4471",
      "https://hone.care/api/records",
      "https://hone.care/intake-forms/list", // sibling: NOT a token route
    ]) {
      expect(canonicalizeTokenPaths(url)).toBe(url);
    }
  });

  it("existing email / JWT / Bearer / Supabase / phone redaction still works", () => {
    expect(redactString("mail chloe@example.com here")).not.toContain(
      "chloe@example.com",
    );
    expect(
      redactString("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk"),
    ).toContain(TOKEN_PLACEHOLDER);
    expect(redactString("Authorization: Bearer abc123def")).not.toContain(
      "abc123def",
    );
    expect(redactString("sb-abcdef-auth-token")).toContain(TOKEN_PLACEHOLDER);
    expect(redactString("call 416 555 1234 now")).not.toContain("416 555 1234");
  });

  it("cookies, headers and query strings are still removed", () => {
    const out = scrubErrorEvent(
      errorEvent({
        request: {
          url: "https://hone.care/dashboard?q=secret",
          cookies: { sb: "x" },
          headers: { authorization: "Bearer x" },
          query_string: "q=secret",
        },
      }),
    );
    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.headers).toBeUndefined();
    expect(out.request?.query_string).toBeUndefined();
    expect(String(out.request?.url)).not.toContain("secret");
  });

  it("console breadcrumbs are still dropped entirely", () => {
    expect(scrubBreadcrumb({ category: "console", message: "x" })).toBeNull();
  });
});

describe("F-PRIV-001 G. idempotence", () => {
  it("scrubbing twice equals scrubbing once, for every family and surface", () => {
    for (const prefix of TOKEN_ROUTE_PREFIXES) {
      const token = CANARY[prefix];
      const url = `https://hone.care${prefix}/${token}?a=1#f`;
      const build = () =>
        errorEvent({
          message: `at ${url}`,
          transaction: `GET ${prefix}/${token}`,
          request: { url },
          extra: { url },
        });
      const once = scrubErrorEvent(build());
      const twice = scrubErrorEvent(scrubErrorEvent(build()));
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
      expect(canonicalizeTokenPaths(canonicalizeTokenPaths(url))).toBe(
        canonicalizeTokenPaths(url),
      );
    }
  });
});

describe("F-PRIV-001 H. generated-token matrix (deterministic)", () => {
  // Bounded, seeded, reproducible in CI — no Math.random.
  const ALPHABET =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~";
  function generated(seed: number): string {
    // Deterministic LCG. Same sequence on every machine and every run.
    let state = (seed * 1103515245 + 12345) >>> 0;
    const len = 8 + (seed % 56);
    let out = "";
    for (let i = 0; i < len; i += 1) {
      state = (state * 1103515245 + 12345) >>> 0;
      out += ALPHABET[(state >>> 16) % ALPHABET.length];
    }
    return out;
  }

  it("100+ generated credentials never survive any surface, and never throw", () => {
    let checked = 0;
    for (let seed = 1; seed <= 120; seed += 1) {
      const token = generated(seed);
      const prefix = TOKEN_ROUTE_PREFIXES[seed % TOKEN_ROUTE_PREFIXES.length];
      const url = `https://hone.care${prefix}/${token}?s=${seed}#f`;
      const out = scrubTransactionEvent({
        type: "transaction",
        transaction: `GET ${prefix}/${token}`,
        request: { url },
        message: `span for ${url}`,
        extra: { deep: { href: url } },
        spans: [
          { description: `GET ${url}`, data: { "http.url": url } },
        ] as unknown as Event["spans"],
      } as Event);
      const serialized = JSON.stringify(out);
      expect(serialized, `seed ${seed}`).not.toContain(token);
      if (token.length >= 10) {
        expect(serialized, `seed ${seed} prefix`).not.toContain(
          token.slice(0, 8),
        );
        expect(serialized, `seed ${seed} suffix`).not.toContain(
          token.slice(-8),
        );
      }
      // Route family remains visible for diagnostics.
      expect(String(out.transaction)).toContain(prefix);
      checked += 1;
    }
    expect(checked).toBe(120);
  });

  it("malformed and hostile inputs do not throw", () => {
    for (const bad of [
      "/intake/",
      "/intake",
      "http://[::1/intake/x",
      "not a url at all",
      "/intake/%",
      "/intake/" + "%".repeat(50),
      "://///intake/x",
      "",
    ]) {
      expect(() => canonicalizeTokenPaths(bad)).not.toThrow();
      expect(() => redactString(bad)).not.toThrow();
    }
  });
});

describe("F-PRIV-001 I. no token-derived hash or fingerprint is emitted", () => {
  it("the placeholder is a fixed constant, identical for every credential", () => {
    const a = canonicalizeTokenPaths(`/intake/${"A".repeat(40)}`);
    const b = canonicalizeTokenPaths(`/intake/${"B".repeat(40)}`);
    // Two different credentials produce the SAME output: no correlatable
    // identifier, so telemetry cannot be used to track or brute-force a token.
    expect(a).toBe(b);
    expect(a).toBe(`/intake/${TOKEN_PLACEHOLDER}`);
  });
});
