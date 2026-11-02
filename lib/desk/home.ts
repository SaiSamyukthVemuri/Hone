import { isDeskEnabled } from "@/lib/desk/flag";

// Where a freshly signed-in user lands. Practitioner -> /dashboard (unchanged); a user whose only
// membership is an active receptionist row -> /desk; anything else -> the existing default.
//
// Flag off: returns null WITHOUT a single read, so sign-in behaves exactly as it does today. A user
// with a practitioner membership anywhere always wins (the dashboard, never the desk); a failed
// read of either table also resolves to null (the existing landing), never to /desk.

type Rows = PromiseLike<{ data: unknown[] | null; error: unknown }>;
type Query = { eq: (c: string, v: string | boolean) => Query; limit: (n: number) => Rows };
export type HomeSupabase = { from: (t: string) => { select: (cols: string) => Query } };

export async function deskHomeFor(supabase: HomeSupabase, userId: string): Promise<"/desk" | null> {
  if (!isDeskEnabled()) return null;
  const practitioner = await supabase
    .from("practitioners")
    .select("studio_id")
    .eq("user_id", userId)
    .eq("active", true)
    .limit(1);
  if (practitioner.error || (practitioner.data ?? []).length > 0) return null;
  const receptionist = await supabase
    .from("studio_receptionists")
    .select("id")
    .eq("user_id", userId)
    .eq("active", true)
    .limit(1);
  if (receptionist.error) return null;
  return (receptionist.data ?? []).length > 0 ? "/desk" : null;
}
