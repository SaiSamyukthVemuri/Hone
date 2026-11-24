import { isDeskEnabled } from "@/lib/desk/flag";

// Whether to offer a signed-in user with no practitioner membership a way into the desk, from the /no-access page.
// Flag off: false with no read at all, so the page is exactly what it is today. A failed read is false, never true.

type Rows = PromiseLike<{ data: unknown[] | null; error: unknown }>;
type Query = { eq: (c: string, v: string | boolean) => Query; limit: (n: number) => Rows };
export type EntrySupabase = { from: (t: string) => { select: (cols: string) => Query } };

export async function deskEntryAvailable(supabase: EntrySupabase, userId: string): Promise<boolean> {
  if (!isDeskEnabled()) return false;
  try {
    const r = await supabase.from("studio_receptionists").select("id").eq("user_id", userId).eq("active", true).limit(1);
    return !r.error && (r.data ?? []).length > 0;
  } catch {
    return false;
  }
}
