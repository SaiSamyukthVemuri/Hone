import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// PERF-01A — one identity resolution per authenticated request, proven at the
// seam where the security property actually lives.
//
// THE CHANGE THIS FILE IS PAYING FOR
// ----------------------------------
// A single authenticated navigation used to resolve identity three times: the
// shell's requirePractitionerWithStudio(), the shell's
// listActiveStudioMemberships(), and the page's
// getCurrentPractitionerWithStudio(). Each did `auth.getUser()` — a real GoTrue
// round trip, not a cookie read — followed by a membership select that cannot
// start until it returns. Six serial round trips before the page's own reads.
// One request-scoped authority replaced them with one of each.
//
// WHY THE PROOF LOOKS LIKE THIS
// -----------------------------
// An earlier version of this file tried to prove the tenancy property by
// STATIC ANALYSIS: parse queries.ts, find the loader, resolve the returned
// identifier, walk the query chain, assert the predicates. Four rounds of
// review found four different ways for that to be true of the source text and
// false of the program — declaration shadowing, multiple return paths, bindings
// introduced by `catch`/`for`, reassignment of a mutable binding. Each fix was
// correct and each left the adjacent hole open, because the analysis was
// reimplementing TypeScript's name resolution and control flow in a unit test.
//
// That approach is WITHDRAWN. The question it was straining to answer —
// "is the membership read scoped to this user's ACTIVE rows?" — is answerable
// directly, by running the real production wrappers against a query builder
// that RECORDS what was asked for and APPLIES it to a discriminating fixture.
// If the loader stops filtering, forbidden rows come back and the recorded
// operations no longer contain the predicate. No parser can disagree with that,
// because it is the program running.
//
// The request scope is still real: React's own `react-server` build, driven
// through `ReactSharedInternals.A` — the dispatcher Next sets per request and
// the one `cache()` reads. queries.ts is imported ONCE and never re-imported;
// two requests are two dispatchers against that one module instance.

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

// ---------------------------------------------------------------------------
// The fixture — every row is there to make a predicate load-bearing
// ---------------------------------------------------------------------------
// user-1 ACTIVE   in studio-A   <- the only row a correct loader may return
// user-1 INACTIVE in studio-B   <- survives if `.eq("active", true)` is lost
// user-2 ACTIVE   in studio-C   <- survives if `.eq("user_id", …)` is lost
// user-2 INACTIVE in studio-D   <- survives only if BOTH are lost
type Row = {
  id: string;
  user_id: string;
  studio_id: string;
  role: string;
  active: boolean;
  studio: { id: string; name: string };
};

function practitioner(
  studio: string,
  user: string,
  active: boolean,
  role = "owner",
): Row {
  return {
    id: `p-${studio}`,
    user_id: user,
    studio_id: `studio-${studio}`,
    role,
    active,
    studio: { id: `studio-${studio}`, name: `Studio ${studio}` },
  };
}

const DISCRIMINATING: Row[] = [
  practitioner("A", "user-1", true),
  practitioner("B", "user-1", false),
  practitioner("C", "user-2", true),
  practitioner("D", "user-2", false, "practitioner"),
];

/** user-1 active in TWO studios, for the chooser paths. */
const MULTI: Row[] = [
  practitioner("A", "user-1", true),
  practitioner("B", "user-1", true, "practitioner"),
  practitioner("C", "user-2", true),
];

// ---------------------------------------------------------------------------
// A PostgREST-shaped fake that records what production asked for
// ---------------------------------------------------------------------------
type RecordedQuery = {
  table: string;
  select: string | null;
  filters: Array<[string, unknown]>;
};

type Ctx = {
  user: { id: string } | null;
  dataset: Row[];
  selectedStudioId: string | null;
  failWith: { message: string } | null;
  /**
   * Filters the FAKE will accept but deliberately not apply. Used only by the
   * fixture-discrimination controls, to show which rows each production
   * predicate is the thing excluding. Never a mutation of production source.
   */
  ignore: string[];
  queries: RecordedQuery[];
  getUserCalls: number;
  clientBuilds: number;
  cookieReads: number;
};

let ctx: Ctx;

function freshCtx(over: Partial<Ctx> = {}): Ctx {
  return {
    user: { id: "user-1" },
    dataset: DISCRIMINATING,
    selectedStudioId: null,
    failWith: null,
    ignore: [],
    queries: [],
    getUserCalls: 0,
    clientBuilds: 0,
    cookieReads: 0,
    ...over,
  };
}

