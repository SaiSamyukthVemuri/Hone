import { describe, expect, it, vi, beforeEach } from "vitest";

// ===========================================================================
// #824 — assertStudioOwner BEHAVIOUR: a non-owner practitioner is refused.
// ===========================================================================
//
// The source contract (tests/source-guards/financial-surfaces-owner-only)
// proves each financial page resolves identity AND then applies this rule, in
// that order. It cannot prove what the rule DOES. This file runs it.
//
// THE MOCK RECORDS, IT DOES NOT THROW. Real `redirect()` throws to unwind the
// render, and an earlier version of this file modelled that — but a throwing
// mock registered through a `vi.mock` factory broke module evaluation and
// failed all three cases with one `NEXT_REDIRECT:undefined`, which is a worse
// test than a simpler one. Recording is enough here because the rule has NO
// statements after its `redirect()` call, and that ordering is pinned by the
// source contract rather than assumed.

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect }));

const { assertStudioOwner } = await import("@/lib/auth/require-studio-owner");

beforeEach(() => redirect.mockClear());

describe("#824: assertStudioOwner", () => {
  it("REFUSES a non-owner practitioner, by redirecting to /dashboard", () => {
    assertStudioOwner({ role: "practitioner" });
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/dashboard");
  });

  it("ADMITS the owner, and redirects nobody", () => {
    // NON-VACUITY. Without this the suite passes against a rule that refuses
    // EVERYONE, which would lock the owner out of their own financials.
    assertStudioOwner({ role: "owner" });
    expect(redirect, "the owner must not be redirected").not.toHaveBeenCalled();
  });

  it("refuses any role that is not EXACTLY 'owner'", () => {
    // Guards against a loose check — includes(), a truthiness test, or a
    // case-insensitive compare — admitting something later.
    for (const role of [
      "practitioner",
      "Owner",
      "OWNER",
      "owner ",
      " owner",
      "",
      "admin",
      "manager",
    ]) {
      redirect.mockClear();
      assertStudioOwner({ role });
      expect(redirect, `role=${JSON.stringify(role)} must be refused`).toHaveBeenCalledWith(
        "/dashboard",
      );
    }
  });
});
