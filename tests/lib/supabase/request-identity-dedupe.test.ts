import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

// PERF-01A — one identity resolution per authenticated request.
//
// WHAT THIS PROVES, and why the harness looks the way it does.
//
// A single authenticated navigation used to resolve identity three times: the
// shell's requirePractitionerWithStudio(), the shell's
// listActiveStudioMemberships(), and the page's
// getCurrentPractitionerWithStudio(). Each did `auth.getUser()` — a real GoTrue
// round trip, not a cookie read — followed by a membership select that cannot
// start until it returns. Six serial round trips before the page's own reads.
//
// THE HARNESS USES REACT'S ACTUAL REQUEST SCOPE, NOT A STAND-IN.
//
// An earlier revision of this file mocked `cache()` with a hand-rolled memo and
// called `vi.resetModules()` between the two "requests". That was VACUOUS as a
// cross-request proof: resetting modules re-evaluates queries.ts and builds a
// fresh closure, so a module-global identity cache — the exact regression this
// file exists to catch — would have leaked in production while the test stayed
// green. Production never reloads lib/supabase/queries.ts between requests.
//
// So this file loads React's real `react-server` build (the one Next runs on
// the server) and drives the one thing that actually delimits a request:
// `ReactSharedInternals.A`, the cache dispatcher. That is the same hook Next
// sets per request — `cache()` reads it, and with no dispatcher present it
// simply calls through, which is why every OTHER suite that drives these
// wrappers keeps resolving fresh and needed no change.
//
// queries.ts is imported ONCE, at the top of this file, and never re-imported.
// Two requests are two dispatchers against that one module instance.

/** React's server build — resolved through the package's own export map. */
function loadReactServer() {
  const req = createRequire(import.meta.url);
  const pkgPath = req.resolve("react/package.json");
  const entry = req(pkgPath)?.exports?.["."]?.["react-server"];
  if (typeof entry !== "string") {
    throw new Error(
      "react/package.json no longer declares a `react-server` export; this " +
        "harness must be re-pointed at whatever now provides the server cache.",
    );
  }
  return req(path.resolve(path.dirname(pkgPath), entry));
}

// `queries.ts` must receive the REAL server `cache`, not a stand-in.
vi.mock("react", async () => {
  const server = loadReactServer();
  return { ...server, default: server };
});

const REACT_SERVER = loadReactServer();
const INTERNALS =
  REACT_SERVER.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

let mockUser: { id: string } | null = { id: "user-1" };
let mockRows: Array<Record<string, unknown>> = [];
let mockSelectedStudioId: string | null = null;
let mockSelectError: { message: string } | null = null;

// The two PHYSICAL calls this ticket is about.
let getUserCalls = 0;
let membershipSelects = 0;
let clientBuilds = 0;
let cookieReads = 0;

vi.mock("@/lib/supabase/selected-studio", () => ({
  readSelectedStudioId: async () => {
    cookieReads++;
    return mockSelectedStudioId;
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    clientBuilds++;
    return {
      auth: {
        getUser: async () => {
          getUserCalls++;
          return { data: { user: mockUser } };
        },
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: async () => {
              membershipSelects++;
              return {
                data: mockSelectError ? null : mockRows,
                error: mockSelectError,
              };
            },
          }),
        }),
      }),
    };
  },
}));

// ONE import. Never re-imported, never reset. Everything below runs against
// this single module instance, exactly as production does.
import * as queries from "@/lib/supabase/queries";

// ---------------------------------------------------------------------------
// The request scope
// ---------------------------------------------------------------------------
// A dispatcher exposing `getCacheForType`, which is the whole contract React's
// `cache()` consumes: it hands the factory in and expects one store back per
// request. Next's own per-request implementation has this shape.
function makeRequestScope() {
  const store = new Map<unknown, unknown>();
  return {
    getCacheForType<T>(factory: () => T): T {
      if (!store.has(factory)) store.set(factory, factory());
      return store.get(factory) as T;
    },
  };
}

