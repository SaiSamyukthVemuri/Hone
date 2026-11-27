import type { SupabaseClient } from "@supabase/supabase-js";

// HON-82. Each staff member of ONE studio and the account's last successful sign-in. Read-only, service role, behind the /admin gate.
//
// Privacy (reviewed rule, see tests/app/admin/admin-studio-detail.test.ts): the operator sees display name, role and the sign-in time.
// NO email, no user id, no client data. The two membership tables are read with an explicit column list that holds none of those.
//
// What the timestamp is: auth.users.last_sign_in_at through the admin API. It is account-wide (the same time for every studio the
// person belongs to) and moves only on a real sign-in, so a long-lived session looks stale. It is never presence.

export type StaffRole = "owner" | "practitioner" | "receptionist";

export type StaffSignInState =
  | { state: "signed_in"; at: string }
  | { state: "never_signed_in" } // an account exists, and it has never signed in
  | { state: "account_removed" } // the membership row exists but its auth account was deleted (user_id set null)
  | { state: "unknown" }; // the read failed or timed out: never shown as "never" or as a time

export type StaffSignIn = {
  key: string;
  displayName: string;
  role: StaffRole;
  /** false = revoked or deactivated: still listed, labelled, never hidden. */
  active: boolean;
  signIn: StaffSignInState;
};

/** At most this many staff per studio are looked up; more is reported, never silently dropped. */
export const STAFF_SIGN_IN_CAP = 50;
/** One account lookup may take at most this long; a slow one is "unknown", and the page does not wait for it. */
export const STAFF_LOOKUP_TIMEOUT_MS = 3_000;
const LOOKUP_CONCURRENCY = 8;

type Member = { key: string; displayName: string; role: StaffRole; active: boolean; userId: string | null };

export type StaffSignInReport = {
  staff: StaffSignIn[];
  /** true when the studio has more staff than STAFF_SIGN_IN_CAP: the rest are not listed. */
  truncated: boolean;
  /** true when the membership read itself failed: no list is shown, and the page says so. */
  unavailable: boolean;
  /**
   * Invitations still waiting to be accepted, counted by role ONLY. A membership row exists only after acceptance, so a new studio has none
   * until then. NO email, name or other invitation column is read. null = that read failed (shown as unknown, never as zero).
   */
  pendingInvites: PendingInviteCounts | null;
};

export type PendingInviteCounts = { owner: number; practitioner: number; receptionist: number; total: number };

/** Count pending invitations by role. Reads the role column of unaccepted, unrevoked rows and nothing else. */
async function loadPendingInviteCounts(admin: SupabaseClient, studioId: string): Promise<PendingInviteCounts | null> {
  try {
    const { data, error } = await admin
      .from("pending_invitations")
      .select("role")
      .eq("studio_id", studioId)
      .eq("status", "pending")
      .limit(STAFF_SIGN_IN_CAP + 1);
    if (error) return null;
    const counts: PendingInviteCounts = { owner: 0, practitioner: 0, receptionist: 0, total: 0 };
    for (const r of (data ?? []) as Array<{ role: string | null }>) {
      counts.total += 1;
      if (r.role === "owner") counts.owner += 1;
      else if (r.role === "receptionist") counts.receptionist += 1;
      else counts.practitioner += 1;
    }
    return counts;
  } catch {
    return null;
  }
}

export function signInState(userId: string | null, lookup: { ok: true; lastSignInAt: string | null } | { ok: false }): StaffSignInState {
  if (userId === null) return { state: "account_removed" };
  if (!lookup.ok) return { state: "unknown" };
  if (lookup.lastSignInAt === null) return { state: "never_signed_in" };
  return Number.isFinite(Date.parse(lookup.lastSignInAt)) ? { state: "signed_in", at: lookup.lastSignInAt } : { state: "unknown" };
}

async function lookupLastSignIn(
  admin: SupabaseClient,
  userId: string,
): Promise<{ ok: true; lastSignInAt: string | null } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<{ ok: false }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false }), STAFF_LOOKUP_TIMEOUT_MS);
    });
    const answer = (async () => {
      const { data, error } = await admin.auth.admin.getUserById(userId);
      if (error || !data?.user) return { ok: false as const };
      const v = (data.user as { last_sign_in_at?: string | null }).last_sign_in_at;
      return { ok: true as const, lastSignInAt: typeof v === "string" && v.length > 0 ? v : null };
    })();
    return await Promise.race([answer, timeout]);
  } catch {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function loadStaffSignIns(admin: SupabaseClient, studioId: string): Promise<StaffSignInReport> {
  let members: Member[];
  try {
    const [pracs, recs] = await Promise.all([
      admin
        .from("practitioners")
        .select("id, display_name, role, active, user_id")
        .eq("studio_id", studioId)
        .order("created_at", { ascending: true })
        .limit(STAFF_SIGN_IN_CAP + 1),
      admin
        .from("studio_receptionists")
        .select("id, display_name, active, user_id")
        .eq("studio_id", studioId)
        .order("created_at", { ascending: true })
        .limit(STAFF_SIGN_IN_CAP + 1),
    ]);
    if (pracs.error || recs.error) return { staff: [], truncated: false, unavailable: true, pendingInvites: null };
    members = [
      ...((pracs.data ?? []) as Array<{ id: string; display_name: string; role: string; active: boolean; user_id: string | null }>).map((p) => ({
        key: `p:${p.id}`,
        displayName: p.display_name,
        role: (p.role === "owner" ? "owner" : "practitioner") as StaffRole,
        active: p.active === true,
        userId: p.user_id,
      })),
      ...((recs.data ?? []) as Array<{ id: string; display_name: string; active: boolean; user_id: string | null }>).map((r) => ({
        key: `r:${r.id}`,
        displayName: r.display_name,
        role: "receptionist" as StaffRole,
        active: r.active === true,
        userId: r.user_id,
      })),
    ];
  } catch {
    return { staff: [], truncated: false, unavailable: true, pendingInvites: null };
  }

  const pendingInvites = await loadPendingInviteCounts(admin, studioId);

  const truncated = members.length > STAFF_SIGN_IN_CAP;
  members = members.slice(0, STAFF_SIGN_IN_CAP);

  // One lookup per distinct account (a person who is both staff roles in different tables is looked up once), a few at a time.
  const ids = [...new Set(members.map((m) => m.userId).filter((x): x is string => x !== null))];
  const found = new Map<string, Awaited<ReturnType<typeof lookupLastSignIn>>>();
  for (let i = 0; i < ids.length; i += LOOKUP_CONCURRENCY) {
    const chunk = ids.slice(i, i + LOOKUP_CONCURRENCY);
    const got = await Promise.all(chunk.map((id) => lookupLastSignIn(admin, id)));
    chunk.forEach((id, j) => found.set(id, got[j]));
  }

  return {
    staff: members.map((m) => ({
      key: m.key,
      displayName: m.displayName,
      role: m.role,
      active: m.active,
      signIn: signInState(m.userId, m.userId === null ? { ok: false } : (found.get(m.userId) ?? { ok: false })),
    })),
    truncated,
    unavailable: false,
    pendingInvites,
  };
}
