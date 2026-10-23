import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseUrl } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { GET as ingestGET, POST as ingestPOST } from "@/app/ingest/[...path]/route";
import { POST as monitoringPOST } from "@/app/monitoring/route";
import {
  MAX_PROXY_BODY_BYTES,
  SENTRY_DSN_HOST,
  SENTRY_PROJECT_ID,
  posthogUpstreamUrl,
} from "@/lib/observability/egress-proxy";

// ===========================================================================
// #828 G-07/G-26 + G-08: what the same-origin /ingest (PostHog) and
// /monitoring (Sentry) proxies actually put ON THE WIRE.
//
// A real local HTTP server stands in for the upstream. fetch is stubbed only
// to point the request at it: the handler's method, headers and body go out
// over a real socket, and the server records exactly what arrived. Requests
// come "from" pages whose URLs carry record ids, with the headers a browser
// sends on a same-origin request (Referer = the full page URL, Origin, the
// Supabase auth cookie) plus Authorization and the client IP.
//
// NEGATIVE CONTROL: the same request through Next's own rewrite proxy (the
// code path a bare next.config.ts rewrite to an external origin takes) arrives
// at the upstream WITH the Referer and Cookie. All values are SYNTHETIC.
// ===========================================================================

const CLIENT = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const SESSION = "0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9";
const APPT = "11111111-2222-4333-8444-555555555555";
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const AUTH_COOKIE = "sb-localproject-auth-token=base64-eyJTEST.SESSION.JWT";
const PAGES = [`/clients/${CLIENT}/sessions/${SESSION}?tab=photos`, `/calendar/${APPT}`];

function browserHeaders(page: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    referer: `https://hone.care${page}`,
    origin: "https://hone.care",
    cookie: `${AUTH_COOKIE}; ph_test_posthog=1`,
    authorization: "Bearer test-token",
    "x-forwarded-for": "203.0.113.7",
    "x-real-ip": "203.0.113.7",
    "user-agent": "Mozilla/5.0 (TestBrowser)",
    "sec-fetch-site": "same-origin",
    accept: "*/*",
    ...extra,
  };
}

type Captured = { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer };
let upstream: Server;
let upstreamPort = 0;
const captured: Captured[] = [];
const respond = (res: import("node:http").ServerResponse): void => {
  res.writeHead(200, {
    "content-type": "application/json",
    "set-cookie": "upstream=1; Path=/",
    "x-sentry-rate-limits": "60:transaction:key",
    "retry-after": "60",
    "x-internal-upstream": "secret-ish",
  });
  res.end('{"ok":true}');
};

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      respond(res);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  upstreamPort = (upstream.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

const realFetch = globalThis.fetch;
const upstreamUrls: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  captured.length = 0;
  upstreamUrls.length = 0;
});

/** Point the handler's outbound fetch at the capture server, unchanged otherwise. */
function routeFetchToCapture(): void {
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    upstreamUrls.push(u.toString());
    return realFetch(`http://127.0.0.1:${upstreamPort}${u.pathname}${u.search}`, init);
  });
}

function expectNothingFromTheBrowser(c: Captured, page: string): void {
  const h = c.headers;
  for (const name of ["referer", "origin", "cookie", "authorization", "x-forwarded-for", "x-real-ip", "sec-fetch-site"]) {
    expect(h[name], `${name} reached the upstream from ${page}`).toBeUndefined();
  }
  expect(h["user-agent"]).not.toContain("TestBrowser");
  const wire = JSON.stringify(h) + c.url;
  expect(UUID_ANYWHERE.test(wire), `a record id reached the upstream from ${page}: ${wire}`).toBe(false);
  expect(wire).not.toContain("auth-token");
}