/** Run `fn` inside its own request scope, with fresh physical-call counters. */
async function runRequest<T>(fn: () => Promise<T>): Promise<T> {
  const previous = INTERNALS.A;
  INTERNALS.A = makeRequestScope();
  getUserCalls = 0;
  membershipSelects = 0;
  clientBuilds = 0;
  cookieReads = 0;
  try {
    return await fn();
  } finally {
    INTERNALS.A = previous;
  }
}

function row(role: "owner" | "practitioner", studioId: string) {
  return {
    id: `p-${studioId}`,
    user_id: "user-1",
    studio_id: studioId,
    role,
    active: true,
    studio: { id: studioId, name: `Studio ${studioId}` },
  };
}

beforeEach(() => {
  redirectMock.mockClear();
  mockUser = { id: "user-1" };
  mockRows = [];
  mockSelectedStudioId = null;
  mockSelectError = null;
});

// ---------------------------------------------------------------------------
// 0. The harness itself is not vacuous
// ---------------------------------------------------------------------------

describe("the harness stands up a real request scope", () => {
  it("uses React's own server cache, not a stand-in", async () => {
    expect(typeof REACT_SERVER.cache).toBe("function");
    expect(INTERNALS, "react-server internals are unavailable").toBeTruthy();
    // The dispatcher slot is what delimits a request. If React stopped reading
    // it, every dedupe assertion below would silently become a no-op.
    expect(INTERNALS).toHaveProperty("A");
  });

  it("dedupes INSIDE a scope and isolates BETWEEN scopes", async () => {
    let calls = 0;
    const probe = REACT_SERVER.cache(async (tag: string) => {
      calls++;
      return tag;
    });
    const a = await runRequest(async () => [
      await probe("A"),
      await probe("A"),
    ]);
    expect(calls, "one physical call inside one scope").toBe(1);
    expect(a[0]).toBe("A");
    const b = await runRequest(async () => probe("B"));
    expect(calls, "the second scope did its own work").toBe(2);
    expect(b).toBe("B");
  });

  it("ANTI-VACUITY: a module-global cache DOES leak across these two scopes", async () => {
    // The regression this file guards against, implemented deliberately here.
    // It is defined ONCE at this module's scope — like a module-global inside
    // queries.ts would be — and is NOT wrapped in cache().
    let leakyCalls = 0;
    let leaked: string | null = null;
    const moduleGlobalIdentity = async (tag: string) => {
      if (leaked === null) {
        leakyCalls++;
        leaked = tag;
      }
      return leaked;
    };

    const a = await runRequest(() => moduleGlobalIdentity("user-A"));
    const b = await runRequest(() => moduleGlobalIdentity("user-B"));

    // Request B sees request A's identity. THIS is what a module-global does,
    // and it is why the assertions below are meaningful rather than tautological.
    expect(a).toBe("user-A");
    expect(b, "a module-global leaks A into B").toBe("user-A");
    expect(leakyCalls).toBe(1);

    // It also proves the harness RETAINS ONE MODULE INSTANCE across the two
    // requests: had anything reloaded modules between them, this closure would
    // have been rebuilt and the leak could not have been observed.
  });
});

// ---------------------------------------------------------------------------
// 1. One navigation, one resolution
// ---------------------------------------------------------------------------

