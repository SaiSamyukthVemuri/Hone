import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// LEAD-ALERT-01 (Codex P2 4263663458): an operator who opens a lead link while
// signed out, and ALSO has a pending studio invitation, still ends on the lead.
// The remembered target is CARRIED through the required step (accepting the
// invitation, or choosing a studio) and used only when that step completes.
// It is forgotten on a legitimate refusal, never used for a non-operator, and
// never skips the invitation or the studio choice.

const OPERATOR = "ops@hone.example";
const PERSON = "practitioner@studio.example";
const LEAD = "/admin/leads/demo-request/8f0c2b7e-5d1a-4a2b-9c3d-4e5f6a7b8c9d";

const h = vi.hoisted(() => ({
  email: "ops@hone.example" as string,
  reconcile: { status: "none" } as Record<string, unknown>,
  accept: { status: "linked" } as Record<string, unknown>,
  member: true,
  signedIn: true,
  frontDeskRows: [] as Array<{ id: string; studio_id: string; display_name: string }>,
  frontDeskError: false,
  membershipFilters: [] as Array<[string, unknown]>,
  memberships: [] as Array<{ studio_id: string }>,
  jar: new Map<string, string>(),
  selectionCleared: 0,
  selectionFails: false,
  selected: null as string | null,
  signedOut: 0,
}));

class Redirect extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    has: (name: string) => h.jar.has(name),
    delete: (name: string) => {
      h.jar.delete(name);
    },
    set: (name: string, value: string) => {
      h.jar.set(name, value);
    },
  }),
}));
vi.mock("@/lib/supabase/selected-studio", () => ({
  clearSelectedStudioId: async () => {
    h.selectionCleared += 1;
  },
  setSelectedStudioId: async (id: string) => {
    if (h.selectionFails) throw new Error("selection_write_failed");
    h.selected = id;
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async () => ({ data: { user: { id: "u1", email: h.email } }, error: null }),
      getUser: async () => ({ data: { user: h.signedIn ? { id: "u1", email: h.email } : null } }),
      signOut: async () => {
        h.signedOut += 1;
      },
    },
    rpc: async () => ({ data: h.reconcile }),
    from: (table: string) => ({
      select: () => {
        const result = Object.assign(Promise.resolve({
          data: table === "studio_receptionists" ? h.frontDeskRows : [],
          error: table === "studio_receptionists" && h.frontDeskError ? { code: "test" } : null,
        }), {
          eq: (key: string, value: unknown): unknown => { h.membershipFilters.push([key, value]); return result; },
          maybeSingle: async () => ({ data: h.member ? { id: "p1" } : null }),
        });
        return result;
      },
    }),
  }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ rpc: async () => ({ data: h.accept, error: null }) }),
}));
const { query } = vi.hoisted(() => ({
  query: (data: unknown) => Object.assign(Promise.resolve({ data, error: null }), { limit: async () => ({ data, error: null }) }),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: h.email } } }) },
    // Awaitable AND .limit()-able, per table, so the mock holds whichever
    // membership reads the middleware makes (practitioners; studio_receptionists
    // where that lane is composed): no receptionist rows here.
    from: (table: string) => ({ select: () => ({ eq: () => ({ eq: () => query(table === "practitioners" ? h.memberships : []) }) }) }),
  }),
}));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: vi.fn(), identifyServerUser: vi.fn() }));

import { GET as callback } from "@/app/(auth)/auth/callback/route";
import { acceptInvitationAction } from "@/app/(auth)/accept-invitation/actions";
import { signOutFromGate, switchStudioAction } from "@/app/(auth)/no-access/actions";
import { updateSession } from "@/lib/supabase/middleware";
import { selectFrontDeskStudioAction } from "@/app/front-desk/select/actions";
import { ADMIN_RETURN_COOKIE, ADMIN_RETURN_MAX_AGE_SECONDS } from "@/lib/auth/return-path";

const ORIGIN = "https://hone.example";

beforeEach(() => {
  process.env.ADMIN_EMAILS = OPERATOR;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  h.email = OPERATOR;
  h.reconcile = { status: "none" };
  h.accept = { status: "linked" };
  h.member = true;
  h.signedIn = true;
  h.frontDeskRows = [{ id: "r1", studio_id: "s1", display_name: "Desk" }, { id: "r2", studio_id: "s2", display_name: "Desk" }];
  h.frontDeskError = false;
  h.membershipFilters = [];
  h.memberships = [];
  h.jar.clear();
  h.selectionCleared = 0;
  h.selectionFails = false;
  h.selected = null;
  h.signedOut = 0;
});

