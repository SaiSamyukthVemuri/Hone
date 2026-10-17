import { redirect } from "next/navigation";

// ---------------------------------------------------------------------------
// OWNER-ONLY studio surfaces (#824).
//
// THE RULING: employees are blocked from financial records; access is the
// owner's. This module is the single definition of that rule, so the financial
// surfaces cannot drift apart — four inline copies of `role !== "owner"` is how
// one of them later forgets.
//
// WHY THIS TAKES AN ALREADY-RESOLVED IDENTITY instead of resolving one itself.
// An earlier version wrapped `requirePractitionerWithStudio()`, and
// tests/source-guards/server-render-identity-guard.test.ts refused it — by
// design. That guard (SENTRY-IDENTITY-01) requires every authenticated page to
// resolve identity ITSELF, and it deliberately reports wrappers, aliases and
// re-exports rather than following them, because a page that delegates its
// identity resolution is the shape that let a layout's redirect fail to stop a
// page. Widening that guard to admit a wrapper would have traded a real
// invariant for my convenience, so the page keeps the resolver call and this
// module carries only the ROLE rule.
//
// "OWNER/ADMINS" RESOLVES TO OWNER-ONLY, as a fact about the schema and not a
// reading of the instruction: `practitioners.role` is CHECK-constrained to
// exactly `('owner', 'practitioner')`, so there is no admin or manager studio
// role to admit. The only "admin" in Hone is the PLATFORM `/admin` surface
// (platform leads, studio creation), which is Hone staff and not a studio
// membership. If a studio-level manager is wanted later it is a schema change
// and its own decision, and this module would admit it in one place.
//
// A RECEPTIONIST NEVER REACHES HERE: no `practitioners` row, so the page's own
// resolver does not resolve them, and the middleware sends their every
// non-front-desk path to `/front-desk` first.
//
// WHY /dashboard AND NOT /no-access. A non-owner practitioner HAS studio
// access; they are simply not the owner. `/no-access` is the invite-only gate
// for someone with no membership, and it already redirects a practitioner to
// `/dashboard` — going there directly is the same idiom without the bounce.
// ---------------------------------------------------------------------------

/**
 * Refuse anyone who is not the studio OWNER, by redirecting to `/dashboard`.
 *
 * Call it immediately after the page's own `requirePractitionerWithStudio()`.
 * It takes the resolved practitioner rather than resolving one, so the page
 * remains the thing that resolves identity (SENTRY-IDENTITY-01).
 */
export function assertStudioOwner(practitioner: { role: string }): void {
  if (practitioner.role !== "owner") {
    redirect("/dashboard");
  }
}
