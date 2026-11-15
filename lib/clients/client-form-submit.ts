// What a client-form save did, from the browser's point of view.
//
// A server action that ends in redirect() does NOT resolve in the browser: Next rejects the awaited promise with
// a redirect error so the router can navigate (node_modules/next/.../server-action-reducer.js, "the action
// promise will be rejected with a redirect"). The form used to catch every throw and show a generic error, so a
// save that had already succeeded flashed "Couldn't save the client" until the next page painted. A redirect is
// the server's confirmation that the write returned no error; it must be passed back to the router untouched.

export type SaveActionResult = { ok: false; error: string } | void;

export type SaveOutcome<R> =
  | { kind: "redirect"; redirect: unknown }
  | { kind: "refused"; result: Extract<R, { ok: false }> }
  | { kind: "saved" }
  | { kind: "failed" };

/** Next's redirect error carries a digest "NEXT_REDIRECT;<type>;<url>;<status>;". */
export function isRedirectError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const digest = (error as { digest?: unknown }).digest;
  if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.startsWith("NEXT_REDIRECT");
}

export async function runClientSave<R extends SaveActionResult>(
  action: (formData: FormData) => Promise<R>,
  formData: FormData,
): Promise<SaveOutcome<R>> {
  try {
    const result = await action(formData);
    if (result && (result as { ok?: boolean }).ok === false) {
      return { kind: "refused", result: result as Extract<R, { ok: false }> };
    }
    return { kind: "saved" };
  } catch (error) {
    if (isRedirectError(error)) return { kind: "redirect", redirect: error };
    return { kind: "failed" };
  }
}

/** The pending state is bounded: past this a neutral "could not confirm" line is shown (never success). */
export const SAVE_CONFIRM_TIMEOUT_MS = 20_000;
export const SAVE_UNCONFIRMED_MESSAGE =
  "Still saving. If this does not finish, reload the page to check whether your change was saved.";
