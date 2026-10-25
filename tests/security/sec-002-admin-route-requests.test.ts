import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// SEC-002 request level: a document request and an RSC request for every
// /admin page that reads through the service-role client, for an ordinary
// member of each of two synthetic studios, a deactivated member, a former
// platform admin and the current platform admin.
//
// tests/app/admin/ops-alerts-page.test.ts proves the loaders with the guard
// itself mocked. Here the REAL pieces run in request order: the middleware
// matcher (unstable_doesMiddlewareMatch), the real middleware, then, for a
// request the middleware lets through, the real /admin layout and page as Next
// starts them. A document request starts the layout and page concurrently; an
// RSC request for a soft navigation reuses the already-rendered layout, so only
// the page runs and its own gate is the only one. lib/admin.ts isAdmin runs
// with a synthetic ADMIN_EMAILS under NODE_ENV=production, and
// lib/supabase/server.ts and next/navigation are real.
//
// Stubbed: the external boundaries (@supabase/ssr, next/headers) and the
// service-role constructor, which counts every construction and serves only
// rows carrying PRIVILEGED. A refusal must leave that count at 0, and the
// response it produces must not contain the marker. The admin control proves
// the counter and the marker are live (both observed on the same harness).

const PRIVILEGED = "PRIVILEGED-SENTINEL-7f3a";

const h = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  memberships: [] as { studio_id: string }[],
  adminConstructions: 0,
  tables: [] as string[],
  createServerClient: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({ createServerClient: h.createServerClient }));
vi.mock("next/headers", () => ({ cookies: h.cookies }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    h.adminConstructions += 1;
    return privilegedClient();
  },
}));

import { config as middlewareConfig, middleware } from "@/middleware";
import AdminLayout from "@/app/admin/layout";

// Every row the service-role client serves carries the marker in its text
// fields, so any privileged read that reached a response body would show it.
function privilegedRow(table: string): Record<string, unknown> {
  const now = new Date("2026-10-24T00:00:00Z").toISOString();
  return {
    id: `${PRIVILEGED}-${table}`,
    created_at: now,
    updated_at: now,
    severity: "critical",
    event: PRIVILEGED,
    message: PRIVILEGED,
    name: PRIVILEGED,
    slug: PRIVILEGED,
    owner_email: `${PRIVILEGED}@studio.test`,
    actor_email: `${PRIVILEGED}@platform.test`,
    target_type: PRIVILEGED,
    action: PRIVILEGED,
    outcome: PRIVILEGED,
    source: PRIVILEGED,
    route: PRIVILEGED,
    studio_id: null,
    safe_details: {},
    metadata: {},
    resolved_at: null,
  };
}

function privilegedClient() {
  const from = (table: string) => {
    h.tables.push(table);
    const result = { data: [privilegedRow(table)], error: null, count: 1 };
    const query: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve(result).then(resolve, reject);
          }
          if (prop === "maybeSingle" || prop === "single") {
            return () => Promise.resolve({ ...result, data: privilegedRow(table) });
          }
          return () => query;
        },
      },
    );
    return query;
  };
  return { from, rpc: () => Promise.resolve({ data: null, error: null }) };
}

// The RLS-scoped client the middleware and lib/supabase/server.ts build. The
// practitioners read returns the caller's ACTIVE memberships, which is what the
// real `.eq("user_id", ...).eq("active", true)` under RLS yields.
function rlsClient() {
  const query = {
    select: () => query,
    eq: () => query,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: h.memberships, error: null }).then(resolve, reject),
  };
  return {
    auth: {
      getUser: async () => ({ data: { user: h.user }, error: null }),
    },
    from: () => query,
  };
}

const ORIGIN = "https://hone.test";
const OPERATOR = "operator@platform.test";

type Identity = {
  label: string;
  email: string;
  memberships: { studio_id: string }[];
};

const STUDIO_A = "synthetic-studio-a";
const STUDIO_B = "synthetic-studio-b";

const ORDINARY_A: Identity = {
  label: "ordinary member of studio A",
  email: "member@studio-a.test",
  memberships: [{ studio_id: STUDIO_A }],
};
const ORDINARY_B: Identity = {
  label: "ordinary member of studio B",
  email: "member@studio-b.test",
  memberships: [{ studio_id: STUDIO_B }],
};
// Deactivated: practitioners.active = false, so the active-membership read is empty.
const DEACTIVATED: Identity = {
  label: "deactivated member",
  email: "deactivated@studio-a.test",
  memberships: [],
};
// Former platform admin: removed from ADMIN_EMAILS, still an active member of
// studio B, so the middleware lets them through and only the layout and the
// page can refuse.
const FORMER_ADMIN_MEMBER: Identity = {
  label: "former platform admin who is still a studio member",
  email: "former-operator@platform.test",
  memberships: [{ studio_id: STUDIO_B }],
};
const FORMER_ADMIN_NO_STUDIO: Identity = {
  label: "former platform admin with no studio",
  email: "former-operator@platform.test",
  memberships: [],
};
const ADMIN: Identity = {
  label: "current platform admin (no studio)",
  email: OPERATOR,
  memberships: [],
};

