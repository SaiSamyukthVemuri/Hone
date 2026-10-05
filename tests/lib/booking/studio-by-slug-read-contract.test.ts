import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// SENTRY-BOOKING-ERR-01 (B). getStudioBySlug has TWO negative answers and the
// public booking page depends on them staying apart:
//
//   null   - the read completed and no studio has this slug   -> 404
//   throws - the read did not complete; existence is UNKNOWN   -> retryable 500
//
// The Sentry group was "Failed to load studio: TypeError: fetch failed". This
// file reproduces that exact message with NO mocked client: the real
// createAdminClient, real supabase-js and real undici talk to a loopback server
// that plays PostgREST, and for the transport case simply drops every
// connection. Nothing here fabricates the error text.
//
// It also pins the premise of a design decision. supabase-js ALREADY retries an
// idempotent read after a network error (3 retries, 1s/2s/4s backoff). So when
// this message surfaces, the transport was down for the whole ~7s window, and
// an application-level retry on top would only lengthen the visitor's wait.
// The answer to a sustained failure is the page's retryable unavailable state
// (app/book/[slug]/error.tsx). If a library upgrade ever stops retrying, the
// attempt count below goes red and that decision has to be revisited.

// supabase-js constructs its realtime client eagerly and refuses to on Node 20
// (CI's runtime), which has no global WebSocket. Realtime is never used here;
// same guard as tests/db/client-profile-read-failure-containment.db.test.ts.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

// queries.ts imports the cookie-bound server client at module scope; nothing
// here calls it.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

type Mode =
  | { kind: "rows"; rows: unknown[] }
  | { kind: "http"; status: number; body: unknown }
  | { kind: "drop-connection" };

let mode: Mode = { kind: "rows", rows: [] };
let studioReads = 0;
let unexpected: string[] = [];
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (!url.startsWith("/rest/v1/studios?")) {
      unexpected.push(`${req.method} ${url}`);
      res.writeHead(500);
      res.end();
      return;
    }
    studioReads += 1;
    if (mode.kind === "drop-connection") {
      req.socket.destroy();
      return;
    }
    const [status, body] =
      mode.kind === "rows" ? [200, mode.rows] : [mode.status, mode.body];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${port}`);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  studioReads = 0;
  unexpected = [];
});

const { getStudioBySlug } = await import("@/lib/booking/queries");

const STUDIO = { id: "studio-1", slug: "willow", name: "Willow" };

describe("getStudioBySlug keeps 'absent' and 'unreadable' apart", () => {
  it("returns the studio when the read finds it", async () => {
    mode = { kind: "rows", rows: [STUDIO] };
    await expect(getStudioBySlug("willow")).resolves.toMatchObject(STUDIO);
    expect(studioReads).toBe(1);
    expect(unexpected).toEqual([]);
  });

  it("returns null ONLY when the read completed and found nothing", async () => {
    mode = { kind: "rows", rows: [] };
    await expect(getStudioBySlug("no-such-studio")).resolves.toBeNull();
    expect(studioReads).toBe(1);
  });

  it("throws, never null, when PostgREST answers with an error", async () => {
    mode = {
      kind: "http",
      status: 500,
      body: { code: "XX000", message: "upstream exploded", details: null, hint: null },
    };
    await expect(getStudioBySlug("willow")).rejects.toThrow(
      "Failed to load studio: upstream exploded",
    );
  });

  it(
    "throws the exact Sentry message, never null, when the transport fails",
    async () => {
      mode = { kind: "drop-connection" };
      const outcome = await getStudioBySlug("willow").then(
        (value) => ({ resolved: true as const, value }),
        (error: unknown) => ({ resolved: false as const, error }),
      );

      expect(outcome.resolved, "an unreadable studio must not resolve").toBe(false);
      if (outcome.resolved) return;
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toBe(
        "Failed to load studio: TypeError: fetch failed",
      );
      // The premise above: the client already made 1 + 3 attempts.
      expect(studioReads).toBe(4);
      expect(unexpected).toEqual([]);
    },
    20_000,
  );
});
