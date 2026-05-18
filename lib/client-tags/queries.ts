import { createClient } from "@/lib/supabase/server";
import type { ClientTag } from "@/lib/types/database";

export async function getClientTags(
  studioId: string,
  clientId: string,
): Promise<ClientTag[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("client_tags")
    .select("*")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to load tags: ${error.message}`);
  return (data ?? []) as ClientTag[];
}