type PageCase = {
  path: string;
  load: () => Promise<{ default: (props: never) => Promise<ReactElement> }>;
  props: () => unknown;
  // How the page's own gate refuses.
  refusal: "not-found" | "redirect:/no-access";
};

const PAGES: PageCase[] = [
  {
    path: "/admin",
    load: () => import("@/app/admin/page") as never,
    props: () => ({}),
    refusal: "not-found",
  },
  {
    path: "/admin/audit",
    load: () => import("@/app/admin/audit/page") as never,
    props: () => ({}),
    refusal: "redirect:/no-access",
  },
  {
    path: "/admin/ops-alerts",
    load: () => import("@/app/admin/ops-alerts/page") as never,
    props: () => ({}),
    refusal: "not-found",
  },
  {
    path: `/admin/studios/${STUDIO_B}`,
    load: () => import("@/app/admin/studios/[id]/page") as never,
    props: () => ({ params: Promise.resolve({ id: STUDIO_B }) }),
    refusal: "not-found",
  },
  {
    path: `/admin/studios/new?created=${STUDIO_B}`,
    load: () => import("@/app/admin/studios/new/page") as never,
    props: () => ({ searchParams: Promise.resolve({ created: STUDIO_B }) }),
    refusal: "not-found",
  },
  {
    path: "/admin/payments/manual-review",
    load: () => import("@/app/admin/payments/manual-review/page") as never,
    props: () => ({}),
    refusal: "not-found",
  },
];

type Kind = "document" | "rsc";

function headersFor(kind: Kind, path: string): Record<string, string> {
  if (kind === "document") {
    return {
      accept: "text/html,application/xhtml+xml",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
    };
  }
  // What the App Router client sends for a soft navigation to `path`.
  return {
    accept: "*/*",
    rsc: "1",
    "next-router-state-tree": encodeURIComponent(
      JSON.stringify(["", { children: ["admin", { children: ["__PAGE__", {}] }] }, null, null, true]),
    ),
    "next-url": path.split("?")[0],
  };
}

function requestFor(kind: Kind, path: string): NextRequest {
  const url = new URL(path, ORIGIN);
  if (kind === "rsc") url.searchParams.set("_rsc", "sec002");
  return new NextRequest(url, {
    headers: headersFor(kind, path),
  });
}

type Outcome =
  | { stage: "middleware"; status: number; location: string | null; body: string }
  | { stage: "render"; status: number; location: string | null; body: string };

function refusalFromThrown(error: unknown): { status: number; location: string | null } | null {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string") return null;
  if (digest === "NEXT_HTTP_ERROR_FALLBACK;404") return { status: 404, location: null };
  if (digest.startsWith("NEXT_REDIRECT;")) {
    const [, , location, status] = digest.split(";");
    return { status: Number(status), location };
  }
  return null;
}

// Runs one request through the real matcher, the real middleware and, when the
// middleware passes it on, the real layout and page as Next would start them.
async function serve(kind: Kind, page: PageCase): Promise<Outcome> {
  const request = requestFor(kind, page.path);
  expect(
    unstable_doesMiddlewareMatch({
      config: middlewareConfig,
      url: request.nextUrl.toString(),
      headers: headersFor(kind, page.path),
    }),
  ).toBe(true);

  const res = await middleware(request);
  if (res.headers.get("x-middleware-next") !== "1") {
    return {
      stage: "middleware",
      status: res.status,
      location: res.headers.get("location"),
      body: await res.text(),
    };
  }

  const { default: Page } = await page.load();
  const pageRun = Page(page.props() as never);
  const runs: Promise<ReactElement>[] =
    kind === "document" ? [AdminLayout({ children: null }), pageRun] : [pageRun];
  const settled = await Promise.allSettled(runs);

  // Next answers with the first refusal any started segment throws. The page's
  // own outcome is always reported too, because on a soft navigation it is the
  // only gate.
  for (const s of settled) {
    if (s.status === "rejected") {
      const refusal = refusalFromThrown(s.reason);
      if (!refusal) throw s.reason;
      return {
        stage: "render",
        ...refusal,
        body: `${(s.reason as Error).message}\n${(s.reason as { digest: string }).digest}`,
      };
    }
  }
  const pageResult = settled[settled.length - 1] as PromiseFulfilledResult<ReactElement>;
  return {
    stage: "render",
    status: 200,
    location: null,
    body: renderToStaticMarkup(pageResult.value),
  };
}

