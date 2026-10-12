import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// STUDIO-READY-02b (#824), Codex P2 4244069747 on #850: an invitation that
// could not be completed is explained to a person who ALREADY works in a
// studio, instead of being redirected away before the reason is shown.

const state: { memberships: Array<{ studioId: string; studioName: string; role: string }> } = { memberships: [] };

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`REDIRECT ${to}`), { to });
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u-1" } } }) } }),
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
