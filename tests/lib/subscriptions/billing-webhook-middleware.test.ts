import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

// Codex P2 4500263864: the billing webhook must be reachable by Stripe, which
// has no session. Calling POST() directly misses the middleware, so this drives
// the REAL updateSession with no user and then the route.

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));

import { updateSession } from "@/lib/supabase/middleware";
import { POST } from "@/app/api/billing/webhook/route";

const isRedirect = (r: Response) => r.status >= 300 && r.status < 400 && r.headers.has("location");
const post = (p: string) => updateSession(new NextRequest(`http://localhost${p}`, { method: "POST" }));

afterEach(() => vi.unstubAllEnvs());

describe("/api/billing/webhook through the middleware, session-less", () => {
  it("is NOT redirected to /login, and the route then answers 404 with the flag off", async () => {
    vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "");
    const mw = await post("/api/billing/webhook");
    expect(isRedirect(mw), "Stripe must not be redirected").toBe(false);
    const res = await POST();
    expect(res.status).toBe(404);
  });

  it("with the flag on it is still not redirected, and the route answers 503", async () => {
    vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "true");
    expect(isRedirect(await post("/api/billing/webhook"))).toBe(false);
    expect((await POST()).status).toBe(503);
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