describe("/ingest (PostHog): only allowlisted headers leave", () => {
  for (const page of PAGES) {
    it(`POST /flags and /e from ${page.split("?")[0]}: no Referer, Cookie, Origin, IP or id; body byte-identical`, async () => {
      routeFetchToCapture();
      const body = Buffer.from(`{"token":"phc_test","distinct_id":"anon-1"}`);
      for (const p of [["flags"], ["e"], ["i", "v0", "e"]]) {
        const res = await ingestPOST(
          new Request(`https://hone.care/ingest/${p.join("/")}/?v=2&compression=base64`, {
            method: "POST",
            headers: browserHeaders(page, { "content-type": "text/plain" }),
            body,
          }),
          { params: Promise.resolve({ path: p }) },
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("set-cookie")).toBeNull();
      }
      expect(captured).toHaveLength(3);
      for (const c of captured) {
        expectNothingFromTheBrowser(c, page);
        expect(c.body.equals(body)).toBe(true);
        expect(c.headers["content-type"]).toBe("text/plain");
      }
      expect(upstreamUrls).toEqual([
        "https://us.i.posthog.com/flags/?v=2&compression=base64",
        "https://us.i.posthog.com/e/?v=2&compression=base64",
        "https://us.i.posthog.com/i/v0/e/?v=2&compression=base64",
      ]);
    });

    it(`GET /static and /array (SDK assets) from ${page.split("?")[0]} go to the assets host, headers stripped`, async () => {
      routeFetchToCapture();
      await ingestGET(new Request("https://hone.care/ingest/static/1.404.1/x.js", { headers: browserHeaders(page) }), {
        params: Promise.resolve({ path: ["static", "1.404.1", "x.js"] }),
      });
      await ingestGET(new Request("https://hone.care/ingest/array/phc_test/config.js", { headers: browserHeaders(page) }), {
        params: Promise.resolve({ path: ["array", "phc_test", "config.js"] }),
      });
      expect(upstreamUrls).toEqual([
        "https://us-assets.i.posthog.com/static/1.404.1/x.js",
        "https://us-assets.i.posthog.com/array/phc_test/config.js",
      ]);
      for (const c of captured) expectNothingFromTheBrowser(c, page);
    });
  }

  it("refuses paths outside the allowlist (not a general proxy), other methods and oversize bodies", async () => {
    routeFetchToCapture();
    const ctx = (p: string[]) => ({ params: Promise.resolve({ path: p }) });
    expect((await ingestGET(new Request("https://hone.care/ingest/api/surveys/"), ctx(["api", "surveys"]))).status).toBe(404);
    expect((await ingestGET(new Request("https://hone.care/ingest/s/"), ctx(["s"]))).status).toBe(404);
    expect((await ingestGET(new Request("https://hone.care/ingest/"), ctx([]))).status).toBe(404);
    expect(posthogUpstreamUrl(["e", ".."], "")).toBeNull();
    expect(posthogUpstreamUrl(["e", "a%2F..%2Fb"], "")).toBeNull();
    expect((await ingestPOST(new Request("https://hone.care/ingest/e/", { method: "DELETE" }), ctx(["e"]))).status).toBe(405);
    const big = new Uint8Array(MAX_PROXY_BODY_BYTES + 1);
    expect(
      (await ingestPOST(new Request("https://hone.care/ingest/e/", { method: "POST", body: big.buffer as ArrayBuffer }), ctx(["e"]))).status,
    ).toBe(413);
    expect(captured).toHaveLength(0);
  });

  it("an upstream failure is a bare 502 with no detail", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error(`boom /clients/${CLIENT}`)));
    const res = await ingestPOST(new Request("https://hone.care/ingest/e/", { method: "POST", body: "x" }), {
      params: Promise.resolve({ path: ["e"] }),
    });
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("");
  });
});