/** The sign-in callback with the remembered target; the cookie it leaves (or clears) is mirrored into the jar. */
async function signIn(target: string = LEAD) {
  const req = new NextRequest(`${ORIGIN}/auth/callback?code=c`, {
    headers: { cookie: `${ADMIN_RETURN_COOKIE}=${encodeURIComponent(target)}` },
  });
  const res = await callback(req);
  const cleared = res.headers.getSetCookie().some((c) => c.startsWith(`${ADMIN_RETURN_COOKIE}=`));
  if (cleared) h.jar.delete(ADMIN_RETURN_COOKIE);
  else h.jar.set(ADMIN_RETURN_COOKIE, target);
  return { location: res.headers.get("location")!.replace(ORIGIN, ""), cleared };
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof Redirect) return e.to;
    throw e;
  }
  throw new Error("expected a redirect");
}

const accept = () => {
  const form = new FormData();
  form.set("consent", "on");
  return redirectOf(() => acceptInvitationAction(null, form));
};
const choose = (studioId = "s2") => {
  const form = new FormData();
  form.set("studio_id", studioId);
  return redirectOf(() => switchStudioAction(form));
};

describe("an operator with a pending invitation reaches the lead after the required step", () => {
  it("acceptance required: invitation first (target carried), then the lead (target consumed)", async () => {
    h.reconcile = { status: "acceptance_required" };
    const first = await signIn();
    expect(first).toEqual({ location: "/accept-invitation", cleared: false });

    h.accept = { status: "linked" };
    expect(await accept()).toBe(LEAD);
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);

    // And the lead page is reachable for this operator (no studio needed).
    const page = await updateSession(new NextRequest(`${ORIGIN}${LEAD}`));
    expect(page.headers.get("location")).toBeNull();
  });

  it("acceptance that makes a multi-studio user: invitation, then the chooser, then the lead", async () => {
    h.reconcile = { status: "acceptance_required" };
    await signIn();
    h.accept = { status: "linked", choose_studio: true };
    expect(await accept()).toBe("/dashboard");
    expect(h.selectionCleared).toBe(1);
    expect(h.jar.get(ADMIN_RETURN_COOKIE)).toBe(LEAD);

    expect(await choose("s2")).toBe(LEAD);
    expect(h.selected).toBe("s2");
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);
  });

  it("linked at sign-in as a newly multi-studio user: chooser first (target carried), then the lead", async () => {
    h.reconcile = { status: "linked", choose_studio: true };
    expect(await signIn()).toEqual({ location: "/dashboard", cleared: false });
    expect(await choose("s1")).toBe(LEAD);
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);
  });

  it("a refused studio choice keeps the target for the next try", async () => {
    h.reconcile = { status: "linked", choose_studio: true };
    await signIn();
    h.member = false;
    expect(await choose("not-mine")).toBe("/no-access?reason=multiple-studios");
    expect(h.jar.get(ADMIN_RETURN_COOKIE)).toBe(LEAD);
    expect(h.selected).toBeNull();
  });

  it("no required step: straight to the lead, consumed at once", async () => {
    expect(await signIn()).toEqual({ location: LEAD, cleared: true });
  });
});

describe("legitimate refusals forget the target", () => {
  it.each([
    ["conflict", "/no-access?reason=invite-conflict"],
    ["ambiguous", "/no-access?reason=invite-ambiguous"],
  ])("reconciliation %s at sign-in: the no-access answer, target cleared", async (status, to) => {
    h.reconcile = { status };
    expect(await signIn()).toEqual({ location: to, cleared: true });
  });

  it.each([
    ["conflict", "/no-access?reason=invite-conflict"],
    ["ambiguous", "/no-access?reason=invite-ambiguous"],
    ["no_invitation", "/no-access"],
  ])("acceptance answers %s: the existing no-access route, target cleared", async (status, to) => {
    h.reconcile = { status: "acceptance_required" };
    await signIn();
    h.accept = { status };
    expect(await accept()).toBe(to);
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);
  });

  it("signing out at the gate clears it", async () => {
    h.reconcile = { status: "acceptance_required" };
    await signIn();
    expect(await redirectOf(() => signOutFromGate())).toBe("/login");
    expect(h.signedOut).toBe(1);
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);
  });

  it("acceptance without the consent box still refuses, and keeps the target for the retry", async () => {
    h.reconcile = { status: "acceptance_required" };
    await signIn();
    expect(await acceptInvitationAction(null, new FormData())).toMatchObject({ error: expect.any(String) });
    expect(h.jar.get(ADMIN_RETURN_COOKIE)).toBe(LEAD);
  });
});

