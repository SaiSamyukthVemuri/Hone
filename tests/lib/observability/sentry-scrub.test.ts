import { afterEach, describe, expect, it, vi } from "vitest";
import type { Breadcrumb, ErrorEvent, Event } from "@sentry/nextjs";
import {
  redactString,
  scrubBreadcrumb,
  scrubErrorEvent,
  scrubTransactionEvent,
  tracesSampleRate,
} from "@/lib/observability/sentry-scrub";

const REDACTED = "[Redacted]";

describe("redactString (value patterns)", () => {
  it("redacts emails, JWTs, bearer tokens, supabase tokens and phone numbers", () => {
    expect(redactString("ping jane.doe@example.com now")).toBe(
      "ping [Redacted] now",
    );
    expect(
      redactString("Authorization: Bearer eyJhbGciOi.payload.sig123"),
    ).not.toContain("eyJhbGci");
    expect(redactString("token=eyJabc.defghi.jklmno end")).toContain(
      "[Redacted]",
    );
    expect(redactString("cookie sb-abcref-auth-token=zzz")).toContain(
      "[Redacted]",
    );
    expect(redactString("call +1 (415) 555-2671 today")).toContain(
      "[Redacted]",
    );
  });

  it("preserves ordinary diagnostic text and short numbers", () => {
    expect(redactString("Timeout after 30000ms in handler")).toBe(
      "Timeout after 30000ms in handler",
    );
    expect(redactString("HTTP 500 on /api/records")).toBe(
      "HTTP 500 on /api/records",
    );
  });
});

describe("scrubErrorEvent", () => {
  function baseEvent(): ErrorEvent {
    return {
      type: undefined,
      extra: {
        client_name: "Jane Doe",
        treatment_note: "3 areas, sensitive reaction",
        probe_intensity: "F3",
        reaction_history: ["erythema"],
        email: "jane@example.com",
        phone: "+1 415 555 2671",
        access_token: "eyJx.y.z",
        nested: { first_name: "Jane", harmless: "keep-me" },
      },
      tags: { studio: "ok", user_email: "jane@example.com" },
      user: {
        id: "user-uuid",
        email: "jane@example.com",
        username: "jane",
        ip_address: "203.0.113.7",
      },
      contexts: {
        os: { name: "macOS", version: "14.4" },
        device: { name: "Jane's iPhone", family: "iPhone" },
        clientRecord: { client_name: "Jane Doe", note: "clinical detail" },
      },
      request: {
        url: "https://hone.care/records?email=jane@example.com",
        method: "POST",
        cookies: "sb-ref-auth-token=zzz",
        headers: { authorization: "Bearer eyJx.y.z" },
        query_string: "email=jane@example.com",
        data: { client_name: "Jane", probe: "F3", ok: "value" },
      },
      exception: {
        values: [
          {
            type: "Error",
            value: "Failed to save note for jane@example.com token eyJa.bc.def",
          },
        ],
      },
      breadcrumbs: [
        { category: "console", message: "client Jane Doe record" },
        {
          category: "fetch",
          data: {
            url: "https://ref.supabase.co/rest/v1/clients?phone=eq.4155552671",
            method: "GET",
          },
        },
      ],
    } as unknown as ErrorEvent;
  }

  it("redacts sensitive keys in extra (including nested) but keeps harmless values", () => {
    const e = scrubErrorEvent(baseEvent());
    const extra = e.extra as Record<string, unknown>;
    expect(extra.client_name).toBe(REDACTED);
    expect(extra.treatment_note).toBe(REDACTED);
    expect(extra.probe_intensity).toBe(REDACTED);
    expect(extra.reaction_history).toBe(REDACTED);
    expect(extra.email).toBe(REDACTED);
    expect(extra.phone).toBe(REDACTED);
    expect(extra.access_token).toBe(REDACTED);
    const nested = extra.nested as Record<string, unknown>;
    expect(nested.first_name).toBe(REDACTED);
    expect(nested.harmless).toBe("keep-me");
  });

  it("redacts legal-name keys in every spelling (HON-58)", () => {
    const e = scrubErrorEvent({
      type: undefined,
      extra: {
        legal_name: "Jane Doe",
        legalName: "Jane Doe",
        nested: { "legal-name": "Jane Doe", LEGAL_NAME: "Jane Doe", legal: "keep-me" },
      },
    } as unknown as ErrorEvent);
    const extra = e.extra as Record<string, unknown>;
    expect(extra.legal_name).toBe(REDACTED);
    expect(extra.legalName).toBe(REDACTED);
    const nested = extra.nested as Record<string, unknown>;
    expect(nested["legal-name"]).toBe(REDACTED);
    expect(nested.LEGAL_NAME).toBe(REDACTED);
    expect(nested.legal).toBe("keep-me");
  });

  it("scrubs tags by key and value pattern", () => {
    const e = scrubErrorEvent(baseEvent());
    const tags = e.tags as Record<string, unknown>;
    expect(tags.user_email).toBe(REDACTED);
    expect(tags.studio).toBe("ok");
  });

  it("strips PII from the user object but keeps the opaque id", () => {
    const e = scrubErrorEvent(baseEvent());
    const user = e.user as Record<string, unknown>;
    expect(user.email).toBeUndefined();
    expect(user.username).toBeUndefined();
    expect(user.ip_address).toBeUndefined();
    expect(user.id).toBe("user-uuid");
  });

  it("key-scrubs custom contexts, drops device.name, but preserves standard context fields", () => {
    const e = scrubErrorEvent(baseEvent());
    const contexts = e.contexts as Record<string, Record<string, unknown>>;
    expect(contexts.os.name).toBe("macOS"); // standard context not key-redacted
    expect(contexts.device.name).toBeUndefined(); // owner name dropped
    expect(contexts.device.family).toBe("iPhone");
    expect(contexts.clientRecord.client_name).toBe(REDACTED);
    expect(contexts.clientRecord.note).toBe(REDACTED);
  });

  it("removes cookies/headers/query_string and strips the request url query", () => {
    const e = scrubErrorEvent(baseEvent());
    const req = e.request as Record<string, unknown>;
    expect(req.cookies).toBeUndefined();
    expect(req.headers).toBeUndefined();
    expect(req.query_string).toBeUndefined();
    expect(req.url).toBe("https://hone.care/records");
    const data = req.data as Record<string, unknown>;
    expect(data.client_name).toBe(REDACTED);
    expect(data.probe).toBe(REDACTED);
    expect(data.ok).toBe("value");
  });

  it("redacts secrets embedded in the exception message but keeps the error text", () => {
    const e = scrubErrorEvent(baseEvent());
    const value = e.exception?.values?.[0]?.value ?? "";
    expect(value).toContain("Failed to save note for");
    expect(value).not.toContain("jane@example.com");
    expect(value).not.toContain("eyJa.bc.def");
  });

  it("drops console breadcrumbs and strips network breadcrumb query strings", () => {
    const e = scrubErrorEvent(baseEvent());
    const crumbs = e.breadcrumbs ?? [];
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0].category).toBe("fetch");
    expect(crumbs[0].data?.url).toBe(
      "https://ref.supabase.co/rest/v1/clients",
    );
  });
});

