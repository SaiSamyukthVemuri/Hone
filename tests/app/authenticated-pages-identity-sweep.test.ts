import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import {
  getAccessFallbackHTTPStatus,
  isHTTPAccessFallbackError,
} from "next/dist/client/components/http-access-fallback/http-access-fallback";

// ===========================================================================
// SENTRY-IDENTITY-01 — the identity boundary of EVERY authenticated page,
// proved by behaviour.
// ===========================================================================
//
// The Sentry group "No active practitioner found for the signed-in user." on
// /calendar/[id] was a page throwing on an identity state it could not serve.
// Next renders a route's layouts and its page in parallel, and a soft
// navigation does not re-render the shell layout at all, so no layout guard
// protects a page: each page must turn every identity state it cannot serve
// into a controlled navigation ITSELF.
//
// This sweep renders every page under app/(app)/ for real — its own module, its
// own imports, and the REAL resolvers in lib/supabase/queries.ts — against a
// fake Supabase client, in each identity state, and asserts what the page DID:
//
//   no active membership           -> redirect("/no-access")
//   2+ memberships, no selection   -> redirect("/no-access?reason=multiple-studios")
//   no auth user                   -> redirect("/login")
//   the membership read FAILS      -> a loud error (never a quiet "no access")
//
// and that nothing but the identity read itself ran first: no domain table, no
// RPC, no service-role client. Because it observes behaviour, the syntax a page
// uses to reach identity does not matter — an aliased, parenthesised,
// forwarded or wrapped call to the throwing backstop still throws here, and a
// page that resolves no identity at all still renders or reads here; either
// fails the expectation. tests/source-guards/server-render-identity-guard.test.ts
// is the fast syntactic hint; this file is the authority for pages.

const ROOT = path.resolve(__dirname, "../..");
const APP_GROUP = path.join(ROOT, "app", "(app)");
const ANY_ID = "00000000-0000-4000-8000-000000000000";

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  rows: [] as Array<Record<string, unknown>>,
  membershipError: null as { message: string } | null,
  selectedStudioId: null as string | null,
  // Everything the page touched, in order: "practitioners" is the identity
  // read itself; anything else ran before (or instead of) the boundary.
  touched: [] as string[],
}));

vi.mock("next/headers", () => {
  const empty = {
    get: () => undefined,
    getAll: () => [],
    has: () => false,
    set: () => {},
    delete: () => {},
  };
  return {
    cookies: async () => empty,
    headers: async () => new Headers(),
    draftMode: async () => ({ isEnabled: false }),
  };
});

vi.mock("@/lib/supabase/selected-studio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/selected-studio")>()),
  readSelectedStudioId: async () => state.selectedStudioId,
}));

vi.mock("@/lib/supabase/server", () => {
  // A PostgREST-shaped builder: every chain method returns the builder, and
  // awaiting it settles. Only the identity read returns rows.
  const builder = (table: string) => {
    const settle = () =>
      table === "practitioners"
        ? state.membershipError
          ? { data: null, error: state.membershipError }
          : { data: state.rows, error: null }
        : { data: null, error: null, count: 0 };
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              Promise.resolve().then(settle).then(resolve, reject);
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  };
  return {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
      from: (table: string) => {
        state.touched.push(table);
        return builder(table);
      },
      rpc: (fn: string) => {
        state.touched.push(`rpc:${fn}`);
        return builder(`rpc:${fn}`);
      },
    }),
  };
});

vi.mock("@/lib/supabase/admin-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/admin-server")>()),
  createAdminClient: () => {
    state.touched.push("SERVICE-ROLE CLIENT");
    throw new Error("the sweep never reaches a service-role read");
  },
}));

type Outcome =
  | { kind: "redirect"; url: string }
  | { kind: "notFound" }
  | { kind: "error"; message: string }
  | { kind: "rendered" };

