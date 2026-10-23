import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// HON-57: GET /api/admin/runtime, the platform-operator Node runtime probe.
//
// The REAL gate runs here: lib/admin.ts isAdmin with a synthetic ADMIN_EMAILS
// under NODE_ENV=production, the real lib/supabase/server.ts createClient, and
// the real middleware. Only the external boundaries are stubbed (@supabase/ssr
// and next/headers), so a renamed or missing export in our own modules fails
// here instead of hiding behind a mock. The stubs are created with vi.hoisted
// because vi.mock factories are hoisted above every top-level const.

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  cookies: vi.fn(),
  createServerClient: vi.fn(),
  memberships: [] as { studio_id: string }[],
}));

vi.mock("@supabase/ssr", () => ({ createServerClient: h.createServerClient }));
vi.mock("next/headers", () => ({ cookies: h.cookies }));

import { GET, dynamic, revalidate, runtime } from "@/app/api/admin/runtime/route";
import { config as middlewareConfig, middleware } from "@/middleware";

const OPERATOR = "operator@platform.test";
const STUDIO_OWNER = "owner@studio.test";
const ORIGIN = "https://probe.test";

const CONTRACT_KEYS = [
  "brotli",
  "commitSha",
  "deploymentId",
  "env",
  "node",
  "observedAt",
  "region",
];

function fakeSupabase() {
  const query = {
    select: () => query,
    eq: () => query,
    then: (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve({ data: h.memberships, error: null }).then(resolve, reject),
  };
  return { auth: { getUser: h.getUser }, from: () => query };
}

function anonymous() {
  h.getUser.mockResolvedValue({ data: { user: null }, error: null });
}

function signedIn(email: string | undefined) {
  h.getUser.mockResolvedValue({
    data: { user: { id: "user-under-test", email } },
    error: null,
  });
}

async function expectRefusal(res: Response) {
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("");
  expect(res.headers.get("cache-control")).toBe(
    "no-store, no-cache, max-age=0, must-revalidate",
  );
  expect(res.headers.get("cdn-cache-control")).toBe("no-store");
  expect(res.headers.get("vercel-cdn-cache-control")).toBe("no-store");
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.getUser.mockReset();
  h.memberships = [];
  h.cookies.mockReset();
  h.cookies.mockResolvedValue({ getAll: () => [], set: () => {} });
  h.createServerClient.mockReset();
  h.createServerClient.mockImplementation(fakeSupabase);
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ADMIN_EMAILS", ` ${OPERATOR.toUpperCase()} , other@platform.test `);
  // lib/admin.ts logs once when ADMIN_EMAILS is missing in production.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  consoleError.mockRestore();
});

describe("GET /api/admin/runtime — platform operator", () => {
  it("200 with exactly the seven contract keys and the serving Node version", async () => {
    signedIn(OPERATOR);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(CONTRACT_KEYS);
    expect(body.node).toBe(process.version);
    expect(body.node).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(body.brotli).toBe(process.versions.brotli ?? null);
    expect(Number.isNaN(Date.parse(body.observedAt))).toBe(false);
  });

  it("is uncacheable at the browser, CDN and Vercel layers", async () => {
    signedIn(OPERATOR);
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe(
      "no-store, no-cache, max-age=0, must-revalidate",
    );
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("vercel-cdn-cache-control")).toBe("no-store");
  });

  it("echoes the Vercel deployment metadata when present", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_synthetic");
    vi.stubEnv("VERCEL_REGION", "iad1");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "0".repeat(40));
    signedIn(OPERATOR);
    const body = await (await GET()).json();
    expect(body).toMatchObject({
      env: "production",
      deploymentId: "dpl_synthetic",
      region: "iad1",
      commitSha: "0".repeat(40),
    });
  });

  it("reports null, never a guess, when the Vercel metadata is absent", async () => {
    for (const name of [
      "VERCEL_ENV",
      "VERCEL_DEPLOYMENT_ID",
      "VERCEL_REGION",
      "VERCEL_GIT_COMMIT_SHA",
    ]) {
      vi.stubEnv(name, undefined);
    }
    signedIn(OPERATOR);
    const body = await (await GET()).json();
    expect(body).toMatchObject({
      env: null,
      deploymentId: null,
      region: null,
      commitSha: null,
    });
  });

  it("route config: Node function runtime, never static", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
    expect(revalidate).toBe(0);
  });
});

describe("GET /api/admin/runtime — fails closed with no version metadata", () => {
  it("anonymous (no user)", async () => {
    anonymous();
    await expectRefusal(await GET());
  });

  it("authenticated studio owner who is not on the allowlist", async () => {
    signedIn(STUDIO_OWNER);
    await expectRefusal(await GET());
  });

  it("authenticated user with no email", async () => {
    signedIn(undefined);
    await expectRefusal(await GET());
  });

  it("getUser returned an error, even alongside an operator user", async () => {
    h.getUser.mockResolvedValue({
      data: { user: { id: "user-under-test", email: OPERATOR } },
      error: { name: "AuthApiError", message: "jwt expired", status: 401 },
    });
    await expectRefusal(await GET());
  });

  it("getUser threw: generic 404, no exception text", async () => {
    h.getUser.mockRejectedValue(new Error("auth upstream exploded: secret-detail"));
    const res = await GET();
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toBe("");
    expect(text).not.toContain("secret-detail");
  });

  it("createClient threw (cookie store unavailable)", async () => {
    h.cookies.mockRejectedValue(new Error("cookies() outside a request scope"));
    await expectRefusal(await GET());
  });

  it("createServerClient threw", async () => {
    h.createServerClient.mockImplementation(() => {
      throw new Error("missing supabase url");
    });
    await expectRefusal(await GET());
  });

  it("ADMIN_EMAILS absent in production refuses even the operator", async () => {
    vi.stubEnv("ADMIN_EMAILS", undefined);
    signedIn(OPERATOR);
    await expectRefusal(await GET());
  });

  it("ADMIN_EMAILS empty (separators only) in production refuses even the operator", async () => {
    vi.stubEnv("ADMIN_EMAILS", " , ,");
    signedIn(OPERATOR);
    await expectRefusal(await GET());
  });
});

describe("middleware in front of /api/admin/runtime (the actual runtime path)", () => {
  function requestProbe() {
    return new NextRequest(`${ORIGIN}/api/admin/runtime`);
  }

  it("the middleware matcher covers the probe path", () => {
    const [matcher] = middlewareConfig.matcher;
    expect(new RegExp(`^${matcher}$`).test("/api/admin/runtime")).toBe(true);
  });

  it("anonymous: a same-origin redirect to /login, never the handler", async () => {
    anonymous();
    const res = await middleware(requestProbe());
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/login");
    expect(res.headers.get("x-middleware-next")).toBeNull();
    expect(await res.text()).not.toContain("node");
  });

  it("an authenticated member of one studio passes through to the handler's 404 gate", async () => {
    signedIn(STUDIO_OWNER);
    h.memberships = [{ studio_id: "studio-under-test" }];
    const res = await middleware(requestProbe());
    expect(res.headers.get("x-middleware-next")).toBe("1");
    await expectRefusal(await GET());
  });

  it("an operator with exactly one active studio passes through to a 200", async () => {
    signedIn(OPERATOR);
    h.memberships = [{ studio_id: "studio-under-test" }];
    const res = await middleware(requestProbe());
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect((await GET()).status).toBe(200);
  });

  it("an operator with NO active studio is sent to /no-access: the /admin carve-out does not cover /api/admin", async () => {
    signedIn(OPERATOR);
    h.memberships = [];
    const res = await middleware(requestProbe());
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/no-access");
  });
});