describe("legal and preferred name keys (HON-58)", () => {
  it("redacts legal-name keys in every spelling a legal-identity field would use", () => {
    const e = scrubErrorEvent({
      type: undefined,
      extra: {
        legal_name: "Synthetic Legal",
        legalName: "Synthetic Legal",
        "legal-name": "Synthetic Legal",
        legal_given_name: "Synthetic",
        legal_family_name: "Legal",
        preferred_name: "Syn",
        legal_status: "keep-me",
      },
    } as ErrorEvent);
    const extra = e.extra as Record<string, unknown>;
    expect(extra.legal_name).toBe(REDACTED);
    expect(extra.legalName).toBe(REDACTED);
    expect(extra["legal-name"]).toBe(REDACTED);
    expect(extra.legal_given_name).toBe(REDACTED);
    expect(extra.legal_family_name).toBe(REDACTED);
    expect(extra.preferred_name).toBe(REDACTED);
    expect(extra.legal_status).toBe("keep-me");
  });
});

describe("scrubBreadcrumb", () => {
  it("drops console breadcrumbs entirely", () => {
    const b: Breadcrumb = { category: "console", message: "leak client Jane" };
    expect(scrubBreadcrumb(b)).toBeNull();
  });

  it("strips query strings and scrubs data on fetch breadcrumbs", () => {
    const b: Breadcrumb = {
      category: "fetch",
      data: {
        url: "https://ref.supabase.co/rest/v1/clients?email=eq.a@b.com",
        access_token: "eyJx.y.z",
      },
    };
    const out = scrubBreadcrumb(b);
    expect(out?.data?.url).toBe("https://ref.supabase.co/rest/v1/clients");
    expect(out?.data?.access_token).toBe(REDACTED);
  });

  it("passes ordinary breadcrumbs through with value scrubbing", () => {
    const b: Breadcrumb = { category: "ui.click", message: "clicked Save" };
    expect(scrubBreadcrumb(b)?.message).toBe("clicked Save");
  });
});