async function outcomeOf(render: () => Promise<unknown>): Promise<Outcome> {
  try {
    await render();
    return { kind: "rendered" };
  } catch (err) {
    if (isRedirectError(err)) return { kind: "redirect", url: getURLFromRedirectError(err) };
    if (isHTTPAccessFallbackError(err) && getAccessFallbackHTTPStatus(err) === 404) {
      return { kind: "notFound" };
    }
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

// Any route param reads as a well-formed id; no search params.
const PARAMS = new Proxy({}, { get: (_t, key) => (typeof key === "string" ? ANY_ID : undefined) });

type PageModule = {
  default: (props: { params: Promise<unknown>; searchParams: Promise<unknown> }) => unknown;
};
const loaded = new Map<string, PageModule>();

async function renderPage(rel: string): Promise<Outcome> {
  const mod = loaded.get(rel);
  if (!mod) throw new Error(`page module was not loaded: ${rel}`);
  return outcomeOf(async () =>
    mod.default({ params: Promise.resolve(PARAMS), searchParams: Promise.resolve({}) }),
  );
}

function walkPages(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkPages(full, out);
    else if (/^page\.(tsx|ts|jsx|js)$/.test(entry.name)) {
      out.push(path.relative(ROOT, full).split(path.sep).join("/"));
    }
  }
  return out;
}

// The E2E failure-injection fixture is a plain 404 that reads NOTHING unless
// its server-only activation marker is set; with it set, it is an ordinary
// authenticated page. Both halves are asserted below.
const E2E_FIXTURE = "app/(app)/e2e-fault/[case]/page.tsx";
const PAGES = walkPages(APP_GROUP).sort();

// Load every page module ONCE, up front: importing a page pulls in its whole
// module graph, and that one-time cost must not be charged to whichever
// identity assertion happens to run first.
beforeAll(async () => {
  for (const rel of PAGES) {
    loaded.set(rel, (await import(path.join(ROOT, rel))) as PageModule);
  }
}, 180_000);

function membership(studioId: string, role: "owner" | "practitioner" = "owner") {
  return {
    id: `prac-${studioId}`,
    user_id: "user-1",
    studio_id: studioId,
    role,
    active: true,
    studio: { id: studioId, name: `Studio ${studioId}`, slug: `studio-${studioId}`, timezone: "UTC" },
  };
}

beforeEach(() => {
  state.user = { id: "user-1" };
  state.rows = [];
  state.membershipError = null;
  state.selectedStudioId = null;
  state.touched = [];
  vi.unstubAllEnvs();
  // The fault fixture is swept as the ordinary authenticated page it is under
  // its marker (its unmarked 404 is asserted separately below). Every deployed-
  // runtime signal it checks is held empty so the marker is honoured on any
  // runner, never mistaken for a deployment.
  vi.stubEnv("HONE_E2E_ROUTE_FAULT", "1");
  for (const signal of ["VERCEL", "VERCEL_ENV", "AWS_REGION", "AWS_EXECUTION_ENV", "KUBERNETES_SERVICE_HOST"]) {
    vi.stubEnv(signal, "");
  }
});

const onlyTheIdentityRead = () => expect(state.touched.filter((t) => t !== "practitioners")).toEqual([]);

describe.each(PAGES)("%s", (rel) => {
  it("no active membership -> /no-access, before reading anything else", async () => {
    state.rows = [];
    expect(await renderPage(rel)).toEqual({ kind: "redirect", url: "/no-access" });
    onlyTheIdentityRead();
  });

  it("2+ memberships with no selection -> the chooser, never an auto-picked studio", async () => {
    state.rows = [membership("s1"), membership("s2", "practitioner")];
    expect(await renderPage(rel)).toEqual({
      kind: "redirect",
      url: "/no-access?reason=multiple-studios",
    });
    onlyTheIdentityRead();
  });

  it("no auth user -> /login, having read nothing", async () => {
    state.user = null;
    expect(await renderPage(rel)).toEqual({ kind: "redirect", url: "/login" });
    expect(state.touched).toEqual([]);
  });

  it("a FAILED membership read stays loud", async () => {
    state.membershipError = { message: "connection terminated" };
    expect(await renderPage(rel)).toEqual({
      kind: "error",
      message: "Failed to load practitioner: connection terminated",
    });
    onlyTheIdentityRead();
  });
});

describe("the E2E fault fixture without its activation marker", () => {
  it("is a plain 404 that reads nothing, whatever the identity state", async () => {
    vi.unstubAllEnvs();
    state.rows = [];
    expect(await renderPage(E2E_FIXTURE)).toEqual({ kind: "notFound" });
    expect(state.touched).toEqual([]);
  });
});

describe("anti-vacuity: the sweep can see what it rules out", () => {
  it("covers the authenticated app's pages, including the incident page", () => {
    // A floor, not a pin: adding a page must not red this file.
    expect(PAGES.length).toBeGreaterThan(30);
    expect(PAGES).toContain("app/(app)/calendar/[id]/page.tsx");
    expect(PAGES).toContain(E2E_FIXTURE);
  });

  it("with a usable identity a page goes on to read its domain data (the recorder works)", async () => {
    state.rows = [membership("s1")];
    const outcome = await renderPage("app/(app)/calendar/[id]/page.tsx");
    // The fake answers every domain read with nothing, so the appointment is
    // not found — but only AFTER identity resolved and the page read on.
    expect(outcome).toEqual({ kind: "notFound" });
    expect(state.touched).toContain("appointments");
  });

  it("a page that reaches the throwing backstop by ANY route fails the expectation", async () => {
    const { getCurrentPractitionerWithStudio } = await import("@/lib/supabase/queries");
    const aliased = getCurrentPractitionerWithStudio;
    const forwardedThroughAWrapper = async () => (aliased)();
    state.rows = [];
    expect(await outcomeOf(forwardedThroughAWrapper)).toEqual({
      kind: "error",
      message: "No active practitioner found for the signed-in user.",
    });
  });

  it("a page that resolves no identity at all fails the expectation", async () => {
    state.rows = [];
    expect(await outcomeOf(async () => "<form />")).toEqual({ kind: "rendered" });
  });
});
