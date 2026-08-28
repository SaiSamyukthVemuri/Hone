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

// ---------------------------------------------------------------------------
// The membership query itself, bound through the AST
// ---------------------------------------------------------------------------
//
// Two earlier revisions of this proof were vacuous in the same way, one level
// apart. The first searched the WHOLE module for `.eq("active", true)`, which
// unrelated practitioner queries already satisfy. The second narrowed to
// `loadActiveMembershipRows`'s body but still matched raw text, so a comment, a
// string literal, or a second query inside that same function could satisfy it
// while the authored membership chain quietly lost a filter — and memoised
// identity would begin authorizing inactive or cross-user rows.
//
// Text cannot make this claim. So nothing below reads text: it finds the ONE
// chain whose result the loader actually returns, and asks that chain what it
// is. A predicate that is not a link in that chain does not count, wherever
// else it appears.

type ChainLink = { method: string; args: readonly ts.Expression[] };
type MembershipQuery = {
  /** The loader exists, returns an identifier, and that identifier resolves. */
  bound: boolean;
  /**
   * Which declaration was selected, taken from the chain's own `.select(...)`.
   * Fixtures label the visible query "OUTER" and every shadow "SHADOW", so a
   * control can assert WHICH declaration the resolver picked rather than only
   * that the flags came out false.
   */
  selectArg: string | null;
  /** The resolved chain is rooted in `.from("practitioners")`. */
  fromPractitioners: boolean;
  /** `.eq("user_id", <the loader's own userId param>)` is a link in it. */
  userScoped: boolean;
  /** `.eq("active", true)` is a link in it. */
  activeScoped: boolean;
  /** `.maybeSingle()` is NOT a link in it (it errors on 2+ memberships). */
  multiRowSafe: boolean;
};

const NOT_BOUND: MembershipQuery = {
  bound: false,
  selectArg: null,
  fromPractitioners: false,
  userScoped: false,
  activeScoped: false,
  multiRowSafe: false,
};

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "queries.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

/** Strip the wrappers that sit between a return and the expression it names. */
function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(e)) e = e.expression;
    else if (ts.isAsExpression(e)) e = e.expression;
    else if (ts.isNonNullExpression(e)) e = e.expression;
    else if (ts.isAwaitExpression(e)) e = e.expression;
    else if (
      ts.isBinaryExpression(e) &&
      e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      e = e.left; // `data ?? []` names `data`
    } else return e;
  }
}

/** Decompose `x.a(1).b(2)` into its ordered links plus the identifier at the root. */
function chainOf(expr: ts.Expression): { base: string | null; calls: ChainLink[] } {
  const calls: ChainLink[] = [];
  let cur = unwrap(expr);
  while (ts.isCallExpression(cur)) {
    const callee = cur.expression;
    if (!ts.isPropertyAccessExpression(callee)) break;
    calls.unshift({ method: callee.name.text, args: cur.arguments });
    cur = unwrap(callee.expression);
  }
  return { base: ts.isIdentifier(cur) ? cur.text : null, calls };
}

