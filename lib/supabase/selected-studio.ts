import "server-only";
import { cookies } from "next/headers";

// Selected-studio persistence for multi-studio users (PR 2).
//
// A user may be an active practitioner in more than one studio. When they have
// 2+ active memberships they must CHOOSE which studio they are working in; the
// choice is persisted in this httpOnly cookie. The cookie holds ONLY a studio_id
// (a uuid, not a secret) and is NEVER trusted on its own: every resolver
// re-queries the user's active memberships (RLS-scoped) and honors the cookie
// only if it matches an active membership. A forged/stale value simply resolves
// to "no valid selection" and falls back to the chooser, so the cookie can never
// grant access to a studio the user is not an active member of.
export const SELECTED_STUDIO_COOKIE = "hone_selected_studio";

// Re-validated on every request, so a long lifetime is harmless and gives a
// stable selection across sessions on the same browser.
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export async function readSelectedStudioId(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(SELECTED_STUDIO_COOKIE)?.value ?? null;
}

// Set only from a server action AFTER the caller has verified the user is an
// active practitioner in `studioId`. Never call with an unverified id.
export async function setSelectedStudioId(studioId: string): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: SELECTED_STUDIO_COOKIE,
    value: studioId,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function clearSelectedStudioId(): Promise<void> {
  const jar = await cookies();
  jar.delete(SELECTED_STUDIO_COOKIE);
}
