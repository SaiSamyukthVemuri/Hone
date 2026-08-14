import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createGoogleRestClient } from "@/lib/google-calendar/sync/google-rest-client";

// Phase B2.1: the fetch-only Google REST client, unit-tested against MOCKED
// HTTP only. Never a live Google call; never wired to appointments/outbox.

function mockResponse(status: number, bodyText: string, headers: Record<string, string> = {}): Response {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    text: async () => bodyText,
  } as unknown as Response;
}

const savedEnv = { ...process.env };
beforeAll(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
});
afterAll(() => {
  process.env = savedEnv;
});

describe("refreshToken", () => {
  it("success without rotation", async () => {
    const fetchImpl = vi.fn(async () => mockResponse(200, JSON.stringify({ access_token: "at1", expires_in: 3600 })));
    const client = createGoogleRestClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.refreshToken("rt1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.accessToken).toBe("at1");
      expect(r.expiresInSeconds).toBe(3600);
      expect(r.rotatedRefreshToken).toBeNull();
    }
  });

  it("success WITH rotation returns the rotated refresh token", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse(200, JSON.stringify({ access_token: "at1", expires_in: 3600, refresh_token: "rt2" })),
    );
    const client = createGoogleRestClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.refreshToken("rt1");
    expect(r.ok && r.rotatedRefreshToken).toBe("rt2");
  });

  it("400 invalid_grant classifies as invalid_grant", async () => {
    const fetchImpl = vi.fn(async () => mockResponse(400, JSON.stringify({ error: "invalid_grant" })));
    const client = createGoogleRestClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.refreshToken("rt1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("invalid_grant");
  });

  it("429 with Retry-After is rate_limited and carries the seconds", async () => {
    const fetchImpl = vi.fn(async () => mockResponse(429, JSON.stringify({ error: {} }), { "retry-after": "42" }));
    const client = createGoogleRestClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.refreshToken("rt1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("rate_limited");
      expect(r.error.retryAfterSeconds).toBe(42);
    }
  });

  it("5xx is transient; malformed body is transient", async () => {
    const c1 = createGoogleRestClient({ fetchImpl: (async () => mockResponse(503, "")) as unknown as typeof fetch });
    expect((await c1.refreshToken("x")).ok).toBe(false);
    const c2 = createGoogleRestClient({ fetchImpl: (async () => mockResponse(500, "<html>nope")) as unknown as typeof fetch });
    const r2 = await c2.refreshToken("x");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.kind).toBe("transient");
  });

  it("a thrown AbortError becomes a transient network_timeout, and a signal is passed", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeDefined();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const client = createGoogleRestClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.refreshToken("rt1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("network_timeout");
  });
});

describe("event helpers (mocked HTTP)", () => {
  it("insertEvent returns the created resource + etag", async () => {
    const fetchImpl = vi.fn(async () => mockResponse(200, JSON.stringify({ id: "evt1", etag: '"abc"', status: "confirmed" })));
    const client = createGoogleRestClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.insertEvent({ accessToken: "at", calendarId: "primary", event: { summary: "Hone appointment" } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event.id).toBe("evt1");
      expect(r.etag).toBe('"abc"');
    }
  });

  it("patchEvent sends If-Match when an etag is given", async () => {
    let seenIfMatch: string | null = null;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      seenIfMatch = headers["If-Match"] ?? null;
      return mockResponse(200, JSON.stringify({ id: "evt1", etag: '"def"' }));
    });
    const client = createGoogleRestClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.patchEvent({ accessToken: "at", calendarId: "primary", eventId: "evt1", event: {}, etag: '"abc"' });
    expect(seenIfMatch).toBe('"abc"');
  });

  it("getEvent 404 -> not_found; 409 -> conflict; 412 -> precondition_failed", async () => {
    const mk = (status: number) => createGoogleRestClient({ fetchImpl: (async () => mockResponse(status, JSON.stringify({ error: {} }))) as unknown as typeof fetch });
    const r404 = await mk(404).getEvent({ accessToken: "a", calendarId: "c", eventId: "e" });
    const r409 = await mk(409).insertEvent({ accessToken: "a", calendarId: "c", event: {} });
    const r412 = await mk(412).patchEvent({ accessToken: "a", calendarId: "c", eventId: "e", event: {} });
    expect(!r404.ok && r404.error.kind).toBe("not_found");
    expect(!r409.ok && r409.error.kind).toBe("conflict");
    expect(!r412.ok && r412.error.kind).toBe("precondition_failed");
  });

  it("deleteEvent 204 is success; 404 surfaces not_found", async () => {
    const ok = await createGoogleRestClient({ fetchImpl: (async () => mockResponse(204, "")) as unknown as typeof fetch }).deleteEvent({ accessToken: "a", calendarId: "c", eventId: "e" });
    expect(ok.ok).toBe(true);
    const gone = await createGoogleRestClient({ fetchImpl: (async () => mockResponse(404, JSON.stringify({ error: {} }))) as unknown as typeof fetch }).deleteEvent({ accessToken: "a", calendarId: "c", eventId: "e" });
    expect(!gone.ok && gone.error.kind).toBe("not_found");
  });
});
