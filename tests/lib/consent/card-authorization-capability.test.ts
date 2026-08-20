import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// THE CAPABILITY READER — three outcomes, and BOTH failure classes contained
// ===========================================================================
//
// The Dashboard asks this before it says anything about any client's card. Two
// live defects motivated it, and each is pinned below:
//
//   * `createAdminClient()` THROWS synchronously when its env is absent. The
//     Dashboard reads capability inside a `Promise.all`, so an escaping throw
//     replaced the entire Today roster.
//   * A query error collapsed to "no templates", which a boolean caller read
//     as "this studio has no card route" — hiding the whole card UX from a
//     studio that has one.
//
// The mock FILTERS like PostgREST, so every predicate is load-bearing: drop
// one from the reader and a test here goes red rather than passing on rows
// that were never filtered.

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  error: null as unknown,
  throwOnAdmin: false,
  selected: [] as string[],
  limits: [] as number[],
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    if (h.throwOnAdmin) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
    return {
      from: () => {
        const eqs: Array<[string, unknown]> = [];
        const q: Record<string, unknown> = {};
        q.select = (sel: string) => {
          h.selected.push(sel);
          return q;
        };
        q.eq = (c: string, v: unknown) => {
          eqs.push([c, v]);
          return q;
        };
        q.limit = (n: number) => {
          h.limits.push(n);
          return q;
        };
        q.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
          if (h.error) return resolve({ data: null, error: h.error });
          return resolve({
            data: h.rows.filter((r) => eqs.every(([c, v]) => r[c] === v)),
            error: null,
          });
        };
        return q;
      },
    };
  },
}));

const { getCardAuthorizationCapability } = await import("@/lib/consent/queries");

const STUDIO = "studio-1";
const OTHER = "studio-2";
const LIVE_ACTIVE_CARD_AUTH = {
  id: "t1",
  studio_id: STUDIO,
  form_type: "card_authorization",
  is_live: true,
  status: "active",
};

beforeEach(() => {
  h.rows = [];
  h.error = null;
  h.throwOnAdmin = false;
  h.selected = [];
  h.limits = [];
});

describe("PRESENT — an active, live card_authorization route exists", () => {
  it("reports enabled", async () => {
    h.rows = [LIVE_ACTIVE_CARD_AUTH];
    expect(await getCardAuthorizationCapability(STUDIO)).toEqual({
      ok: true,
      enabled: true,
    });
  });
});

describe("ABSENT — the read SUCCEEDED and there is authoritatively no route", () => {
  it("no templates at all", async () => {
    expect(await getCardAuthorizationCapability(STUDIO)).toEqual({
      ok: true,
      enabled: false,
    });
  });

  it("only a DIFFERENT form_type", async () => {
    h.rows = [{ ...LIVE_ACTIVE_CARD_AUTH, form_type: "intake" }];
    expect(await getCardAuthorizationCapability(STUDIO)).toEqual({
      ok: true,
      enabled: false,
    });
  });

  it("another studio's template is not this studio's capability", async () => {
    h.rows = [{ ...LIVE_ACTIVE_CARD_AUTH, studio_id: OTHER }];
    expect(await getCardAuthorizationCapability(STUDIO)).toEqual({
      ok: true,
      enabled: false,
    });
  });

  it("active but NOT live — a draft must not unlock the Dashboard card UX", async () => {
    h.rows = [{ ...LIVE_ACTIVE_CARD_AUTH, is_live: false }];
    expect(await getCardAuthorizationCapability(STUDIO)).toEqual({
      ok: true,
      enabled: false,
    });
  });

  it("live but NOT active", async () => {
    h.rows = [{ ...LIVE_ACTIVE_CARD_AUTH, status: "archived" }];
    expect(await getCardAuthorizationCapability(STUDIO)).toEqual({
      ok: true,
      enabled: false,
    });
  });
});

describe("UNKNOWN — both failure classes are contained, neither becomes ABSENT", () => {
  it("a SYNCHRONOUS construction throw does not escape, and is not 'no route'", async () => {
    h.throwOnAdmin = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // The whole point: this must RESOLVE, not reject. A rejection here escapes
    // the Dashboard's Promise.all and replaces the Today roster.
    const result = await getCardAuthorizationCapability(STUDIO);
    expect(result).toEqual({ ok: false });
    expect(result).not.toEqual({ ok: true, enabled: false });
    err.mockRestore();
  });

  it("a QUERY ERROR is unknown, never an authoritative absence", async () => {
    h.error = { code: "57014", message: "canceling statement" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await getCardAuthorizationCapability(STUDIO);
    expect(result).toEqual({ ok: false });
    expect(result).not.toEqual({ ok: true, enabled: false });
    err.mockRestore();
  });

  it("neither failure log carries the thrown/driver text as a claim about the studio", async () => {
    h.throwOnAdmin = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await getCardAuthorizationCapability(STUDIO);
    const logged = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("card_authorization_capability_unavailable");
    err.mockRestore();
  });
});

describe("the read is an EXISTENCE question, cheaply asked", () => {
  it("projects only the id and bounds to one row — no template bodies", async () => {
    h.rows = [LIVE_ACTIVE_CARD_AUTH];
    await getCardAuthorizationCapability(STUDIO);
    expect(h.selected).toEqual(["id"]);
    expect(h.limits).toEqual([1]);
  });
});