describe("one authenticated navigation resolves identity ONCE", () => {
  it("shell identity + shell memberships + page identity cost 1 getUser and 1 select", async () => {
    mockRows = [row("owner", "studio-a")];

    const out = await runRequest(async () => {
      const shell = await queries.requirePractitionerWithStudio(); // layout
      const memberships = await queries.listActiveStudioMemberships(); // layout
      const page = await queries.getCurrentPractitionerWithStudio(); // page
      return { shell, memberships, page };
    });

    expect(getUserCalls, "auth.getUser() per authenticated request").toBe(1);
    expect(membershipSelects, "active-membership selects per request").toBe(1);
    expect(clientBuilds, "one Supabase client, not three").toBe(1);

    expect(out.shell.studio.id).toBe("studio-a");
    expect(out.page.studio.id).toBe("studio-a");
    expect(out.memberships).toHaveLength(1);
  });

  it("repeated resolution inside one request stays flat, not linear", async () => {
    mockRows = [row("owner", "studio-a")];
    await runRequest(async () => {
      for (let i = 0; i < 8; i++) {
        await queries.getCurrentPractitionerWithStudio();
      }
    });
    expect(getUserCalls).toBe(1);
    expect(membershipSelects).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. The cross-request claim, against ONE module instance
// ---------------------------------------------------------------------------

describe("two requests against the SAME loaded module never share identity", () => {
  it("request B resolves its own user and studio, never A's", async () => {
    // REQUEST A — user-1 in studio-a.
    mockUser = { id: "user-1" };
    mockRows = [row("owner", "studio-a")];
    const a = await runRequest(async () => {
      const shell = await queries.requirePractitionerWithStudio();
      const page = await queries.getCurrentPractitionerWithStudio();
      return { shell, page, getUserCalls, membershipSelects };
    });

    // REQUEST B — a DIFFERENT user, a DIFFERENT studio. No module reload
    // between them: the only thing that changed is the request scope.
    mockUser = { id: "user-2" };
    mockRows = [
      {
        id: "p-studio-b",
        user_id: "user-2",
        studio_id: "studio-b",
        role: "practitioner",
        active: true,
        studio: { id: "studio-b", name: "Studio studio-b" },
      },
    ];
    const b = await runRequest(async () => {
      const shell = await queries.requirePractitionerWithStudio();
      const page = await queries.getCurrentPractitionerWithStudio();
      const memberships = await queries.listActiveStudioMemberships();
      return { shell, page, memberships, getUserCalls, membershipSelects };
    });

    // A saw only A.
    expect(a.shell.studio.id).toBe("studio-a");
    expect(a.page.studio.id).toBe("studio-a");

    // B saw only B — no identity, studio or membership crossed the boundary.
    expect(b.shell.studio.id, "request B inherited request A's studio").toBe(
      "studio-b",
    );
    expect(b.page.studio.id).toBe("studio-b");
    expect(b.page.practitioner.user_id).toBe("user-2");
    expect(b.memberships.map((m) => m.studioId)).toEqual(["studio-b"]);

    // ...and each request paid for its own resolution exactly once.
    expect(a.getUserCalls).toBe(1);
    expect(a.membershipSelects).toBe(1);
    expect(b.getUserCalls, "request B re-validated the session").toBe(1);
    expect(b.membershipSelects).toBe(1);
  });

  it("a session revoked between requests is refused on the next one", async () => {
    mockRows = [row("owner", "studio-a")];
    await runRequest(() => queries.requirePractitionerWithStudio());

    // The token stops validating. Nothing may be served from the prior request.
    mockUser = null;
    await runRequest(async () => {
      await expect(queries.requirePractitionerWithStudio()).rejects.toThrow(
        "REDIRECT:/login",
      );
      expect(await queries.listActiveStudioMemberships()).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. The selection is re-read, never memoised with the rows
// ---------------------------------------------------------------------------

describe("the selected-studio cookie is not memoised with the rows", () => {
  it("a stale cookie is still refused inside a memoised request", async () => {
    mockRows = [row("owner", "studio-a"), row("practitioner", "studio-b")];
    mockSelectedStudioId = "studio-ZZZ"; // matches no active membership
    await runRequest(async () => {
      await expect(queries.getCurrentPractitionerWithStudio()).rejects.toThrow(
        /Multiple active studio memberships/,
      );
      await expect(queries.requirePractitionerWithStudio()).rejects.toThrow(
        "REDIRECT:/no-access?reason=multiple-studios",
      );
      expect(getUserCalls, "still one identity read").toBe(1);
    });
  });

  it("a selection made mid-request is honoured by the next wrapper call", async () => {
    mockRows = [row("owner", "studio-a"), row("practitioner", "studio-b")];
    mockSelectedStudioId = null;
    await runRequest(async () => {
      await expect(queries.getCurrentPractitionerWithStudio()).rejects.toThrow(
        /Multiple active studio memberships/,
      );
      // e.g. a server action just set the cookie. The rows are memoised; the
      // SELECTION is not, so this resolves without another identity round trip.
      mockSelectedStudioId = "studio-b";
      const after = await queries.getCurrentPractitionerWithStudio();
      expect(after.studio.id).toBe("studio-b");
      expect(getUserCalls).toBe(1);
      expect(cookieReads, "the cookie is read per call").toBeGreaterThan(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Every gate still fires on the shared read
// ---------------------------------------------------------------------------

describe("every gate still fires on the shared read", () => {
  it("anonymous -> /login, and no memberships are listed", async () => {
    mockUser = null;
    await runRequest(async () => {
      await expect(queries.requirePractitionerWithStudio()).rejects.toThrow(
        "REDIRECT:/login",
      );
      await expect(queries.getCurrentPractitionerWithStudio()).rejects.toThrow(
        "REDIRECT:/login",
      );
      expect(await queries.listActiveStudioMemberships()).toEqual([]);
      expect(
        membershipSelects,
        "an anonymous request never queries memberships",
      ).toBe(0);
    });
  });

  it("authenticated with no membership -> /no-access (invite-only gate)", async () => {
    mockRows = [];
    await runRequest(async () => {
      await expect(queries.requirePractitionerWithStudio()).rejects.toThrow(
        "REDIRECT:/no-access",
      );
      await expect(queries.getCurrentPractitionerWithStudio()).rejects.toThrow(
        /No active practitioner found/,
      );
    });
  });

  it("a failed membership read still surfaces, never becomes 'no memberships'", async () => {
    mockSelectError = { message: "boom" };
    await runRequest(async () => {
      await expect(queries.listActiveStudioMemberships()).rejects.toThrow(
        /Failed to load practitioner: boom/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Source pins — scoped to the code they are about
// ---------------------------------------------------------------------------

const QUERIES_PATH = path.resolve(
  __dirname,
  "../../../lib/supabase/queries.ts",
);
const QUERIES_RAW = readFileSync(QUERIES_PATH, "utf8");
// Pin the CODE, not the prose: the module's header explains what
// `auth.getUser()` costs and which caches are forbidden, so a whole-file regex
// matches the explanation and reports the opposite of the truth.
const QUERIES = QUERIES_RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /^\s*\/\/.*$/gm,
  "",
);

/**
 * The body of ONE named function declaration, via the TypeScript AST.
 *
 * A whole-file regex cannot make a claim about a specific function: this module
 * is ~1000 lines and unrelated practitioner queries carry the very same
 * predicates, so a file-wide `.eq("active", true)` search stays green even if
 * the membership loader drops it — while memoised identity starts authorizing
 * INACTIVE memberships. Same AST idiom as tests/security/helpers/supabase-write-census.ts.
 */
function functionBody(source: string, name: string): string | null {
  const sf = ts.createSourceFile(
    "queries.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  let body: string | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) {
      body = n.body.getText(sf);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return body;
}

/** Both tenancy predicates, required WITHIN the membership loader itself. */
function loaderScoping(source: string) {
  const body = functionBody(source, "loadActiveMembershipRows");
  return {
    found: body !== null,
    userScoped: body !== null && /\.eq\(\s*"user_id"\s*,\s*userId\s*\)/.test(body),
    activeScoped: body !== null && /\.eq\(\s*"active"\s*,\s*true\s*\)/.test(body),
  };
}

describe("source pins — the wrappers consume the shared authority", () => {
  const authorityBody = (() => {
    const i = QUERIES.indexOf("const loadRequestIdentity = cache(");
    expect(i, "the request-scoped authority is missing").toBeGreaterThan(-1);
    return QUERIES.slice(i, i + 600);
  })();

  it("identity is memoised with React cache(), not a forbidden cache", () => {
    expect(QUERIES).toMatch(/import \{ cache \} from "react"/);
    expect(QUERIES).toMatch(/const loadRequestIdentity = cache\(/);
    // None of the caches this work forbids: no time-based revalidation, no Next
    // data cache, no module-global store that would outlive the response.
    expect(QUERIES).not.toMatch(/unstable_cache/);
    expect(QUERIES).not.toMatch(/revalidate\s*:/);
    expect(QUERIES).not.toMatch(/globalThis\./);
  });

  it("no wrapper calls auth.getUser() on its own any more", () => {
    const calls = QUERIES.match(/auth\s*\.\s*getUser\s*\(/g) ?? [];
    expect(calls, "exactly one getUser call site remains").toHaveLength(1);
    expect(authorityBody).toMatch(/auth\s*\.\s*getUser\s*\(/);
  });

  it("the redirects stay OUT of the memoised function", () => {
    // A redirect is a thrown control-flow signal; memoising one would cache a
    // navigation rather than an identity.
    expect(authorityBody).not.toMatch(/redirect\(/);
  });
});

describe("source pins — the membership read stays tenancy-scoped (RLS unchanged)", () => {
  it("BOTH predicates live inside loadActiveMembershipRows itself", () => {
    const s = loaderScoping(QUERIES_RAW);
    expect(s.found, "loadActiveMembershipRows was renamed or removed").toBe(true);
    expect(s.userScoped, 'the loader lost .eq("user_id", userId)').toBe(true);
    expect(s.activeScoped, 'the loader lost .eq("active", true)').toBe(true);
  });

  it("the loader does not use maybeSingle (it errors on 2+ memberships)", () => {
    const body = functionBody(QUERIES_RAW, "loadActiveMembershipRows");
    expect(body).not.toMatch(/maybeSingle/);
  });

  // NEGATIVE CONTROLS. Each fixture keeps an UNRELATED function carrying both
  // predicates, so a file-wide search would pass every one of them. The checker
  // must not.
  const UNRELATED = `
    async function getPractitionersForStudio(supabase: S, studioId: string) {
      return supabase.from("practitioners").select("*")
        .eq("user_id", userId).eq("active", true).eq("studio_id", studioId);
    }
  `;
  const loader = (predicates: string) => `
    async function loadActiveMembershipRows(supabase: S, userId: string) {
      const { data, error } = await supabase
        .from("practitioners").select("*, studio:studios(*)")${predicates};
      if (error) throw new Error("Failed to load practitioner: " + error.message);
      return data ?? [];
    }
  `;

  it("RED when the loader loses the user_id predicate", () => {
    const src = UNRELATED + loader(`.eq("active", true)`);
    expect(src, "fixture must still contain the token file-wide").toMatch(
      /\.eq\("user_id", userId\)/,
    );
    const s = loaderScoping(src);
    expect(s.found).toBe(true);
    expect(s.userScoped, "an unrelated query satisfied the user filter").toBe(
      false,
    );
  });

  it("RED when the loader loses the active predicate", () => {
    const src = UNRELATED + loader(`.eq("user_id", userId)`);
    expect(src).toMatch(/\.eq\("active", true\)/);
    const s = loaderScoping(src);
    expect(s.found).toBe(true);
    expect(s.activeScoped, "an unrelated query satisfied the active filter").toBe(
      false,
    );
  });

  it("RED when the loader is renamed away entirely", () => {
    const s = loaderScoping(UNRELATED);
    expect(s.found).toBe(false);
    expect(s.userScoped).toBe(false);
    expect(s.activeScoped).toBe(false);
  });

  it("GREEN on the real module — the control discriminates", () => {
    const s = loaderScoping(QUERIES_RAW);
    expect([s.found, s.userScoped, s.activeScoped]).toEqual([true, true, true]);
  });
});
