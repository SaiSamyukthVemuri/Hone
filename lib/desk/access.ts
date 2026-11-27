// The per-studio half of the front desk gate. The process-wide env flag (lib/desk/flag.ts) stays the MASTER switch: with it off nothing
// here is ever called and nothing is read. With it on, a receptionist reaches a studio's desk only where the platform has switched the
// Front Desk on for that studio AND the receptionist holds a seat in it (migration 0390). The database decides, through one
// authenticated, argument-less function that derives the user from the session: a caller can only ever ask about themselves, and the
// request path needs no service-role client. The same predicate sits inside receptionist_actor_id, so a receptionist who calls a desk
// RPC directly with their own token is refused exactly as the page is; this read exists so the page can say so before it renders.
//
// A failed read is loud (it throws), never "no studios": the caller must not turn an outage into a quiet empty desk, and must never
// turn it into an open one.

type Rpc = (fn: "front_desk_access") => PromiseLike<{ data: unknown; error: unknown }>;
export type AccessSupabase = { rpc: Rpc };

/** The studio ids in which this signed-in user may use the front desk right now (switch on, active, seated). */
export async function frontDeskStudioIds(supabase: AccessSupabase): Promise<ReadonlySet<string>> {
  const { data, error } = await supabase.rpc("front_desk_access");
  if (error) throw new Error("Failed to load front desk access");
  if (!Array.isArray(data) || !data.every((id): id is string => typeof id === "string")) {
    throw new Error("Failed to load front desk access");
  }
  return new Set(data);
}
