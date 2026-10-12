import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// STUDIO-READY-02b (#824), Codex P2 4244069747 on #850: an invitation that
// could not be completed is explained to a person who ALREADY works in a
// studio, instead of being redirected away before the reason is shown.

const state: {
  memberships: Array<{ studioId: string; studioName: string; role: string }>;
  desk: Array<{ studio_id: string }>;
  deskFails: boolean;
  deskReads: number;
} = { memberships: [], desk: [], deskFails: false, deskReads: 0 };

function deskQuery() {
  state.deskReads += 1;
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "limit"]) b[m] = () => b;
  b.then = (ok: (v: unknown) => unknown) =>
    Promise.resolve(state.deskFails ? { data: null, error: { code: "57014" } } : { data: state.desk, error: null }).then(ok);
  return b;
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`REDIRECT ${to}`), { to });
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } } }) },
    from: (table: string) => {
      if (table !== "studio_receptionists") throw new Error(`unexpected read of ${table}`);
      return deskQuery();
    },
  }),
}));
vi.mock("@/lib/supabase/queries", () => ({
  listActiveStudioMemberships: async () => state.memberships,
}));
vi.mock("@/app/(auth)/no-access/actions", () => ({ signOutFromGate: vi.fn(), switchStudioAction: vi.fn() }));

const { default: NoAccessPage } = await import("@/app/(auth)/no-access/page");

const render = async (reason?: string) => {
  try {
    const el = await NoAccessPage({ searchParams: Promise.resolve({ reason }) });
    return { html: renderToStaticMarkup(el), redirect: null as string | null };
  } catch (e) {
    const to = (e as { to?: string }).to;
    if (to) return { html: "", redirect: to };
    throw e;
  }
};

const one = [{ studioId: "s-1", studioName: "Studio One", role: "practitioner" }];
const two = [...one, { studioId: "s-2", studioName: "Studio Two", role: "owner" }];

beforeEach(() => {
  state.memberships = [];
  state.desk = [];
  state.deskFails = false;
  state.deskReads = 0;
});

describe("an invitation issue is shown to everyone it happened to", () => {
  it("a practitioner of ONE studio sees the conflict, keeps their access, and can continue", async () => {
    state.memberships = one;
    const r = await render("invite-conflict");
    expect(r.redirect).toBeNull();
    expect(r.html).toContain("We couldn&#x27;t finish setting up your access");
    expect(r.html).toContain("Your existing studio access is unchanged.");
    expect(r.html).toContain('href="/dashboard"');
  });

  it("a practitioner of TWO studios sees the conflict AND the chooser", async () => {
    state.memberships = two;
    const r = await render("invite-ambiguous");
    expect(r.redirect).toBeNull();
    expect(r.html).toContain("more than one pending invitation");
    expect(r.html).toContain("Studio One");
    expect(r.html).toContain("Studio Two");
  });

  it("a user with no membership still sees the explanation, without the access line", async () => {
    const r = await render("invite-conflict");
    expect(r.html).toContain("couldn&#x27;t be completed automatically");
    expect(r.html).not.toContain("existing studio access");
  });
});

describe("a receptionist's front-desk access counts too (Codex P2 4244092780)", () => {
  it("a receptionist-only user sees the conflict, keeps their access, and can go to the front desk", async () => {
    state.desk = [{ studio_id: "s-9" }];
    const r = await render("invite-conflict");
    expect(r.redirect).toBeNull();
    expect(r.html).toContain("Your existing studio access is unchanged.");
    expect(r.html).toContain('href="/front-desk"');
  });

  it("a FAILED front-desk read claims nothing and offers no link", async () => {
    state.deskFails = true;
    const r = await render("invite-ambiguous");
    expect(r.html).not.toContain("existing studio access");
    expect(r.html).not.toContain('href="/front-desk"');
  });

  it("without an invitation issue the front desk is never read", async () => {
    await render();
    state.memberships = two;
    await render("multiple-studios");
    expect(state.deskReads).toBe(0);
  });
});

describe("everything else is unchanged", () => {
  it("one membership and no invitation issue still goes to /dashboard", async () => {
    state.memberships = one;
    expect((await render()).redirect).toBe("/dashboard");
    expect((await render("multiple-studios")).redirect).toBe("/dashboard");
  });

  it("two memberships and no issue is the plain chooser", async () => {
    state.memberships = two;
    expect((await render("multiple-studios")).html).toContain("Choose a studio");
  });

  it("no membership and no issue is the invite-only gate", async () => {
    expect((await render()).html).toContain("No studio access yet");
  });
});