// Page-only gate, independent of the layout: what the page itself throws when
// the layout's redirect is not in the request at all.
async function pageGate(page: PageCase): Promise<{ status: number; location: string | null }> {
  const { default: Page } = await page.load();
  try {
    await Page(page.props() as never);
  } catch (error) {
    const refusal = refusalFromThrown(error);
    if (refusal) return refusal;
    throw error;
  }
  return { status: 200, location: null };
}

function signIn(identity: Identity) {
  h.user = { id: `user-${identity.label.replace(/\W+/g, "-")}`, email: identity.email };
  h.memberships = identity.memberships;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.user = null;
  h.memberships = [];
  h.adminConstructions = 0;
  h.tables = [];
  h.createServerClient.mockReset();
  h.createServerClient.mockImplementation(rlsClient);
  h.cookies.mockReset();
  h.cookies.mockResolvedValue({ getAll: () => [], set: () => {} });
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ADMIN_EMAILS", `${OPERATOR},second-operator@platform.test`);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.invalid");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key-not-used");
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  consoleError.mockRestore();
});

const KINDS: Kind[] = ["document", "rsc"];

describe("SEC-002 request level: refused before the middleware lets the request reach /admin", () => {
  for (const identity of [DEACTIVATED, FORMER_ADMIN_NO_STUDIO]) {
    for (const page of PAGES) {
      for (const kind of KINDS) {
        it(`${identity.label}: ${kind} ${page.path} -> 307 /no-access, no privileged read`, async () => {
          signIn(identity);
          const out = await serve(kind, page);
          expect(out.stage).toBe("middleware");
          expect(out.status).toBe(307);
          expect(new URL(out.location!).pathname).toBe("/no-access");
          expect(out.body).not.toContain(PRIVILEGED);
          expect(h.adminConstructions).toBe(0);
        });
      }
    }
  }

  for (const page of PAGES) {
    for (const kind of KINDS) {
      it(`signed out: ${kind} ${page.path} -> 307 /login, no privileged read`, async () => {
        const out = await serve(kind, page);
        expect(out.stage).toBe("middleware");
        expect(out.status).toBe(307);
        expect(new URL(out.location!).pathname).toBe("/login");
        expect(out.body).not.toContain(PRIVILEGED);
        expect(h.adminConstructions).toBe(0);
      });
    }
  }
});

describe("SEC-002 request level: studio members pass the middleware and are refused by layout and page", () => {
  for (const identity of [ORDINARY_A, ORDINARY_B, FORMER_ADMIN_MEMBER]) {
    for (const page of PAGES) {
      it(`${identity.label}: document ${page.path} is refused, no privileged read`, async () => {
        signIn(identity);
        const out = await serve("document", page);
        expect(out.stage).toBe("render");
        // The layout's redirect to /dashboard is the first segment to settle.
        expect(out.status).toBe(307);
        expect(out.location).toBe("/dashboard");
        expect(out.body).not.toContain(PRIVILEGED);
        expect(h.adminConstructions).toBe(0);
        expect(h.tables).toEqual([]);
      });

      it(`${identity.label}: RSC ${page.path} is refused by the page alone, no privileged read`, async () => {
        signIn(identity);
        const out = await serve("rsc", page);
        expect(out.stage).toBe("render");
        if (page.refusal === "not-found") {
          expect(out.status).toBe(404);
          expect(out.location).toBeNull();
        } else {
          expect(out.status).toBe(307);
          expect(out.location).toBe("/no-access");
        }
        expect(out.body).not.toContain(PRIVILEGED);
        expect(h.adminConstructions).toBe(0);
        expect(h.tables).toEqual([]);
      });
    }
  }

  it("the page gate alone also refuses for a document request, so the layout is not load-bearing", async () => {
    for (const identity of [ORDINARY_A, ORDINARY_B, FORMER_ADMIN_MEMBER]) {
      signIn(identity);
      for (const page of PAGES) {
        const refusal = await pageGate(page);
        expect(refusal.status, `${identity.label} ${page.path}`).not.toBe(200);
      }
    }
    expect(h.adminConstructions).toBe(0);
  });
});

