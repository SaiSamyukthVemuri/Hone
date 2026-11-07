import { beforeEach, describe, expect, it, vi } from "vitest";

// Security finding (Machines, 7 Nov 2026): the invite-only signup gate looked up pending_invitations with an UNESCAPED ilike on the typed
// address, so `_` and `%` were wildcards: bob_jones@x.com matched ANOTHER person's pending invite bob.jones@x.com and turned shouldCreateUser
// on. The fake table below implements Postgres LIKE/ILIKE semantics (backslash escapes, % = any run, _ = any one char, case-insensitive).

const h = vi.hoisted(() => ({ invites: [] as Array<{ id: string; email: string; status: string }>, otp: vi.fn(async () => ({ error: null })) }));

function likeToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "%") out += ".*";
    else if (ch === "_") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "is");
}

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: () => {
      const filters: Array<(r: { email: string; status: string }) => boolean> = [];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      // PostgREST rewrites * to % in like/ilike values BEFORE Postgres sees them (probed live): the fake does the same.
      b.ilike = (col: string, pat: string) => { const sent = pat.replace(/\*/g, "%"); filters.push((r) => likeToRegExp(sent).test((r as Record<string, string>)[col])); return b; };
      b.limit = () => b;
      b.eq = (col: string, v: string) => { filters.push((r) => (r as Record<string, string>)[col] === v); return b; };
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: h.invites.filter((r) => filters.every((f) => f(r))), error: null });
      return b;
    },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { signInWithOtp: h.otp } }) }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://hone.test" }));

import { requestPractitionerMagicLinkAction } from "@/app/(auth)/login/actions";

const lastOptions = () => (h.otp.mock.calls.at(-1) as unknown as [{ options: { shouldCreateUser: boolean } }])[0].options;

beforeEach(() => {
  h.otp.mockClear();
  h.invites = [
    { id: "i1", email: "bob.jones@example.com", status: "pending" },
    { id: "i2", email: "Alice_Smith@Example.com", status: "pending" },
  ];
});

describe("invite-only signup gate: the typed address is matched LITERALLY, case-insensitively", () => {
  it("an address with an underscore does NOT match another person's invite (bob_jones vs bob.jones)", async () => {
    await requestPractitionerMagicLinkAction("bob_jones@example.com");
    expect(lastOptions().shouldCreateUser).toBe(false);
  });
  it("a percent sign does NOT match either (a%@example.com)", async () => {
    await requestPractitionerMagicLinkAction("b%@example.com");
    expect(lastOptions().shouldCreateUser).toBe(false);
  });
  it("PostgREST's * alias for %: b*@example.com does NOT enable signup", async () => {
    await requestPractitionerMagicLinkAction("b*@example.com");
    expect(lastOptions().shouldCreateUser).toBe(false);
  });
  it("*@example.com (matches every invite at the domain) does NOT enable signup", async () => {
    await requestPractitionerMagicLinkAction("*@example.com");
    expect(lastOptions().shouldCreateUser).toBe(false);
  });
  it("even if the filter returned a wildcard-matched candidate (escape removed), the in-code exact compare refuses it", async () => {
    const { singleExactEmailRow } = await import("@/lib/invitations/email-match");
    expect(singleExactEmailRow([{ email: "bob.jones@example.com" }], "b*@example.com")).toBeNull();
    expect(singleExactEmailRow([{ email: "bob.jones@example.com" }, { email: "carol@example.com" }], "*@example.com")).toBeNull();
  });
  it("a mixed-case exact match still allows signup", async () => {
    await requestPractitionerMagicLinkAction("  BOB.Jones@Example.COM ");
    expect(lastOptions().shouldCreateUser).toBe(true);
  });
  it("an invitation whose own address contains an underscore matches itself, in any case", async () => {
    await requestPractitionerMagicLinkAction("alice_smith@example.com");
    expect(lastOptions().shouldCreateUser).toBe(true);
  });
  it("...and its underscore does not stand for a different character (aliceXsmith)", async () => {
    await requestPractitionerMagicLinkAction("alicexsmith@example.com");
    expect(lastOptions().shouldCreateUser).toBe(false);
  });
});