describe("/monitoring (Sentry tunnel): only the envelope body leaves, only for Hone's DSN", () => {
  const envelope = (dsn: string) =>
    `${JSON.stringify({ event_id: "9f2c5e1d7a6b4c3e8f0a1b2c3d4e5f60", dsn })}\n{"type":"event"}\n{"message":"x"}\n`;
  const OWN_DSN = `https://publickey@${SENTRY_DSN_HOST}/${SENTRY_PROJECT_ID}`;

  for (const page of PAGES) {
    it(`an envelope from ${page.split("?")[0]} reaches Sentry's envelope endpoint without the browser's headers`, async () => {
      routeFetchToCapture();
      const body = envelope(OWN_DSN);
      const res = await monitoringPOST(
        new Request("https://hone.care/monitoring", {
          method: "POST",
          headers: browserHeaders(page, { "content-type": "text/plain;charset=UTF-8" }),
          body,
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("x-internal-upstream")).toBeNull();
      // The SDK's back-off signals come through (Codex P2 4304118573).
      expect(res.headers.get("x-sentry-rate-limits")).toBe("60:transaction:key");
      expect(res.headers.get("retry-after")).toBe("60");
      expect(upstreamUrls).toEqual([`https://${SENTRY_DSN_HOST}/api/${SENTRY_PROJECT_ID}/envelope/`]);
      expectNothingFromTheBrowser(captured[0]!, page);
      expect(captured[0]!.body.toString()).toBe(body);
    });
  }

  it("refuses a foreign DSN, a malformed envelope and an oversize body: never an open relay", async () => {
    routeFetchToCapture();
    const post = (b: string | Uint8Array) =>
      monitoringPOST(new Request("https://hone.care/monitoring", { method: "POST", body: typeof b === "string" ? b : (b.slice().buffer as ArrayBuffer) }));
    expect((await post(envelope(`https://k@evil.example/${SENTRY_PROJECT_ID}`))).status).toBe(400);
    expect((await post(envelope(`https://k@${SENTRY_DSN_HOST}/999`))).status).toBe(400);
    expect((await post(envelope(`http://k@${SENTRY_DSN_HOST}/${SENTRY_PROJECT_ID}`))).status).toBe(400);
    expect((await post("not json\n{}"))).toHaveProperty("status", 400);
    expect((await post(new Uint8Array(MAX_PROXY_BODY_BYTES + 1))).status).toBe(413);
    expect(captured).toHaveLength(0);
  });

  it("the pinned DSN host and project are the ones every runtime is configured with", () => {
    for (const f of ["instrumentation-client.ts", "sentry.server.config.ts", "sentry.edge.config.ts"]) {
      const src = readFileSync(path.join(process.cwd(), f), "utf8");
      expect(src, f).toMatch(new RegExp(`dsn: "https://[0-9a-f]+@${SENTRY_DSN_HOST.replace(/\./g, "\\.")}/${SENTRY_PROJECT_ID}"`));
    }
  });
});

describe("NEGATIVE CONTROL: a bare rewrite (Next's external-rewrite proxy) forwards the browser's headers", () => {
  it("Referer with the record id, and the auth Cookie, arrive at the upstream", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { proxyRequest } = require("next/dist/server/lib/router-utils/proxy-request") as {
      proxyRequest: (req: unknown, res: unknown, parsedUrl: unknown) => Promise<unknown>;
    };
    const app = createServer((req, res) => {
      void proxyRequest(req, res, parseUrl(`http://127.0.0.1:${upstreamPort}/flags/?v=2`, true));
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
    const appPort = (app.address() as { port: number }).port;
    const page = PAGES[0]!;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: appPort, path: "/ingest/flags/?v=2", method: "POST", headers: browserHeaders(page) },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    await new Promise<void>((r) => app.close(() => r()));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.headers.referer).toBe(`https://hone.care${page}`);
    expect(captured[0]!.headers.cookie).toContain("auth-token");
    expect(captured[0]!.headers["x-forwarded-for"]).toContain("203.0.113.7");
  });
});

describe("source guard: the bare rewrites are gone and the SDK uses the tunnel route", () => {
  const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("next.config.ts rewrites nothing to PostHog or Sentry and sets no tunnelRoute", () => {
    const src = code(read("next.config.ts"));
    expect(src).not.toMatch(/posthog\.com/);
    expect(src).not.toMatch(/\btunnelRoute\s*:/);
    expect(src).not.toMatch(/source:\s*["']\/ingest/);
  });

  it("instrumentation-client.ts tunnels Sentry through /monitoring and keeps PostHog on /ingest", () => {
    const src = code(read("instrumentation-client.ts"));
    expect(src).toMatch(/tunnel:\s*"\/monitoring"/);
    expect(src).toMatch(/api_host:\s*"\/ingest"/);
  });
});