/** Chainable + awaitable, exactly the shape the loader consumes. */
function queryBuilder(table: string) {
  const record: RecordedQuery = { table, select: null, filters: [] };
  ctx.queries.push(record);
  const builder = {
    select(columns: string) {
      record.select = columns;
      return builder;
    },
    eq(column: string, value: unknown) {
      record.filters.push([column, value]);
      return builder;
    },
    then(resolve: (r: { data: Row[] | null; error: unknown }) => void) {
      if (ctx.failWith) {
        resolve({ data: null, error: ctx.failWith });
        return;
      }
      const applied = record.filters.filter(
        ([column]) => !ctx.ignore.includes(column),
      );
      const rows = ctx.dataset.filter((row) =>
        applied.every(
          ([column, value]) => (row as unknown as Record<string, unknown>)[column] === value,
        ),
      );
      resolve({ data: rows, error: null });
    },
  };
  return builder;
}

vi.mock("@/lib/supabase/selected-studio", () => ({
  readSelectedStudioId: async () => {
    ctx.cookieReads++;
    return ctx.selectedStudioId;
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    ctx.clientBuilds++;
    return {
      auth: {
        getUser: async () => {
          ctx.getUserCalls++;
          return { data: { user: ctx.user } };
        },
      },
      from: (table: string) => queryBuilder(table),
    };
  },
}));

// ONE import. Never re-imported, never reset — the production module stays
// loaded across every request below, exactly as it does in a server.
import * as queries from "@/lib/supabase/queries";

// ---------------------------------------------------------------------------
// The request scope
// ---------------------------------------------------------------------------
function makeRequestScope() {
  const store = new Map<unknown, unknown>();
  return {
    getCacheForType<T>(factory: () => T): T {
      if (!store.has(factory)) store.set(factory, factory());
      return store.get(factory) as T;
    },
  };
}

/** Run `fn` as one server request, against its own cache scope. */
async function request<T>(
  over: Partial<Ctx>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = INTERNALS.A;
  INTERNALS.A = makeRequestScope();
  ctx = freshCtx(over);
  try {
    return await fn();
  } finally {
    INTERNALS.A = previous;
  }
}

/** The single membership read a request is allowed to make. */
function theMembershipQuery(): RecordedQuery {
  expect(ctx.queries, "expected exactly one membership query").toHaveLength(1);
  return ctx.queries[0];
}

beforeEach(() => {
  redirectMock.mockClear();
  ctx = freshCtx();
});

// ---------------------------------------------------------------------------
// 1. The harness is a real request scope, and it is not vacuous
// ---------------------------------------------------------------------------

describe("the harness stands up a real request scope", () => {
  it("uses React's own server cache, not a stand-in", () => {
    expect(typeof REACT_SERVER.cache).toBe("function");
    expect(INTERNALS, "react-server internals are unavailable").toBeTruthy();
    expect(INTERNALS).toHaveProperty("A");
  });

  it("ANTI-VACUITY: a module-global cache DOES leak across these two scopes", async () => {
    // The regression the cross-request assertions guard against, implemented
    // here on purpose. It is defined ONCE at this module's scope — as a
    // module-global inside queries.ts would be — and is not wrapped in cache().
    let leaked: string | null = null;
    const moduleGlobalIdentity = async (tag: string) => (leaked ??= tag);

    const a = await request({}, () => moduleGlobalIdentity("user-A"));
    const b = await request({}, () => moduleGlobalIdentity("user-B"));

    expect(a).toBe("user-A");
    expect(b, "a module-global leaks A into B").toBe("user-A");
    // It also proves the harness RETAINS ONE MODULE INSTANCE across requests:
    // had anything reloaded modules, this closure would have been rebuilt and
    // the leak could not have been observed.
  });
});

// ---------------------------------------------------------------------------
// 2. One navigation, one resolution — and the query it actually issued
// ---------------------------------------------------------------------------

describe("one authenticated navigation resolves identity ONCE", () => {
  it("shell identity + shell memberships + page identity cost 1 getUser and 1 query", async () => {
    const out = await request({}, async () => {
      const shell = await queries.requirePractitionerWithStudio(); // layout
      const memberships = await queries.listActiveStudioMemberships(); // layout
      const page = await queries.getCurrentPractitionerWithStudio(); // page
      return { shell, memberships, page };
    });

    expect(ctx.getUserCalls, "auth.getUser() per authenticated request").toBe(1);
    expect(ctx.queries, "membership reads per request").toHaveLength(1);
    expect(ctx.clientBuilds, "one Supabase client, not three").toBe(1);

    expect(out.shell.studio.id).toBe("studio-A");
    expect(out.page.studio.id).toBe("studio-A");
    expect(out.memberships.map((m) => m.studioId)).toEqual(["studio-A"]);
  });

  it("repeated resolution inside one request stays flat, not linear", async () => {
    await request({}, async () => {
      for (let i = 0; i < 8; i++) {
        await queries.getCurrentPractitionerWithStudio();
      }
    });
    expect(ctx.getUserCalls).toBe(1);
    expect(ctx.queries).toHaveLength(1);
  });
});

