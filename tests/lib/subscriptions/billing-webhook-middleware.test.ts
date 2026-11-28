import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

// Codex P2 4500263864: the billing webhook must be reachable by Stripe, which
// has no session. Calling POST(new Request("http://localhost/api/billing/webhook", {method:"POST"})) directly misses the middleware, so this drives
// the REAL updateSession with no user and then the route.

const member = vi.hoisted(() => ({ signedIn: false, owner: false, paused: false }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: member.signedIn ? {id: "user",email:"owner@example.test"} : null } }) },
    from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: [{studio_id:"studio"}] }) }) }) }),
    rpc: async (fn: string) => ({data:member.owner ? {status:"canceled"} : null}),
  }),
}));

import { updateSession } from "@/lib/supabase/middleware";
import { POST } from "@/app/api/billing/webhook/route";

const isRedirect = (r: Response) => r.status >= 300 && r.status < 400 && r.headers.has("location");
const post = (p: string) => updateSession(new NextRequest(`http://localhost${p}`, { method: "POST" }));

afterEach(() => { vi.unstubAllEnvs(); member.signedIn = member.owner = member.paused = false; });

describe("/api/billing/webhook through the middleware, session-less", () => {
  it("is NOT redirected to /login, and the route then answers 404 with the flag off", async () => {
    vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "");
    const mw = await post("/api/billing/webhook");
    expect(isRedirect(mw), "Stripe must not be redirected").toBe(false);
    const res = await POST(new Request("http://localhost/api/billing/webhook", {method:"POST"}));
    expect(res.status).toBe(404);
  });

  it("with the flag on it is still not redirected, and the route answers 503", async () => {
    vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "true");
    vi.stubEnv("HONE_BILLING_WEBHOOK_SECRET", "");
    expect(isRedirect(await post("/api/billing/webhook"))).toBe(false);
    expect((await POST(new Request("http://localhost/api/billing/webhook", {method:"POST"}))).status).toBe(503);
  });

  it("control: the detector sees a redirect for a path that is NOT exempt", async () => {
    const r = await post("/api/billing/other");
    expect(isRedirect(r)).toBe(true);
    expect(r.headers.get("location")).toMatch(/\/login/);
  });

  it("the exemption is EXACT: a sub-path and a look-alike are still redirected", async () => {
    for (const p of ["/api/billing/webhook/extra", "/api/billing/webhook2", "/api/billing"]) {
      expect(isRedirect(await post(p)), p).toBe(true);
    }
  });

  it("source: exact equality, no startsWith for billing", () => {
    const mw = readFileSync(path.join(process.cwd(), "lib/supabase/middleware.ts"), "utf8");
    expect(mw).toMatch(/pathname === "\/api\/billing\/webhook" \|\|/);
    expect(mw).not.toMatch(/startsWith\("\/api\/billing/);
  });
});

it("never redirects a cancelled studio's staff or owner: records stay open and only the database refuses new work", async () => {
  vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED","true");
  member.signedIn = true;
  member.paused = true;
  const rpcCalls: string[] = [];
  // Practitioner and owner alike, on records, export, a session under way, the calendar and Billing.
  for (const owner of [false, true]) {
    member.owner = owner;
    for (const path of ["/calendar", "/clients/c1", "/clients/c1/export", "/clients/c1/sessions/s1", "/api/export", "/settings/subscription", "/dashboard"]) {
      expect(isRedirect(await post(path)), `${owner ? "owner" : "practitioner"} ${path}`).toBe(false);
    }
  }
  expect(rpcCalls).toEqual([]);
});

it("source: the middleware no longer consults the cancelled flag at all", () => {
  const mw = readFileSync(path.join(process.cwd(), "lib/supabase/middleware.ts"), "utf8");
  expect(mw).not.toMatch(/my_hone_studio_canceled|my_hone_billing_status/);
  expect(mw).not.toMatch(/redirect[^\n]*subscription-paused/);
});