function findFunction(
  sf: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration | null {
  let found: ts.FunctionDeclaration | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) {
      found = n;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/**
 * Analyse the membership query the loader ACTUALLY RETURNS.
 *
 * The binding is: return statement -> the identifier it names -> the
 * destructuring declaration that produced it -> the awaited call chain on its
 * initializer. Any other query in the function, however similar, is not that
 * chain and cannot satisfy anything here.
 */
/** Anything that opens a new function scope. Never descended into. */
function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}

/**
 * The loader's OWN return — never one belonging to a nested helper.
 *
 * The walk refuses to enter any nested function scope, so `return data` inside
 * an inner arrow or helper can never be mistaken for the loader's result.
 */
function ownReturn(fn: ts.FunctionDeclaration): ts.ReturnStatement | null {
  let last: ts.ReturnStatement | null = null;
  const visit = (n: ts.Node) => {
    if (isFunctionLike(n)) return; // a different scope's return is not ours
    if (ts.isReturnStatement(n) && n.expression) last = n;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body!, visit);
  return last;
}

/** The statement list a scope node contributes to lexical lookup, if any. */
function scopeStatements(n: ts.Node): readonly ts.Statement[] | null {
  if (ts.isBlock(n)) return n.statements;
  if (ts.isCaseClause(n) || ts.isDefaultClause(n)) return n.statements;
  return null;
}

/**
 * Resolve `name` to the declaration LEXICALLY VISIBLE at `ret`.
 *
 * This is the fix for the fourth review finding. Searching the function for any
 * declaration spelled `data` and keeping the last one is scope-insensitive: a
 * nested helper, an inner block, a sibling scope or a declaration placed after
 * the return could all supply a fully-filtered query while the value the loader
 * actually returns came from an unscoped one — and the pin would inspect the
 * wrong chain.
 *
 * So the lookup follows binding rules instead of spelling. It starts at the
 * return statement, walks OUTWARD through its enclosing scopes only, considers
 * only declarations positioned BEFORE the return (a `const` below it is in the
 * temporal dead zone and cannot be what the return read), takes the nearest
 * enclosing scope's match, and stops at the loader itself so nothing outside it
 * can satisfy the proof. Nested scopes are never entered.
 */
function resolveAtReturn(
  fn: ts.FunctionDeclaration,
  ret: ts.ReturnStatement,
  name: string,
): ts.Expression | null {
  let scope: ts.Node | undefined = ret.parent;
  while (scope) {
    const statements = scopeStatements(scope);
    if (statements) {
      let candidate: ts.Expression | null = null;
      for (const st of statements) {
        // Declared at or after the return: not visible to it.
        if (st.getStart() >= ret.getStart()) break;
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
          if (!d.initializer) continue;
          const binds =
            (ts.isObjectBindingPattern(d.name) &&
              d.name.elements.some(
                (el) => ts.isIdentifier(el.name) && el.name.text === name,
              )) ||
            (ts.isIdentifier(d.name) && d.name.text === name);
          if (binds) candidate = d.initializer; // last one before the return
        }
      }
      if (candidate) return candidate; // nearest enclosing scope wins
    }
    if (scope === fn) break; // never resolve outside the loader
    scope = scope.parent;
  }
  return null;
}

/**
 * Analyse the membership query the loader ACTUALLY RETURNS.
 *
 * return statement -> the identifier it names -> that identifier's LEXICALLY
 * VISIBLE declaration -> the awaited call chain on its initializer. Any other
 * query in the file, however similar and however spelled, is not that chain.
 */
