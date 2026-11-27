import { isDeskEnabled } from "@/lib/desk/flag";
import { frontDeskStudioIds } from "@/lib/desk/access";

// Whether to offer a signed-in user with no practitioner membership a way into the desk, from the /no-access page.
// Flag off: false with no read at all, so the page is exactly what it is today. A failed read is false, never true. With the flag on,
// the link is offered only where the per-studio Front Desk is on and the receptionist is seated.

type Rows = PromiseLike<{ data: unknown[] | null; error: unknown }>;
type Query = { eq: (c: string, v: string | boolean) => Query; limit: (n: number) => Rows };
export type EntrySupabase = {
  from: (t: string) => { select: (cols: string) => Query };
  rpc: (fn: "front_desk_access") => PromiseLike<{ data: unknown; error: unknown }>;
};

export async function deskEntryAvailable(supabase: EntrySupabase, userId: string): Promise<boolean> {
  if (!isDeskEnabled()) return false;
  try {
    const r = await supabase.from("studio_receptionists").select("id, studio_id").eq("user_id", userId).eq("active", true).limit(50);
    if (r.error) return false;
    const rows = (r.data ?? []) as { studio_id: string }[];
    if (rows.length === 0) return false;
    // Only a studio whose Front Desk is on and where this receptionist holds a seat counts (0390); a failed read is false.
    const allowed = await frontDeskStudioIds(supabase);
    return rows.some((row) => allowed.has(row.studio_id));
  } catch {
    return false;
  }
}
