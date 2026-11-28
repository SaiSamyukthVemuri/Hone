import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAccountSignIns, type StaffSignInState } from "./staff-sign-in";

export type StudioListSignIn = Exclude<StaffSignInState, { state: "account_removed" }> | { state: "no_active_accounts" };

type Membership = { id: string; studio_id: string; user_id: string };
type StaffTable = "practitioners" | "studio_receptionists";

// Bound the studio_id filter URL and page memberships independently of roster size.
const STUDIO_BATCH_SIZE = 50;
const PAGE_SIZE = 500;

async function readMemberships(admin: SupabaseClient, table: StaffTable, studioIds: string[]): Promise<Membership[] | null> {
  const members: Membership[] = [];
  let after: string | undefined;
  try {
    while (true) {
      let query = admin.from(table)
        .select("id, studio_id, user_id", { count: "exact" })
        .in("studio_id", studioIds)
        .eq("active", true)
        .not("user_id", "is", null)
        .order("id")
        .limit(PAGE_SIZE);
      if (after) query = query.gt("id", after);
      const { data, error, count } = await query;
      if (error || !data) return null;
      if (data.length === 0) return count ? null : members;
      members.push(...data);
      // count covers the remaining filtered rows, even when the API row cap
      // is smaller than PAGE_SIZE. A short page alone never proves completion.
      if (count === data.length) return members;
      const last = data[data.length - 1].id;
      if (!last || (after && last <= after)) return null;
      after = last;
    }
  } catch {
    return null;
  }
}

function latestSignIn(userIds: string[], accounts: Map<string, StaffSignInState>): StudioListSignIn {
  if (userIds.length === 0) return { state: "no_active_accounts" };
  let latest: string | undefined;
  for (const id of userIds) {
    const account = accounts.get(id);
    if (!account || account.state === "unknown" || account.state === "account_removed") return { state: "unknown" };
    if (account.state === "signed_in" && (!latest || Date.parse(account.at) > Date.parse(latest))) latest = account.at;
  }
  return latest ? { state: "signed_in", at: latest } : { state: "never_signed_in" };
}

export async function loadStudioListSignIns(admin: SupabaseClient, studioIds: string[]): Promise<Map<string, StudioListSignIn>> {
  const rosters = new Map<string, string[]>();
  const result = new Map<string, StudioListSignIn>();
  for (let offset = 0; offset < studioIds.length; offset += STUDIO_BATCH_SIZE) {
    const batch = studioIds.slice(offset, offset + STUDIO_BATCH_SIZE);
    const [practitioners, receptionists] = await Promise.all([
      readMemberships(admin, "practitioners", batch),
      readMemberships(admin, "studio_receptionists", batch),
    ]);
    if (!practitioners || !receptionists) {
      for (const id of batch) result.set(id, { state: "unknown" });
      continue;
    }
    for (const id of batch) rosters.set(id, []);
    for (const member of [...practitioners, ...receptionists]) rosters.get(member.studio_id)?.push(member.user_id);
  }
  const accounts = await loadAccountSignIns(admin, Array.from(rosters.values()).flat());
  for (const [studioId, userIds] of rosters) result.set(studioId, latestSignIn(userIds, accounts));
  return result;
}