function membershipQuery(source: string): MembershipQuery {
  const sf = parse(source);
  const fn = findFunction(sf, "loadActiveMembershipRows");
  if (!fn?.body) return NOT_BOUND;

  // The loader's own `userId` parameter, so a decoy identifier cannot pass.
  const userIdParam = fn.parameters.find(
    (p) => ts.isIdentifier(p.name) && p.name.text === "userId",
  );
  const userIdName =
    userIdParam && ts.isIdentifier(userIdParam.name)
      ? userIdParam.name.text
      : null;

  const ret = ownReturn(fn);
  if (!ret?.expression) return NOT_BOUND;
  const returnedExpr = unwrap(ret.expression);
  if (!ts.isIdentifier(returnedExpr)) return NOT_BOUND;

  const initializer = resolveAtReturn(fn, ret, returnedExpr.text);
  if (!initializer) return NOT_BOUND;

  const { base, calls } = chainOf(initializer);
  if (base === null || calls.length === 0) return NOT_BOUND;

  const selectCall = calls.find((c) => c.method === "select");
  const selectArg =
    selectCall && selectCall.args.length > 0 && ts.isStringLiteral(selectCall.args[0])
      ? selectCall.args[0].text
      : null;

  const from = calls.find((c) => c.method === "from");
  const fromPractitioners =
    !!from &&
    from.args.length > 0 &&
    ts.isStringLiteral(from.args[0]) &&
    from.args[0].text === "practitioners";

  const eqCalls = calls.filter((c) => c.method === "eq" && c.args.length >= 2);
  const userScoped =
    userIdName !== null &&
    eqCalls.some(
      (c) =>
        ts.isStringLiteral(c.args[0]) &&
        c.args[0].text === "user_id" &&
        ts.isIdentifier(c.args[1]) &&
        c.args[1].text === userIdName,
    );
  const activeScoped = eqCalls.some(
    (c) =>
      ts.isStringLiteral(c.args[0]) &&
      c.args[0].text === "active" &&
      c.args[1].kind === ts.SyntaxKind.TrueKeyword,
  );

  return {
    bound: true,
    selectArg,
    fromPractitioners,
    userScoped,
    activeScoped,
    multiRowSafe: !calls.some((c) => c.method === "maybeSingle"),
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

describe("the RETURNED membership query is the thing that carries the filters", () => {
  it("the real loader is bound, on practitioners, and doubly scoped", () => {
    const q = membershipQuery(QUERIES_RAW);
    expect(q.bound, "loadActiveMembershipRows no longer returns a bound query").toBe(true);
    expect(q.fromPractitioners, 'the returned chain is not from("practitioners")').toBe(true);
    expect(q.userScoped, 'the returned chain lost .eq("user_id", userId)').toBe(true);
    expect(q.activeScoped, 'the returned chain lost .eq("active", true)').toBe(true);
    expect(q.multiRowSafe, "the returned chain uses maybeSingle").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Negative controls
// ---------------------------------------------------------------------------
// Every fixture below is a loader that a text-based proof would pass: the exact
// missing predicate is present SOMEWHERE in the function, as a comment, a
// string, a decoy query, or a query against another table. None of them is a
// link in the chain the loader returns, so none of them may count.

const TAIL = `
  if (error) {
    throw new Error("Failed to load practitioner: " + error.message);
  }
  return data ?? [];
}
`;
const OPEN = `async function loadActiveMembershipRows(supabase: S, userId: string) {`;

function fixture(body: string): string {
  return `${OPEN}\n${body}\n${TAIL}`;
}

/** Each control names the vocabulary it plants and the link it removes. */
const CONTROLS: Array<{
  id: string;
  label: string;
  source: string;
  expect: Partial<MembershipQuery>;
}> = [
  {
    id: "COMMENT_DECOY",
    label: "A. a COMMENT carries the missing user_id predicate",
    source: fixture(`
      // .eq("user_id", userId)
      const { data, error } = await supabase
        .from("practitioners").select("OUTER").eq("active", true);`),
    expect: { bound: true, fromPractitioners: true, userScoped: false, activeScoped: true },
  },
  {
    id: "STRING_DECOY",
    label: "B. a STRING LITERAL carries the missing active predicate",
    source: fixture(`
      const note = '.eq("active", true)';
      const { data, error } = await supabase
        .from("practitioners").select("OUTER").eq("user_id", userId);`),
    expect: { bound: true, fromPractitioners: true, userScoped: true, activeScoped: false },
  },
  {
    id: "SECOND_QUERY_USER",
    label: "C. a SECOND query in the same loader carries user_id",
    source: fixture(`
      const audit = await supabase
        .from("practitioners").select("SHADOW").eq("user_id", userId);
      const { data, error } = await supabase
        .from("practitioners").select("OUTER").eq("active", true);`),
    expect: { bound: true, fromPractitioners: true, userScoped: false, activeScoped: true },
  },
  {
    id: "SECOND_QUERY_ACTIVE",
    label: "D. a SECOND query in the same loader carries active",
    source: fixture(`
      const audit = await supabase
        .from("practitioners").select("SHADOW").eq("active", true);
      const { data, error } = await supabase
        .from("practitioners").select("OUTER").eq("user_id", userId);`),
    expect: { bound: true, fromPractitioners: true, userScoped: true, activeScoped: false },
  },
  {
    id: "PRACTITIONERS_DECOY",
    label: "E. a DIFFERENT practitioners chain has BOTH; the returned one has neither",
    source: fixture(`
      const audit = await supabase
        .from("practitioners").select("SHADOW").eq("user_id", userId).eq("active", true);
      const { data, error } = await supabase
        .from("practitioners").select("OUTER");`),
    expect: { bound: true, fromPractitioners: true, userScoped: false, activeScoped: false },
  },
  {
    id: "WRONG_TABLE",
    label: "F. the returned chain is doubly scoped but reads ANOTHER table",
    source: fixture(`
      const { data, error } = await supabase
        .from("sessions").select("OUTER").eq("user_id", userId).eq("active", true);`),
    expect: { bound: true, fromPractitioners: false, userScoped: true, activeScoped: true },
  },
];

describe("negative controls — vocabulary in the function never counts", () => {
  for (const control of CONTROLS) {
    it(`${control.label} -> RED`, () => {
      // The fixture WOULD pass a text-based proof: the token is right there.
      const planted = control.expect.fromPractitioners === false
        ? /\.eq\("user_id", userId\)/
        : control.expect.userScoped === false
          ? /\.eq\("user_id", userId\)/
          : /\.eq\("active", true\)/;
      expect(control.source, "the fixture must contain the token textually").toMatch(planted);

      const q = membershipQuery(control.source);
      for (const [key, want] of Object.entries(control.expect)) {
        expect(q[key as keyof MembershipQuery], `${control.id}: ${key}`).toBe(want);
      }
      // Whatever the individual flags, the control must NOT be a fully valid
      // membership query — that is the single claim each one exists to make.
      const fullyValid =
        q.bound && q.fromPractitioners && q.userScoped && q.activeScoped;
      expect(fullyValid, `${control.id} was accepted as a valid loader`).toBe(false);
    });
  }

  it("a renamed-away loader is RED, not silently absent", () => {
    const q = membershipQuery(`
      async function somethingElse(supabase: S, userId: string) {
        const { data } = await supabase
          .from("practitioners").select("*").eq("user_id", userId).eq("active", true);
        return data ?? [];
      }
    `);
    expect(q.bound).toBe(false);
    expect(q.userScoped).toBe(false);
    expect(q.activeScoped).toBe(false);
  });

  it("the controls discriminate: the REAL loader passes every flag", () => {
    const q = membershipQuery(QUERIES_RAW);
    expect([
      q.bound,
      q.fromPractitioners,
      q.userScoped,
      q.activeScoped,
      q.multiRowSafe,
    ]).toEqual([true, true, true, true, true]);
  });
});

// ---------------------------------------------------------------------------
// Lexical-scope negative controls
// ---------------------------------------------------------------------------
// The fourth review finding: resolving `data` by SPELLING lets a shadow supply
// the answer. Every fixture below has an OUTER query — the one the loader
// actually returns — that is missing a filter, and a SHADOW query that has
// everything, placed somewhere a name-based search would have found it: a
// nested function, an inner block, after the return, a sibling scope, an arrow
// body, an `if` block, a `try` block.
//
// Each control asserts three things, in this order, so none of them can pass
// for an uninteresting reason:
//   1. the fixture parses and the loader is FOUND,
//   2. resolution SUCCEEDED (`bound`) — a control must never pass merely
//      because the resolver gave up,
//   3. the declaration selected is the OUTER one (`selectArg === "OUTER"`),
//      which is the actual claim: the resolver picked the binding visible at
//      the return, not the shadow.

const OUTER_MISSING_ACTIVE = `        const { data, error } = await supabase
          .from("practitioners").select("OUTER").eq("user_id", userId);`;
const OUTER_MISSING_USER = `        const { data, error } = await supabase
          .from("practitioners").select("OUTER").eq("active", true);`;
const TAIL_RETURN = `        if (error) { throw new Error("x"); }
        return data ?? [];`;

/**
 * Every fixture places the SHADOW *after* the outer declaration on purpose.
 *
 * That ordering is what makes these controls discriminate rather than decorate.
 * The resolver this repair replaced kept the LAST declaration spelled `data`
 * that it met while descending, so a shadow placed BEFORE the real one would
 * have been overwritten by it and the control would have passed against the
 * very defect it exists to catch — vacuity one level up. Positioned after, the
 * old resolver picks SHADOW and the control goes red; the lexical resolver
 * still picks OUTER because none of these scopes is visible at the return.
 */
const LEXICAL: Array<{
  id: string;
  label: string;
  source: string;
  missing: "userScoped" | "activeScoped";
  token: RegExp;
  /** Whether the superseded name-based resolver would have picked the shadow. */
  catchesOldResolver: boolean;
}> = [
  {
    id: "NESTED_FUNCTION_CONTROL",
    label: "A. a nested FUNCTION declares a fully-scoped `data`",
    source: `
      async function loadActiveMembershipRows(supabase: S, userId: string) {
${OUTER_MISSING_ACTIVE}
        async function helper() {
          const { data } = await supabase
            .from("practitioners").select("SHADOW")
            .eq("user_id", userId).eq("active", true);
          return data;
        }
${TAIL_RETURN}
      }`,
    missing: "activeScoped",
    token: /\.eq\("active", true\)/,
    catchesOldResolver: true,
  },
  {
    id: "NESTED_BLOCK_CONTROL",
    label: "B. an inner BLOCK shadows `data` between the declaration and the return",
    source: `
      async function loadActiveMembershipRows(supabase: S, userId: string) {
${OUTER_MISSING_ACTIVE}
        {
          const { data } = await supabase
            .from("practitioners").select("SHADOW")
            .eq("user_id", userId).eq("active", true);
        }
${TAIL_RETURN}
      }`,
    missing: "activeScoped",
    token: /\.eq\("active", true\)/,
    catchesOldResolver: true,
  },
  {
    id: "AFTER_RETURN_CONTROL",
    label: "C. a fully-scoped `data` is declared AFTER the return, same block",
    source: `
      async function loadActiveMembershipRows(supabase: S, userId: string) {
${OUTER_MISSING_ACTIVE}
${TAIL_RETURN}
        const { data } = await supabase
          .from("practitioners").select("SHADOW")
          .eq("user_id", userId).eq("active", true);
      }`,
    missing: "activeScoped",
    token: /\.eq\("active", true\)/,
    catchesOldResolver: true,
  },
  {
    id: "SIBLING_SCOPE_CONTROL",
    label: "D. a SIBLING function holds the fully-scoped `data`",
    source: `
      async function loadActiveMembershipRows(supabase: S, userId: string) {
${OUTER_MISSING_ACTIVE}
${TAIL_RETURN}
      }
      async function somethingElse(supabase: S, userId: string) {
        const { data } = await supabase
          .from("practitioners").select("SHADOW")
          .eq("user_id", userId).eq("active", true);
        return data ?? [];
      }`,
    missing: "activeScoped",
    token: /\.eq\("active", true\)/,
    // The superseded resolver only descended the loader's own body, so it never
    // saw a sibling either. This control guards the rule, not that one bug.
    catchesOldResolver: false,
  },
  {
    id: "ARROW_SCOPE_CONTROL",
    label: "E. an inner ARROW function holds the fully-scoped `data`",
    source: `
      async function loadActiveMembershipRows(supabase: S, userId: string) {
${OUTER_MISSING_ACTIVE}
        const reload = async () => {
          const { data } = await supabase
            .from("practitioners").select("SHADOW")
            .eq("user_id", userId).eq("active", true);
          return data;
        };
${TAIL_RETURN}
      }`,
    missing: "activeScoped",
    token: /\.eq\("active", true\)/,
    catchesOldResolver: true,
  },
  {
    id: "ACTIVE_SHADOW_CONTROL",
    label: "F. outer has user_id but not active; an `if` block shadow has both",
    source: `
      async function loadActiveMembershipRows(supabase: S, userId: string) {
${OUTER_MISSING_ACTIVE}
        if (userId) {
          const { data } = await supabase
            .from("practitioners").select("SHADOW")
            .eq("user_id", userId).eq("active", true);
        }
${TAIL_RETURN}
      }`,
    missing: "activeScoped",
    token: /\.eq\("active", true\)/,
    catchesOldResolver: true,
  },
  {
    id: "USER_SHADOW_CONTROL",
    label: "G. outer has active but not user_id; a `try` block shadow has both",
    source: `
      async function loadActiveMembershipRows(supabase: S, userId: string) {
${OUTER_MISSING_USER}
        try {
          const { data } = await supabase
            .from("practitioners").select("SHADOW")
            .eq("user_id", userId).eq("active", true);
        } catch {}
${TAIL_RETURN}
      }`,
    missing: "userScoped",
    token: /\.eq\("user_id", userId\)/,
    catchesOldResolver: true,
  },
];

/**
 * The resolver this repair REPLACED, kept here as the thing the controls are
 * measured against: find any declaration spelled like the returned identifier
 * anywhere beneath the loader, last one wins, nested scopes included.
 */
function supersededResolve(source: string): string | null {
  const sf = parse(source);
  const fn = findFunction(sf, "loadActiveMembershipRows");
  if (!fn?.body) return null;
  let returned: string | null = null;
  const findReturn = (n: ts.Node) => {
    if (ts.isReturnStatement(n) && n.expression) {
      const e = unwrap(n.expression);
      if (ts.isIdentifier(e)) returned = e.text;
    }
    ts.forEachChild(n, findReturn);
  };
  findReturn(fn.body);
  let initializer: ts.Expression | null = null;
  const findDecl = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (
        ts.isObjectBindingPattern(n.name) &&
        n.name.elements.some(
          (el) => ts.isIdentifier(el.name) && el.name.text === returned,
        )
      ) {
        initializer = n.initializer;
      }
    }
    ts.forEachChild(n, findDecl);
  };
  findDecl(fn.body);
  if (!initializer) return null;
  const { calls } = chainOf(initializer);
  const sel = calls.find((c) => c.method === "select");
  return sel && sel.args.length > 0 && ts.isStringLiteral(sel.args[0])
    ? sel.args[0].text
    : null;
}

describe("negative controls — a shadow never answers for the returned query", () => {
  for (const control of LEXICAL) {
    it(`${control.label} -> RED`, () => {
      // The fixture WOULD satisfy a spelling-based search: the token is present.
      expect(control.source, "fixture must contain the token textually").toMatch(
        control.token,
      );
      expect(control.source, "fixture must contain the shadow query").toMatch(
        /select\("SHADOW"\)/,
      );

      const q = membershipQuery(control.source);

      // 1. Parsing and lookup succeeded — this control is not passing because
      //    the resolver failed to find anything.
      expect(q.bound, `${control.id}: resolution did not succeed`).toBe(true);
      // 2. The declaration chosen is the one VISIBLE AT THE RETURN, not the
      //    shadow. This is the finding's actual subject.
      expect(q.selectArg, `${control.id}: resolved the SHADOW declaration`).toBe(
        "OUTER",
      );
      // 3. And so the missing filter is reported missing.
      expect(q[control.missing], `${control.id}: ${control.missing}`).toBe(false);

      const fullyValid =
        q.bound && q.fromPractitioners && q.userScoped && q.activeScoped;
      expect(fullyValid, `${control.id} was accepted as a valid loader`).toBe(false);

      // 4. ANTI-VACUITY. A control the superseded resolver ALSO passes is
      //    decoration, not a guard. Where the fixture is built to defeat it,
      //    prove that it does: the old resolver must reach for the SHADOW.
      if (control.catchesOldResolver) {
        expect(
          supersededResolve(control.source),
          `${control.id} does not discriminate: the superseded resolver picks it too`,
        ).toBe("SHADOW");
      }
    });
  }

  it("a return belonging to a nested helper is never mistaken for the loader's", () => {
    // The loader itself returns nothing resolvable; only the helper returns.
    // That must be NOT BOUND, never the helper's fully-scoped query.
    const q = membershipQuery(`
      async function loadActiveMembershipRows(supabase: S, userId: string) {
        async function helper() {
          const { data } = await supabase
            .from("practitioners").select("SHADOW")
            .eq("user_id", userId).eq("active", true);
          return data ?? [];
        }
        await helper();
      }`);
    expect(q.bound).toBe(false);
    expect(q.selectArg).toBeNull();
  });

  it("the real loader still resolves to its own query, on all flags", () => {
    const q = membershipQuery(QUERIES_RAW);
    expect(q.bound).toBe(true);
    expect(q.selectArg, "resolved a query other than the loader's own").toBe(
      "*, studio:studios(*)",
    );
    expect([
      q.fromPractitioners,
      q.userScoped,
      q.activeScoped,
      q.multiRowSafe,
    ]).toEqual([true, true, true, true]);
  });
});