describe("a non-operator can never use the state", () => {
  beforeEach(() => {
    h.email = PERSON;
  });

  it("at sign-in: ignored and cleared, even with a pending invitation", async () => {
    expect(await signIn()).toEqual({ location: "/dashboard", cleared: true });
    h.reconcile = { status: "acceptance_required" };
    expect(await signIn()).toEqual({ location: "/accept-invitation", cleared: true });
  });

  it("at the end of acceptance or the chooser, with a planted cookie: the dashboard, cookie cleared", async () => {
    h.jar.set(ADMIN_RETURN_COOKIE, LEAD);
    expect(await accept()).toBe("/dashboard");
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);
    h.jar.set(ADMIN_RETURN_COOKIE, LEAD);
    expect(await choose("s1")).toBe("/dashboard");
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);
  });

  it("and the admin surface itself still refuses them (no studio: the invite-only gate)", async () => {
    const page = await updateSession(new NextRequest(`${ORIGIN}${LEAD}`));
    expect(new URL(page.headers.get("location")!).pathname).toBe("/no-access");
  });
});

describe("external or malformed targets are refused at every step", () => {
  const BAD = ["https://evil.example/admin", "//evil.example/admin", "/\\evil.example", "/settings", "/admin@evil.example", "/admin/\tx"];

  it.each(BAD)("at sign-in: %s is ignored and cleared", async (bad) => {
    expect(await signIn(bad)).toEqual({ location: "/dashboard", cleared: true });
  });

  it.each(BAD)("at the end of acceptance: %s is ignored and cleared", async (bad) => {
    h.jar.set(ADMIN_RETURN_COOKIE, bad);
    expect(await accept()).toBe("/dashboard");
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);
  });

  it.each(BAD)("at the end of the chooser: %s is ignored and cleared", async (bad) => {
    h.jar.set(ADMIN_RETURN_COOKIE, bad);
    expect(await choose("s1")).toBe("/dashboard");
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);
  });
});

describe("the invitation and no-access flows are unchanged without a target", () => {
  it("accept: linked -> dashboard; multi-studio -> chooser via dashboard with the selection cleared", async () => {
    expect(await accept()).toBe("/dashboard");
    h.accept = { status: "linked", choose_studio: true };
    expect(await accept()).toBe("/dashboard");
    expect(h.selectionCleared).toBe(1);
  });

  it("chooser: a member's choice -> dashboard; a non-member's -> back to the chooser", async () => {
    expect(await choose("s1")).toBe("/dashboard");
    h.member = false;
    expect(await choose("s9")).toBe("/no-access?reason=multiple-studios");
  });
});


describe("receptionist acceptance follows the approved front-desk boundary", () => {
  it.each(["linked", "already_linked"])("single-desk %s clears the target and enters the front desk", async (status) => {
    h.jar.set(ADMIN_RETURN_COOKIE, LEAD);
    h.accept = { status, role: "receptionist", choose_studio: false };
    expect(await accept()).toBe("/front-desk");
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);
  });

  it("multi-desk acceptance clears the target before the desk chooser", async () => {
    h.jar.set(ADMIN_RETURN_COOKIE, LEAD);
    h.accept = { status: "linked", role: "receptionist", choose_studio: true };
    expect(await accept()).toBe("/front-desk/select");
    expect(h.selectionCleared).toBe(1);
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);
  });

  it("single-desk non-operator with a planted target stays on the front desk", async () => {
    h.email = PERSON;
    h.jar.set(ADMIN_RETURN_COOKIE, LEAD);
    h.accept = { status: "linked", role: "receptionist", choose_studio: false };
    expect(await accept()).toBe("/front-desk");
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);
  });

  it.each(["//evil.example/admin", "/settings", "/admin@evil.example"])("single-desk unsafe target %s is discarded", async (bad) => {
    h.jar.set(ADMIN_RETURN_COOKIE, bad);
    h.accept = { status: "linked", role: "receptionist", choose_studio: false };
    expect(await accept()).toBe("/front-desk");
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);
  });
});


