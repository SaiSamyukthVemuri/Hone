import { createClient } from "@/lib/supabase/server";
import { unavailable, type ClientGroup, type GroupRead } from "./model";
import { readClientGroups, readGroups } from "./queries";

/** One dependent group read chain joins the profile's independent parallel wave. */
export async function readProfileGroups(studioId: string, clientId: string, ownerOverview: boolean): Promise<{
  catalogue: GroupRead<ClientGroup[]>;
  assigned: GroupRead<ClientGroup[]>;
}> {
  if (!ownerOverview) return { catalogue: unavailable, assigned: unavailable };
  const db = await createClient();
  const catalogue = await readGroups(db, studioId, true);
  const labels = await readClientGroups(db, studioId, true, [clientId], catalogue);
  return { catalogue, assigned: labels.available ? { available: true, value: labels.value.get(clientId) ?? [] } : unavailable };
}
