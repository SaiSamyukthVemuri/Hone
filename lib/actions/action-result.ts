import { isServerActionTransportFailure } from "@/lib/reliability/server-action-transport";

// HON-124 item 19. What a settings/client form shows when a server action does not succeed.
//
// WHY A RETURNED RESULT AND NOT A THROW. Next.js redacts the message of a server-action error thrown in production to its opaque
// "An error occurred in the Server Components render. The specific message is omitted in production builds..." text, so a form that
// prints err.message shows that sentence (no next step), and a thrown DB message would carry internal codes. An action that expects a
// failure (validation, permission, a rejected write) RETURNS { ok: false, error } with a sentence written for the person, and keeps
// anything unexpected as a throw that the form maps through actionFailureMessage below.
//
// Client-safe: no server imports. Types and pure functions only (the "use server" action modules may not export these themselves).

export type ActionResult = { ok: true } | { ok: false; error: string };

export const ACTION_OK: ActionResult = { ok: true };

export function actionFailed(error: string): ActionResult {
  return { ok: false, error };
}

/** The sentence when nothing more specific is known: names the next action, never the cause. */
export const GENERIC_SAVE_FAILURE = "Could not save. Check your connection and try again. If it keeps happening, contact support.";
export const LOST_REQUEST_FAILURE = "Could not reach Hone, so this may not have saved. Check your connection, then check the page before trying again.";

/**
 * The message for a CAUGHT error. It never returns the error's own text (production redacts it, development leaks internals): a lost
 * request gets the connection sentence, everything else gets the caller's fallback.
 */
export function actionFailureMessage(err: unknown, fallback: string = GENERIC_SAVE_FAILURE): string {
  return isServerActionTransportFailure(err) ? LOST_REQUEST_FAILURE : fallback;
}
