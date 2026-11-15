import { cookies } from "next/headers";
import { LIFECYCLE_NOTICE_COOKIE } from "./lifecycle-notice";

/**
 * Forget any outcome notice left by an EARLIER action. Every waitlist action that can redirect calls
 * this first, so the cookie on the next render can only be the one the latest action set. Without it a
 * notice still inside its window would re-show after an unrelated action ("Removed..." after a release).
 * Best effort: a context with no request cookies must not turn an action into a failure.
 */
export async function clearLifecycleNotice(): Promise<void> {
  try {
    const jar = await cookies();
    jar.delete({ name: LIFECYCLE_NOTICE_COOKIE, path: "/settings/waitlist" });
  } catch {
    // no request scope: nothing to clear
  }
}
