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
