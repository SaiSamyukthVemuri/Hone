import type { SupabaseClient } from "@supabase/supabase-js";

// HON-82. What the operator sees on /admin/studios/[id] about a studio being in use, and when each staff member last signed in. READ-ONLY:
// nothing here writes, and nothing is collected that the studio did not already record. Two separate facts, never merged and never
// mixed with billing or subscription status:
//
//   * STUDIO ACTIVITY: the newest timestamp across a FIXED, short list of the studio's own working records. Only a time is read.
//   * LAST SIGN-IN, per staff member: the account's last successful sign-in. It is ACCOUNT-WIDE (one auth account, however many studios it
//     belongs to), and it moves only on a real sign-in, never on a refreshed session. It is NOT presence: it never claims anyone is online.

/** How recent studio activity must be to read "Active recently". One constant: a studio is in use over a working day, not a minute. */
export const STUDIO_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The fixed list. Each entry is (table, timestamp column), scoped by studio_id, newest first, one row, the timestamp alone.
 * No client, clinical or payment content is selected. Adding a source is a reviewed change to this list and to its pin test.
 */
export const STUDIO_ACTIVITY_SOURCES = [
  { table: "appointments", column: "updated_at" },
  { table: "sessions", column: "created_at" },
  { table: "session_blocks", column: "updated_at" },
  { table: "appointment_settlements", column: "recorded_at" },
] as const;

export type StudioActivity =
  | { state: "active"; at: string }
  | { state: "inactive"; at: string | null }
  | { state: "unknown"; at: null };

/**
 * latest = the newest timestamp any source returned (null: none had a row). failed = how many sources could not be read.
 * A positive that was read stays true even if another source failed; "inactive" is only claimed when EVERY source answered.
 */
export function classifyStudioActivity(
  latest: string | null,
  failed: number,
  now: number,
  windowMs: number = STUDIO_ACTIVITY_WINDOW_MS,
): StudioActivity {
  const t = latest === null ? NaN : Date.parse(latest);
  if (Number.isFinite(t) && now - t <= windowMs) return { state: "active", at: latest! };
  if (failed > 0) return { state: "unknown", at: null };
  return { state: "inactive", at: Number.isFinite(t) ? latest : null };
}

export async function loadStudioActivity(
  admin: SupabaseClient,
  studioId: string,
  now: number = Date.now(),
): Promise<StudioActivity> {
  const answers = await Promise.all(
    STUDIO_ACTIVITY_SOURCES.map(async ({ table, column }) => {
      try {
        const { data, error } = await admin
          .from(table)
          .select(column)
          .eq("studio_id", studioId)
          .order(column, { ascending: false })
          .limit(1);
        if (error) return { ok: false as const };
        const row = (data as unknown as Array<Record<string, unknown>> | null)?.[0];
        const v = row?.[column];
        return { ok: true as const, at: typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null };
      } catch {
        return { ok: false as const };
      }
    }),
  );
  let latest: string | null = null;
  let failed = 0;
  for (const a of answers) {
    if (!a.ok) failed += 1;
    else if (a.at !== null && (latest === null || Date.parse(a.at) > Date.parse(latest))) latest = a.at;
  }
  return classifyStudioActivity(latest, failed, now);
}
