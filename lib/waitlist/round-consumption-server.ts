import "server-only";

import { createAdminClient } from "@/lib/supabase/admin-server";

// ===========================================================================
// THE CANONICAL CONSUMED COUNT — server-internal, never a Server Action
// ===========================================================================
//
// WHY THIS IS NOT IN capacity-actions.ts. That module carries "use server", so
// EVERY exported async function in it is a Server Action boundary: Next ships an
// id for it to the browser and the browser can invoke it. A reader that took an
// arbitrary round id and went straight to service-role was therefore remotely
// invocable with any uuid, which is not a thing an owner-scoped surface should
// expose regardless of how narrow its answer is.
//
// `import "server-only"` makes importing this from a client bundle a BUILD
// ERROR, and being outside a "use server" module means Next never mints an
// action id for it. It is reachable only by server code that already decided
// the caller may see this round.
//
// WHY IT GOES THROUGH 0197'S GATEWAY AND NOT 0192'S FUNCTION DIRECTLY.
//
// 0192's `waitlist_admission_round_consumed` is SECURITY INVOKER and reads
// `new_client_waitlist_invitations`. service_role holds EXECUTE on it and,
// deliberately, NO SELECT on that table -- so calling it from here failed with
//
//     42501 permission denied for table new_client_waitlist_invitations
//
// every single time. This helper turned that into `null`, `null` became
// "capacity unknown", and unknown WITHHELD the send: an owner who had correctly
// opened a capacity still could not invite. Every DB test used the admin
// connection, which is why the suites were green throughout.
//
// 0197 adds a SECURITY DEFINER gateway that validates the studio/round pair and
// DELEGATES the counting to 0192, so "used" keeps one definition and no table
// privilege is granted to anyone.
//
// THE CALLER SUPPLIES BOTH IDS FROM SERVER STATE. The studio comes from the
// authenticated page context and the round from the page's OWN owner/RLS-scoped
// read, so the tenant decision is made before this is reached. Neither may ever
// come from a browser form -- and the gateway validates the pair regardless.

/**
 * How many of a round's seats the DATABASE says are used.
 *
 * READ, NEVER RECOMPUTED. `waitlist_admission_round_consumed` is the canonical
 * definition — it counts a seat as spent when an invitation is redeemed OR is
 * still live and answerable. A second definition here would be the competing
 * capacity engine this feature must not become.
 *
 * Returns null when the count cannot be ESTABLISHED, which callers must treat as
 * "unknown capacity" and never as "zero used".
 */
export async function readRoundConsumed(
  studioId: string,
  roundId: string,
): Promise<number | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("read_waitlist_admission_round_consumed", {
      p_studio_id: studioId,
      p_round_id: roundId,
    });
    if (error) return null;
    // The gateway answers NULL for a pair it cannot match, which is "no answer"
    // and not "zero" -- `coerceConsumed` already rejects null for that reason.
    return coerceConsumed(data);
  } catch {
    return null;
  }
}

/**
 * The ONLY shape this RPC legitimately returns, and nothing else.
 *
 * NO BROAD NUMERIC COERCION. The previous form was
 *
 *     const used = typeof data === "number" ? data : Number(data);
 *
 * and `Number(null)` is `0` — so a null answer, which means the count could not
 * be established, became "zero seats used". That reads as a completely empty
 * capacity and would OFFER invitations the database may refuse. `Number([])` is
 * 0 too, and `Number("3")` quietly accepts a shape this RPC does not return.
 *
 * 0192 declares `waitlist_admission_round_consumed(uuid) returns integer`, so a
 * non-negative integer is the whole contract. Everything else — null, undefined,
 * NaN, Infinity, strings, objects, arrays, negatives, non-integers — is
 * UNKNOWN, and unknown withholds the invitation rather than permitting it.
 */
export function coerceConsumed(data: unknown): number | null {
  if (typeof data !== "number") return null;
  if (!Number.isFinite(data)) return null;
  if (!Number.isInteger(data)) return null;
  if (data < 0) return null;
  return data;
}