describe("the membership read is scoped to the caller's own ACTIVE rows", () => {
  it("asks practitioners for user_id = the authenticated user AND active = true", async () => {
    await request({}, () => queries.listActiveStudioMemberships());

    const query = theMembershipQuery();
    // Recorded operations: a production predicate that disappears makes this
    // RED without anyone re-reading the source.
    expect(query.table).toBe("practitioners");
    expect(query.filters).toContainEqual(["user_id", "user-1"]);
    expect(query.filters).toContainEqual(["active", true]);
  });

  it("returns ONLY the caller's active membership — not their inactive one, not another user's", async () => {
    const memberships = await request({}, () =>
      queries.listActiveStudioMemberships(),
    );
    const studios = memberships.map((m) => m.studioId);

    expect(studios).toEqual(["studio-A"]);
    expect(studios, "an INACTIVE membership of the same user leaked").not.toContain(
      "studio-B",
    );
    expect(studios, "ANOTHER USER's active membership leaked").not.toContain(
      "studio-C",
    );
    expect(studios).not.toContain("studio-D");
  });

  it("the authenticated user is the one filtered on, not a constant", async () => {
    await request({ user: { id: "user-2" } }, () =>
      queries.listActiveStudioMemberships(),
    );
    expect(theMembershipQuery().filters).toContainEqual(["user_id", "user-2"]);
  });
});

// ---------------------------------------------------------------------------
// 3. The fixture discriminates — each predicate is load-bearing
// ---------------------------------------------------------------------------
// These drive the SAME production wrapper while the fake declines to apply one
// filter, which shows exactly which rows each production predicate is excluding.
// If a row class were unreachable anyway, the assertions above would pass for
// free; these prove they do not.