describe("scrubTransactionEvent", () => {
  it("redacts span descriptions and span data, and drops request PII", () => {
    const tx = {
      spans: [
        {
          description: "SELECT * FROM clients WHERE email = 'jane@example.com'",
          data: { "db.statement": "x", access_token: "eyJx.y.z" },
        },
      ],
      request: { cookies: "sb-ref-auth-token=zzz", url: "https://h/x?q=1" },
    } as unknown as Event;
    const out = scrubTransactionEvent(tx);
    const span = out.spans?.[0] as unknown as Record<string, unknown>;
    expect(span.description).not.toContain("jane@example.com");
    expect((span.data as Record<string, unknown>).access_token).toBe(REDACTED);
    const req = out.request as Record<string, unknown>;
    expect(req.cookies).toBeUndefined();
    expect(req.url).toBe("https://h/x");
  });
});

describe("tracesSampleRate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is 0.1 in production and 1 otherwise", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(tracesSampleRate()).toBe(0.1);
    vi.stubEnv("NODE_ENV", "development");
    expect(tracesSampleRate()).toBe(1);
  });
});

// Privacy K7-A (#1292): a typed directory search lives in the query string, and
// the generic redaction cannot tell a name from a word. Every URL-bearing Sentry
// field drops the query and fragment.
describe("a typed search term in the URL never reaches Sentry (K7-A)", () => {
  const URL_WITH_TERM = "/clients?q=jane%20smith";
  const TERM = /jane|smith/i;

  it("control: the ordinary value redaction alone does NOT remove a typed name (why the strip exists)", () => {
    expect(redactString(URL_WITH_TERM)).toMatch(TERM);
  });

  it("navigation breadcrumbs: from, to and url lose the query and fragment", () => {
    const crumb = scrubBreadcrumb({
      category: "navigation",
      data: { from: "/clients?q=jane%20smith&page=2#row", to: `${URL_WITH_TERM}&client=x`, url: URL_WITH_TERM },
    } as Breadcrumb);
    expect(JSON.stringify(crumb)).not.toMatch(TERM);
    expect(crumb!.data).toMatchObject({ from: "/clients", to: "/clients", url: "/clients" });
  });

  it("control: a non-navigation breadcrumb keeps its own fields (only the named categories change)", () => {
    const crumb = scrubBreadcrumb({ category: "ui.click", data: { target: "button#save" } } as Breadcrumb);
    expect(crumb!.data).toEqual({ target: "button#save" });
  });

  it("span URL attributes lose the query; query-only attributes are removed", () => {
    const event = scrubTransactionEvent({
      type: "transaction",
      spans: [
        {
          description: `GET ${URL_WITH_TERM}`,
          data: {
            "http.url": `https://app.example.test${URL_WITH_TERM}`,
            "url.full": `https://app.example.test${URL_WITH_TERM}#x`,
            "http.target": URL_WITH_TERM,
            "url.query": "q=jane%20smith",
            "http.query": "?q=jane%20smith",
            "http.method": "GET",
          },
        },
      ],
    } as unknown as Event);
    const span = (event.spans as unknown as Array<{ description: string; data: Record<string, unknown> }>)[0];
    expect(JSON.stringify(event)).not.toMatch(TERM);
    expect(span.description).toBe("GET /clients");
    expect(span.data["http.url"]).toBe("https://app.example.test/clients");
    expect(span.data).not.toHaveProperty("url.query");
    expect(span.data).not.toHaveProperty("http.query");
    expect(span.data["http.method"]).toBe("GET");
  });

  it("control: a SQL span description with ? placeholders is not mangled", () => {
    const event = scrubTransactionEvent({
      type: "transaction",
      spans: [{ description: "select id from clients where studio_id = ? and name = ?" }],
    } as unknown as Event);
    expect((event.spans as unknown as Array<{ description: string }>)[0].description).toBe(
      "select id from clients where studio_id = ? and name = ?",
    );
  });

  it("the transaction name loses the query (bare path and 'METHOD path')", () => {
    expect(scrubTransactionEvent({ type: "transaction", transaction: `GET ${URL_WITH_TERM}` } as Event).transaction).toBe("GET /clients");
    expect(scrubTransactionEvent({ type: "transaction", transaction: URL_WITH_TERM } as Event).transaction).toBe("/clients");
    // Control: a route-shaped name with no query is unchanged.
    expect(scrubTransactionEvent({ type: "transaction", transaction: "GET /clients" } as Event).transaction).toBe("GET /clients");
  });

  it("the request: url loses the query and fragment, query_string is removed", () => {
    const event = scrubErrorEvent({
      request: { url: `https://app.example.test${URL_WITH_TERM}#a`, query_string: "q=jane%20smith" },
    } as unknown as ErrorEvent);
    expect(JSON.stringify(event)).not.toMatch(TERM);
    expect((event.request as { url: string }).url).toBe("https://app.example.test/clients");
    expect(event.request).not.toHaveProperty("query_string");
  });
});
