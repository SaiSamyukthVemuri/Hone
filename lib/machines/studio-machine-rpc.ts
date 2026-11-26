import "server-only";
import { createClient } from "@/lib/supabase/server";

/** The signed-in user's client as the plain rpc the studio machine switches take. The commands run as the user: the database re-checks the owner. */
export async function studioMachineRpc(fn: string, args?: Record<string, unknown>) {
  return (await createClient()).rpc(fn as never, args as never) as unknown as PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
}