describe("each production predicate is what excludes the forbidden rows", () => {
  it("without the user_id filter, ANOTHER USER's active rows come back", async () => {
    const memberships = await request({ ignore: ["user_id"] }, () =>
      queries.listActiveStudioMemberships(),
    );
    expect(memberships.map((m) => m.studioId)).toEqual(["studio-A", "studio-C"]);
  });

  it("without the active filter, the caller's INACTIVE rows come back", async () => {
    const memberships = await request({ ignore: ["active"] }, () =>
      queries.listActiveStudioMemberships(),
    );
    expect(memberships.map((m) => m.studioId)).toEqual(["studio-A", "studio-B"]);
  });

  it("without either, every forbidden class comes back", async () => {
    const memberships = await request({ ignore: ["user_id", "active"] }, () =>
      queries.listActiveStudioMemberships(),
    );
    expect(memberships.map((m) => m.studioId)).toEqual([
      "studio-A",
      "studio-B",
      "studio-C",
      "studio-D",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Two requests against the SAME loaded module never share identity
// ---------------------------------------------------------------------------

describe("no identity or membership crosses a request boundary", () => {
  it("request B resolves its own user and studio, never A's", async () => {
    const a = await request({}, async () => {
      const shell = await queries.requirePractitionerWithStudio();
      const page = await queries.getCurrentPractitionerWithStudio();
      return { shell, page, getUserCalls: ctx.getUserCalls, reads: ctx.queries.length };
    });

    // A DIFFERENT user, on the next request. No module reload between them:
    // the only thing that changed is the request scope.
    const b = await request({ user: { id: "user-2" } }, async () => {
      const shell = await queries.requirePractitionerWithStudio();
      const page = await queries.getCurrentPractitionerWithStudio();
      const memberships = await queries.listActiveStudioMemberships();
      return {
        shell,
        page,
        memberships,
        getUserCalls: ctx.getUserCalls,
        reads: ctx.queries.length,
        filters: ctx.queries[0].filters,
      };
    });

    expect(a.shell.studio.id).toBe("studio-A");
    expect(a.page.studio.id).toBe("studio-A");

    expect(b.shell.studio.id, "request B inherited request A's studio").toBe("studio-C");
    expect(b.page.practitioner.user_id).toBe("user-2");
    expect(b.memberships.map((m) => m.studioId)).toEqual(["studio-C"]);
    expect(b.filters, "request B re-filtered on its own user").toContainEqual([
      "user_id",
      "user-2",
    ]);

    expect(a.getUserCalls).toBe(1);
    expect(a.reads).toBe(1);
    expect(b.getUserCalls, "request B re-validated the session").toBe(1);
    expect(b.reads).toBe(1);
  });

  it("a session revoked between requests is refused on the next one", async () => {
    await request({}, () => queries.requirePractitionerWithStudio());
    await request({ user: null }, async () => {
      await expect(queries.requirePractitionerWithStudio()).rejects.toThrow(
        "REDIRECT:/login",
      );
      expect(await queries.listActiveStudioMemberships()).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. The selection is re-read, never memoised with the rows
// ---------------------------------------------------------------------------

describe("the selected-studio cookie is not memoised with the rows", () => {
  it("a stale or forged cookie is still refused inside a memoised request", async () => {
    await request(
      { dataset: MULTI, selectedStudioId: "studio-ZZZ" },
      async () => {
        await expect(queries.getCurrentPractitionerWithStudio()).rejects.toThrow(
          /Multiple active studio memberships/,
        );
        await expect(queries.requirePractitionerWithStudio()).rejects.toThrow(
          "REDIRECT:/no-access?reason=multiple-studios",
        );
        expect(ctx.getUserCalls, "still one identity read").toBe(1);
      },
    );
  });

  it("a selection made mid-request is honoured by the next wrapper call", async () => {
    await request({ dataset: MULTI }, async () => {
      await expect(queries.getCurrentPractitionerWithStudio()).rejects.toThrow(
        /Multiple active studio memberships/,
      );
      // e.g. a server action just set the cookie. The rows are memoised; the
      // SELECTION is not, so this resolves without another identity round trip.
      ctx.selectedStudioId = "studio-B";
      const after = await queries.getCurrentPractitionerWithStudio();
      expect(after.studio.id).toBe("studio-B");
      expect(ctx.getUserCalls).toBe(1);
      expect(ctx.queries).toHaveLength(1);
      expect(ctx.cookieReads, "the cookie is read per call").toBeGreaterThan(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Every gate still fires on the shared read
// ---------------------------------------------------------------------------

describe("every gate still fires on the shared read", () => {
  it("anonymous -> /login, and no memberships are listed", async () => {
    await request({ user: null }, async () => {
      await expect(queries.requirePractitionerWithStudio()).rejects.toThrow(
        "REDIRECT:/login",
      );
      await expect(queries.getCurrentPractitionerWithStudio()).rejects.toThrow(
        "REDIRECT:/login",
      );
      expect(await queries.listActiveStudioMemberships()).toEqual([]);
      expect(ctx.queries, "an anonymous request never queries memberships").toHaveLength(0);
    });
  });

  it("authenticated with no ACTIVE membership -> /no-access (invite-only gate)", async () => {
    // user-3 has no rows at all; user-1's inactive row must not rescue anyone.
    await request({ user: { id: "user-3" } }, async () => {
      await expect(queries.requirePractitionerWithStudio()).rejects.toThrow(
        "REDIRECT:/no-access",
      );
      await expect(queries.getCurrentPractitionerWithStudio()).rejects.toThrow(
        /No active practitioner found/,
      );
    });
  });

  it("a failed membership read still surfaces, never becomes 'no memberships'", async () => {
    await request({ failWith: { message: "boom" } }, async () => {
      await expect(queries.listActiveStudioMemberships()).rejects.toThrow(
        /Failed to load practitioner: boom/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 7. The one prohibition behaviour cannot observe
// ---------------------------------------------------------------------------
// Everything above proves the identity is request-scoped by running two
// requests. This is the residue: a cache with a TIME dimension could satisfy
// both requests here and still outlive a response in production. Three regexes,
// no parser, and deliberately the only source-level assertion left in the file.

describe("identity is memoised per request, never by any other mechanism", () => {
  const QUERIES = readFileSync(
    path.resolve(__dirname, "../../../lib/supabase/queries.ts"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("uses React cache() and none of the forbidden caches", () => {
    expect(QUERIES).toMatch(/const loadRequestIdentity = cache\(/);
    expect(QUERIES).not.toMatch(/unstable_cache/);
    expect(QUERIES).not.toMatch(/revalidate\s*:/);
    expect(QUERIES).not.toMatch(/globalThis\./);
  });
});
