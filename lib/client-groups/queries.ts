import type { SupabaseClient } from "@supabase/supabase-js";
import { type ClientGroup, type GroupRead, unavailable, GROUP_LIMIT, UUID, groupName } from "./model";

/** These reads use the caller's session, never an administrative client. DB RLS repeats the owner gate. */
export async function readGroups(db: SupabaseClient, studioId: string, owner: boolean): Promise<GroupRead<ClientGroup[]>> {
  if (!owner) return unavailable;
  try {
    const { data, error, count } = await db.from("client_groups").select("id,name,updated_at", { count: "exact" })
      .eq("studio_id", studioId).order("name").limit(GROUP_LIMIT + 1);
    if (error || !Array.isArray(data) || count !== data.length || data.length > GROUP_LIMIT ||
        data.some((g) => !UUID.test(g.id) || !groupName(g.name) || typeof g.updated_at !== "string")) return unavailable;
    return { available: true, value: data };
  } catch { return unavailable; }
}

/** Exact count checks prevent a provider row ceiling from masquerading as complete membership. */
export async function readGroupMembers(db: SupabaseClient, studioId: string, owner: boolean, groupId: string): Promise<GroupRead<Set<string>>> {
  if (!owner || !UUID.test(groupId)) return unavailable;
  const ids = new Set<string>();
  try {
    let expected: number | null = null;
    for (let start = 0; start < 100000; start += 500) {
      const { data, error, count } = await db.from("client_group_memberships").select("client_id", { count: "exact" })
        .eq("studio_id", studioId).eq("group_id", groupId).order("client_id").range(start, start + 499);
      if (error || !Array.isArray(data) || count === null || (expected !== null && expected !== count)) return unavailable;
      expected = count;
      for (const row of data) {
        if (!UUID.test(row.client_id) || ids.has(row.client_id)) return unavailable;
        ids.add(row.client_id);
      }
      if (ids.size === expected) return { available: true, value: ids };
      if (data.length !== 500 || ids.size > expected) return unavailable;
    }
  } catch { return unavailable; }
  return unavailable;
}

/** Only visible client ids are read. At most 26 directory clients, or one profile. */
export async function readClientGroups(db: SupabaseClient, studioId: string, owner: boolean, clientIds: string[], catalogue: GroupRead<ClientGroup[]>): Promise<GroupRead<Map<string, ClientGroup[]>>> {
  if (!owner || !catalogue.available || clientIds.length > 26) return unavailable;
  if (!clientIds.length) return { available: true, value: new Map() };
  try {
    const result = new Map<string, ClientGroup[]>();
    const byId = new Map(catalogue.value.map((g) => [g.id, g]));
    // Up to 100 groups/client. Page the bounded display read as well; API defaults can be below 2600.
    let expected: number | null = null;
    let seen = 0;
    const pairs = new Set<string>();
    for (let start = 0; start < 3000; start += 500) {
      const { data, error, count } = await db.from("client_group_memberships").select("client_id,group_id", { count: "exact" })
        .eq("studio_id", studioId).in("client_id", clientIds).order("client_id").order("group_id").range(start, start + 499);
      if (error || !Array.isArray(data) || count === null || (expected !== null && expected !== count)) return unavailable;
      expected = count;
      for (const row of data) {
        const group = byId.get(row.group_id);
        const key = `${row.client_id}:${row.group_id}`;
        if (!group || !clientIds.includes(row.client_id) || pairs.has(key)) return unavailable;
        pairs.add(key); seen += 1;
        result.set(row.client_id, [...(result.get(row.client_id) ?? []), group]);
      }
      if (seen === expected) {
        for (const groups of result.values()) groups.sort((a, b) => a.name.localeCompare(b.name));
        return { available: true, value: result };
      }
      if (data.length !== 500 || seen > expected) return unavailable;
    }
  } catch { return unavailable; }
  return unavailable;
}
