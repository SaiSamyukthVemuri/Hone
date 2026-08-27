import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PERF-01A — one identity resolution per authenticated request.
//
// WHAT THIS PROVES, and why it needs a simulated request scope.
//
// A single authenticated navigation used to resolve identity three times:
// the shell's requirePractitionerWithStudio(), the shell's
// listActiveStudioMemberships(), and the page's
// getCurrentPractitionerWithStudio(). Each did `auth.getUser()` (a real GoTrue
// round trip, not a cookie read) followed by a membership select that cannot
// start until it returns — six serial round trips before the page's own reads.
//
// React's `cache()` collapses that to one. But `cache()` only dedupes INSIDE a
// server request scope; under vitest it deliberately calls through (documented
// and depended upon by lib/observability/perf-timing.ts, and by the behavioural
// suite next door, which drives these wrappers with per-test fixtures).
//
// So counting the real thing requires standing the scope up. The `react` mock
// below replaces `cache()` with the one behaviour it has in a request — memoise
// for this scope — which makes the claim measurable and deterministic. Each
// test resets the module registry, so every test is a NEW request.
const realCache = <T extends (...a: never[]) => unknown>(fn: T): T => {
  let memo: unknown;
  let has = false;
  return ((...a: never[]) => {
    if (!has) {
      has = true;
      memo = fn(...a);
    }
    return memo;
  }) as T;
};

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: realCache };
});

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

let mockUser: { id: string } | null = { id: "user-1" };
let mockRows: Array<Record<string, unknown>> = [];
let mockSelectedStudioId: string | null = null;

// The two PHYSICAL calls this ticket is about.
let getUserCalls = 0;
let membershipSelects = 0;
// Every createClient() is counted too: cheap (no network), but a jump here
// would mean the wrappers started rebuilding clients they no longer need.
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
              return { data: mockRows, error: null };
            },
          }),
        }),
      }),
    };
  },
}));

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

/** A fresh module registry = a fresh request scope = a fresh memo. */
async function newRequest() {
  vi.resetModules();
  getUserCalls = 0;
  membershipSelects = 0;
  clientBuilds = 0;
  cookieReads = 0;
  return import("@/lib/supabase/queries");
}

beforeEach(() => {
  redirectMock.mockClear();
  mockUser = { id: "user-1" };
  mockRows = [];
  mockSelectedStudioId = null;
});

describe("one authenticated navigation resolves identity ONCE", () => {
  it("shell identity + shell memberships + page identity cost 1 getUser and 1 select", async () => {
    mockRows = [row("owner", "studio-a")];
    const q = await newRequest();

    // Exactly what an authenticated navigation does, in order.
    const shell = await q.requirePractitionerWithStudio(); // app/(app)/layout.tsx
    const memberships = await q.listActiveStudioMemberships(); // app/(app)/layout.tsx
    const page = await q.getCurrentPractitionerWithStudio(); // the route's page

    expect(getUserCalls, "auth.getUser() per authenticated request").toBe(1);
    expect(membershipSelects, "active-membership selects per request").toBe(1);

    // ...and every caller still got the right answer.
    expect(shell.studio.id).toBe("studio-a");
    expect(page.studio.id).toBe("studio-a");
    expect(memberships).toHaveLength(1);
  });

  it("a second, independent request resolves again — nothing survives the response", async () => {
    mockRows = [row("owner", "studio-a")];
    const first = await newRequest();
    await first.requirePractitionerWithStudio();
    expect(getUserCalls).toBe(1);

    // A DIFFERENT user on the next request must never see the first one's rows.
    mockUser = { id: "user-2" };
    mockRows = [row("practitioner", "studio-b")];
    const second = await newRequest();
    const result = await second.getCurrentPractitionerWithStudio();

    expect(getUserCalls, "the new request re-validated the session").toBe(1);
    expect(membershipSelects).toBe(1);
    expect(result.studio.id, "no identity crossed the request boundary").toBe(
      "studio-b",
    );
  });

  it("repeated resolution inside one request stays flat, not linear", async () => {
    mockRows = [row("owner", "studio-a")];
    const q = await newRequest();
    for (let i = 0; i < 8; i++) await q.getCurrentPractitionerWithStudio();
    expect(getUserCalls).toBe(1);
    expect(membershipSelects).toBe(1);
    expect(clientBuilds, "no client is rebuilt per resolution").toBe(1);
  });
});

