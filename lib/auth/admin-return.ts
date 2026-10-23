import "server-only";
import { cookies } from "next/headers";
import { isAdmin } from "@/lib/admin";
import { ADMIN_RETURN_COOKIE, safeAdminReturnPath } from "./return-path";

// ===========================================================================
// The remembered /admin target, carried through sign-in's required steps
// (LEAD-ALERT-01, Codex P2 4263663458)
// ===========================================================================
//
// The middleware remembers a validated /admin path when a signed-out operator
// opens a lead link. Sign-in may then REQUIRE a step first: accepting a
// pending studio invitation, or choosing a studio after becoming multi-studio.
// The target is carried through such a step, untouched, and used only when the
// step COMPLETES. It is cleared when the target is fulfilled or the step is
// legitimately refused (an invitation conflict, ambiguity or absence, or
// signing out at the gate), and never used for anyone who is not an
// allowlisted operator. It only ever chooses where an operator lands: the
// /admin layout and every admin action still check isAdmin themselves, and no
// invitation or studio step is skipped to get there.
// ===========================================================================

/** The target, for an allowlisted operator only; null otherwise. Pure. */
export function adminReturnTargetFor(
  raw: string | null | undefined,
  email: string | null | undefined,
): string | null {
  return isAdmin(email) ? safeAdminReturnPath(raw) : null;
}

/**
 * A required step has COMPLETED: the remembered target (for an operator) or
 * null, and the cookie is cleared either way. One target, one use.
 */
export async function fulfilAdminReturn(email: string | null | undefined): Promise<string | null> {
  const jar = await cookies();
  const target = adminReturnTargetFor(jar.get(ADMIN_RETURN_COOKIE)?.value, email);
  if (jar.has(ADMIN_RETURN_COOKIE)) jar.delete(ADMIN_RETURN_COOKIE);
  return target;
}

/** The step was legitimately refused: forget the target. */
export async function clearAdminReturn(): Promise<void> {
  const jar = await cookies();
  if (jar.has(ADMIN_RETURN_COOKIE)) jar.delete(ADMIN_RETURN_COOKIE);
}