const chooseDesk = (studioId = "s2") => {
  const form = new FormData();
  form.set("studio_id", studioId);
  return redirectOf(() => selectFrontDeskStudioAction(form));
};

describe("verified front-desk choice fulfils the remembered operator target", () => {
  it("multi-desk acceptance clears the cookie and verified choice enters the front desk", async () => {
    h.jar.set(ADMIN_RETURN_COOKIE, LEAD);
    h.accept = { status: "linked", role: "receptionist", choose_studio: true };
    expect(await accept()).toBe("/front-desk/select");
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);
    expect(await chooseDesk()).toBe("/front-desk");
    expect(h.selected).toBe("s2");
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);
    expect(h.membershipFilters).toContainEqual(["user_id", "u1"]);
    expect(h.membershipFilters).toContainEqual(["active", true]);
    expect(ADMIN_RETURN_MAX_AGE_SECONDS).toBe(900);
  });

  it("selection persistence failure keeps the target for retry", async () => {
    h.jar.set(ADMIN_RETURN_COOKIE, LEAD);
    h.selectionFails = true;
    await expect(chooseDesk()).rejects.toThrow("selection_write_failed");
    expect(h.selected).toBeNull();
    expect(h.jar.get(ADMIN_RETURN_COOKIE)).toBe(LEAD);
  });

  it("non-member choice cannot set a studio or consume the target", async () => {
    h.jar.set(ADMIN_RETURN_COOKIE, LEAD);
    expect(await chooseDesk("foreign-studio")).toBe("/front-desk/select");
    expect(h.selected).toBeNull();
    expect(h.jar.get(ADMIN_RETURN_COOKIE)).toBe(LEAD);
  });

  it("membership read failure cannot set a studio or consume the target", async () => {
    h.frontDeskError = true;
    h.jar.set(ADMIN_RETURN_COOKIE, LEAD);
    await expect(chooseDesk()).rejects.toThrow("receptionist_membership_read_failed");
    expect(h.selected).toBeNull();
    expect(h.jar.get(ADMIN_RETURN_COOKIE)).toBe(LEAD);
  });

  it("signed-out choice cannot consume the target or select a studio", async () => {
    h.signedIn = false;
    h.jar.set(ADMIN_RETURN_COOKIE, LEAD);
    expect(await chooseDesk()).toBe("/front-desk/select");
    expect(h.selected).toBeNull();
    expect(h.jar.get(ADMIN_RETURN_COOKIE)).toBe(LEAD);
  });

  it("missing choice keeps the target and selection untouched", async () => {
    h.jar.set(ADMIN_RETURN_COOKIE, LEAD);
    expect(await redirectOf(() => selectFrontDeskStudioAction(new FormData()))).toBe("/front-desk/select");
    expect(h.selected).toBeNull();
    expect(h.jar.get(ADMIN_RETURN_COOKIE)).toBe(LEAD);
  });

  it("non-operator completes verified choice at the front desk, never admin", async () => {
    h.email = PERSON;
    h.jar.set(ADMIN_RETURN_COOKIE, LEAD);
    expect(await chooseDesk()).toBe("/front-desk");
    expect(h.selected).toBe("s2");
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);
  });

  it.each(["//evil.example/admin", "/settings", "/admin@evil.example"])("unsafe chooser target %s is discarded after valid membership", async bad => {
    h.jar.set(ADMIN_RETURN_COOKIE, bad);
    expect(await chooseDesk()).toBe("/front-desk");
    expect(h.selected).toBe("s2");
    expect(h.jar.has(ADMIN_RETURN_COOKIE)).toBe(false);
  });
});


describe("unverified acceptance does not fulfil an operator return", () => {
  it.each([{}, { status: "unknown", role: "receptionist" }])("unrecognised acceptance %j preserves the cookie", async result => {
    h.accept = result;
    h.jar.set(ADMIN_RETURN_COOKIE, LEAD);
    const form = new FormData(); form.set("consent", "on");
    expect(await acceptInvitationAction(null, form)).toMatchObject({ error: expect.any(String) });
    expect(h.jar.get(ADMIN_RETURN_COOKIE)).toBe(LEAD);
    expect(h.selected).toBeNull();
  });
});