describe("SEC-002 request level: the current platform admin (positive control)", () => {
  for (const page of PAGES) {
    for (const kind of KINDS) {
      it(`${kind} ${page.path} passes the middleware and reaches the privileged client`, async () => {
        signIn(ADMIN);
        const out = await serve(kind, page);
        expect(out.stage).toBe("render");
        expect(out.status).toBe(200);
        expect(h.adminConstructions).toBeGreaterThan(0);
        expect(h.tables.length).toBeGreaterThan(0);
      });
    }
  }

  it.each(["/admin/ops-alerts", "/admin/audit", `/admin/studios/${STUDIO_B}`])(
    "the privileged marker reaches the %s body for the admin, so the absence checks are not vacuous",
    async (path) => {
      signIn(ADMIN);
      const out = await serve("rsc", PAGES.find((p) => p.path === path)!);
      expect(out.status).toBe(200);
      expect(out.body).toContain(PRIVILEGED);
    },
  );
});

// E-GAP (SEC-002): ONE session, minted while its holder is a platform operator,
// then revoked. The identities above are separate users, so none of them
// proves that the SAME signed-in session (same user id, same cookies) loses
// admin access on its next request. Revocation is removing the address from
// ADMIN_EMAILS (lib/admin.ts reads it on every call), or ADMIN_EMAILS becoming
// empty in production, which fails closed. Nothing about the session changes.
describe("SEC-002 request level: a session minted while operator is refused after revocation", () => {
  const SAME_SESSION_USER = { id: "user-revoked-operator-session", email: OPERATOR };

  function mintOperatorSession(memberships: { studio_id: string }[]) {
    h.user = SAME_SESSION_USER;
    h.memberships = memberships;
  }
  function resetPrivilegedCounters() {
    h.adminConstructions = 0;
    h.tables = [];
  }

  const revocations: Array<[string, () => void]> = [
    ["removed from ADMIN_EMAILS", () => vi.stubEnv("ADMIN_EMAILS", "second-operator@platform.test")],
    ["ADMIN_EMAILS emptied in production", () => vi.stubEnv("ADMIN_EMAILS", "")],
  ];

  for (const [revocation, revoke] of revocations) {
    for (const page of PAGES) {
      for (const kind of KINDS) {
        it(`no studio, ${revocation}: ${kind} ${page.path} is served before, refused after, by the middleware`, async () => {
          mintOperatorSession([]);
          const before = await serve(kind, page);
          expect(before.status).toBe(200);
          expect(h.adminConstructions).toBeGreaterThan(0);

          revoke();
          resetPrivilegedCounters();
          expect(h.user).toBe(SAME_SESSION_USER);
          const after = await serve(kind, page);
          expect(after.stage).toBe("middleware");
          expect(after.status).toBe(307);
          expect(new URL(after.location!).pathname).toBe("/no-access");
          expect(after.body).not.toContain(PRIVILEGED);
          expect(h.adminConstructions).toBe(0);
          expect(h.tables).toEqual([]);
        });

        it(`still a studio member, ${revocation}: ${kind} ${page.path} is served before, refused after, by layout and page`, async () => {
          mintOperatorSession([{ studio_id: STUDIO_B }]);
          const before = await serve(kind, page);
          expect(before.status).toBe(200);
          expect(h.adminConstructions).toBeGreaterThan(0);

          revoke();
          resetPrivilegedCounters();
          expect(h.user).toBe(SAME_SESSION_USER);
          const after = await serve(kind, page);
          expect(after.stage).toBe("render");
          if (kind === "document") {
            expect(after.status).toBe(307);
            expect(after.location).toBe("/dashboard");
          } else if (page.refusal === "not-found") {
            expect(after.status).toBe(404);
          } else {
            expect(after.status).toBe(307);
            expect(after.location).toBe("/no-access");
          }
          expect(after.body).not.toContain(PRIVILEGED);
          expect(h.adminConstructions).toBe(0);
          expect(h.tables).toEqual([]);
        });
      }
    }
  }

  it("covers EVERY admin page on disk, both request kinds, both revocations", async () => {
    const { readdirSync } = await import("node:fs");
    const { join, relative, resolve } = await import("node:path");
    const root = resolve(__dirname, "../../app/admin");
    const onDisk: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name === "page.tsx") onDisk.push(relative(root, dir) || ".");
      }
    };
    walk(root);
    const covered = PAGES.map((p) => {
      const route = p.path.split("?")[0].replace(`/${STUDIO_B}`, "/[id]").replace(/^\/admin\/?/, "");
      return route === "" ? "." : route;
    });
    expect([...new Set(covered)].sort()).toEqual(onDisk.sort());
    expect(KINDS).toEqual(["document", "rsc"]);
    expect(revocations).toHaveLength(2);
  });
});