describe("the selection is re-read and re-validated, never memoised with the rows", () => {
  it("a stale cookie is still refused inside a memoised request", async () => {
    mockRows = [row("owner", "studio-a"), row("practitioner", "studio-b")];
    mockSelectedStudioId = "studio-ZZZ"; // matches no active membership
    const q = await newRequest();

    await expect(q.getCurrentPractitionerWithStudio()).rejects.toThrow(
      /Multiple active studio memberships/,
    );
    await expect(q.requirePractitionerWithStudio()).rejects.toThrow(
      "REDIRECT:/no-access?reason=multiple-studios",
    );
    expect(getUserCalls, "still one identity read").toBe(1);
  });

  it("a selection made mid-request is honoured by the next wrapper call", async () => {
    mockRows = [row("owner", "studio-a"), row("practitioner", "studio-b")];
    mockSelectedStudioId = null;
    const q = await newRequest();

    await expect(q.getCurrentPractitionerWithStudio()).rejects.toThrow(
      /Multiple active studio memberships/,
    );

    // e.g. a server action just set the cookie. The rows are memoised; the
    // SELECTION is not, so this resolves without another identity round trip.
    mockSelectedStudioId = "studio-b";
    const after = await q.getCurrentPractitionerWithStudio();

    expect(after.studio.id).toBe("studio-b");
    expect(getUserCalls).toBe(1);
    expect(cookieReads, "the cookie is read per call, not once").toBeGreaterThan(1);
  });
});

describe("every gate still fires on the shared read", () => {
  it("anonymous -> /login, and no memberships are listed", async () => {
    mockUser = null;
    const q = await newRequest();
    await expect(q.requirePractitionerWithStudio()).rejects.toThrow(
      "REDIRECT:/login",
    );
    await expect(q.getCurrentPractitionerWithStudio()).rejects.toThrow(
      "REDIRECT:/login",
    );
    expect(await q.listActiveStudioMemberships()).toEqual([]);
    expect(membershipSelects, "an anonymous request never queries memberships").toBe(0);
  });

  it("authenticated with no membership -> /no-access (invite-only gate)", async () => {
    mockRows = [];
    const q = await newRequest();
    await expect(q.requirePractitionerWithStudio()).rejects.toThrow(
      "REDIRECT:/no-access",
    );
    await expect(q.getCurrentPractitionerWithStudio()).rejects.toThrow(
      /No active practitioner found/,
    );
  });

  it("a failed membership read still surfaces, never becomes 'no memberships'", async () => {
    const q = await newRequest();
    // Re-point the select at a failure for this request only.
    mockRows = [];
    const failing = await import("@/lib/supabase/server");
    vi.spyOn(failing, "createClient").mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: mockUser } }) },
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: async () => ({ data: null, error: { message: "boom" } }),
          }),
        }),
      }),
    } as never);
    await expect(q.listActiveStudioMemberships()).rejects.toThrow(
      /Failed to load practitioner: boom/,
    );
  });
});

describe("source pins — the wrappers consume the shared authority", () => {
  const RAW = readFileSync(
    path.resolve(__dirname, "../../../lib/supabase/queries.ts"),
    "utf8",
  );
  // Pin the CODE, not the prose. The module's header explains what
  // `auth.getUser()` costs and which caches are forbidden, so a naive
  // whole-file regex matches the explanation and reports the opposite of the
  // truth.
  const QUERIES = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(
    /^\s*\/\/.*$/gm,
    "",
  );
  const authorityBody = (() => {
    const i = QUERIES.indexOf("const loadRequestIdentity = cache(");
    expect(i, "the request-scoped authority is missing").toBeGreaterThan(-1);
    return QUERIES.slice(i, i + 600);
  })();

  it("identity is memoised with React cache(), not a forbidden cache", () => {
    expect(QUERIES).toMatch(/import \{ cache \} from "react"/);
    expect(QUERIES).toMatch(/const loadRequestIdentity = cache\(/);
    // None of the caches this ticket forbids: no time-based revalidation, no
    // Next data cache, no module-global store that would outlive the response.
    expect(QUERIES).not.toMatch(/unstable_cache/);
    expect(QUERIES).not.toMatch(/revalidate\s*:/);
    expect(QUERIES).not.toMatch(/globalThis\./);
  });

  it("no wrapper calls auth.getUser() on its own any more", () => {
    const calls = QUERIES.match(/auth\s*\.\s*getUser\s*\(/g) ?? [];
    expect(calls, "exactly one getUser call site remains").toHaveLength(1);
    expect(authorityBody, "and it lives inside the request-scoped authority").toMatch(
      /auth\s*\.\s*getUser\s*\(/,
    );
  });

  it("the redirects stay OUT of the memoised function", () => {
    // A redirect is a thrown control-flow signal; memoising one would cache a
    // navigation rather than an identity.
    expect(authorityBody).not.toMatch(/redirect\(/);
  });

  it("the membership read is still user-scoped and active-scoped (RLS unchanged)", () => {
    expect(QUERIES).toMatch(/\.eq\("user_id", userId\)/);
    expect(QUERIES).toMatch(/\.eq\("active", true\)/);
    // Scoped to the membership loader: `maybeSingle` is legitimate elsewhere in
    // this module, and errors on 2+ rows only for the multi-studio read.
    const li = QUERIES.indexOf("async function loadActiveMembershipRows");
    expect(QUERIES.slice(li, li + 400)).not.toMatch(/maybeSingle/);
  });
});
