import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// SEC-001 regression map (Privacy, 2026-10-24). tests/app/auth-callback-redirect.test.ts
// (#971) is the original 17-case proof and is left unchanged. This file adds
// the cases it does not execute:
//   - the framework request type: Next hands the route a NextRequest, not a
//     plain Request, so the hostile matrix runs through NextRequest too;
//   - WHATWG URL normalization: tab, CR and LF are stripped while parsing, so
//     "/\t/host" becomes the protocol-relative "//host" after the
//     startsWith("/") check has already passed;
//   - a callback with no code keeps a hostile `next` on the login error page;
//   - the invitation statuses that keep the caller's destination ("linked" /
//     "already_linked" without a studio choice) still validate it.

const h = vi.hoisted(() => ({ exchange: vi.fn(), reconcile: vi.fn(), identify: vi.fn(), capture: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({
  auth: { exchangeCodeForSession: h.exchange }, rpc: h.reconcile,
}) }));
vi.mock("@/lib/analytics/server", () => ({ identifyServerUser: h.identify, captureServerEvent: h.capture }));
import { GET } from "@/app/(auth)/auth/callback/route";

const ORIGIN = "https://hone.example.test";
const HOSTILE = [
  "@outside.example.test", ".outside.example.test/path", ":444/path",
  "//outside.example.test/path", "/\\outside.example.test/path",
  "https://outside.example.test", "?next=outside",
  "/\t/outside.example.test/path", "/\n/outside.example.test/path", "/\r\n/outside.example.test/path",
  "\t//outside.example.test/path", "/\t\\outside.example.test/path",
];

function nextRequest(next: string | undefined, code: string | null = "synthetic-code") {
  const url = new URL("/auth/callback", ORIGIN);
  if (code !== null) url.searchParams.set("code", code);
  if (next !== undefined) url.searchParams.set("next", next);
  return new NextRequest(url);
}

function locationOf(response: Response): URL {
  const location = response.headers.get("location");
  expect(location).not.toBeNull();
  return new URL(location as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.exchange.mockResolvedValue({ data: { user: { id: "11111111-2222-4333-8444-555555555555" } }, error: null });
  h.reconcile.mockResolvedValue({ data: null, error: null });
});

describe("SEC-001 successful callback stays on the request origin (framework NextRequest)", () => {
  it.each(HOSTILE)("refuses %j and lands on /dashboard", async (next) => {
    const location = locationOf(await GET(nextRequest(next)));
    expect(location.origin).toBe(ORIGIN);
    expect(location.href).toBe(`${ORIGIN}/dashboard`);
  });

  it.each(["/dashboard", "/settings/team?tab=invites#pending", "/clients/synthetic?return=%2Fdashboard"])(
    "preserves same-origin %s", async (next) => {
      expect(locationOf(await GET(nextRequest(next))).href).toBe(new URL(next, ORIGIN).href);
    },
  );

  it.each([["linked"], ["already_linked"]])(
    "a %s invitation without a studio choice still validates the caller's destination", async (status) => {
      h.reconcile.mockResolvedValue({ data: { status, choose_studio: false }, error: null });
      for (const next of HOSTILE) {
        expect(locationOf(await GET(nextRequest(next))).href).toBe(`${ORIGIN}/dashboard`);
      }
      expect(locationOf(await GET(nextRequest("/clients"))).href).toBe(`${ORIGIN}/clients`);
    },
  );
});

describe("SEC-001 unsuccessful callbacks never follow the caller's destination", () => {
  it.each(HOSTILE)("no code: %j goes to the same-origin login error", async (next) => {
    const location = locationOf(await GET(nextRequest(next, null)));
    expect(location.href).toBe(`${ORIGIN}/login?error=auth`);
    expect(h.exchange).not.toHaveBeenCalled();
  });

  it.each(HOSTILE)("failed exchange: %j goes to the same-origin login error", async (next) => {
    h.exchange.mockResolvedValue({ data: { user: null }, error: { code: "synthetic" } });
    expect(locationOf(await GET(nextRequest(next))).href).toBe(`${ORIGIN}/login?error=auth`);
  });
});
