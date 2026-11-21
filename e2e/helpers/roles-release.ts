import type { test as PlaywrightTest } from "@playwright/test";
import { sql } from "./seed";

// Roles keys are seeded PENDING (permission_key_release.released_at is null): a stored Off is INERT until an operator marks the key released
// after the enforcing app is live (0287, mark_permissions_released). On a fresh stack that makes every "key off, so denied" row fail for a reason
// that is not a defect, and a "no intake URL when off" row would even look like a leak. A Roles slot spec therefore checks the release state
// FIRST and reports BLOCKED (skipped, with the reason) instead of FAIL. Released rows keep their seeded kind (narrow stays narrow).
export const RELEASE_KEYS = [
  "appt.cancel", "appt.mark_no_show", "appt.edit_notes", "clin.view_records", "clin.view_photos", "clin.view_intake", "clin.view_aftercare",
  "appt.book", "appt.move", "appt.reassign", "avail.manage_own", "avail.manage_others", "avail.manage_studio_hours",
] as const;

export type KeyQuery = (text: string, params: unknown[]) => Promise<Array<{ key: string }>>;

/** The keys, in the order given, that have no RELEASED release row (a missing row is as inert as a pending one). */
export async function unreleasedKeys(query: KeyQuery, keys: readonly string[]): Promise<string[]> {
  const rows = await query("select key from public.permission_key_release where released_at is not null and key = any($1::text[])", [keys as string[]]);
  const released = new Set(rows.map((r) => r.key));
  return keys.filter((k) => !released.has(k));
}

export function releaseBlockedReason(gap: readonly string[]): string {
  return `BLOCKED, not FAIL: ${gap.length} permission key(s) are not released on this stack (${gap.join(", ")}), so a stored choice is inert and these rows prove nothing. ` +
    "Mark them released with the operator function mark_permissions_released (seeded kinds) and re-run.";
}

/** Registers a beforeEach that skips every test in the file, with the reason, while any of the keys is unreleased. */
export function blockUnlessKeysReleased(t: typeof PlaywrightTest, keys: readonly string[] = RELEASE_KEYS): void {
  t.beforeEach(async () => {
    const gap = await unreleasedKeys((text, params) => sql<{ key: string }>(text, params), keys);
    if (gap.length) console.warn(releaseBlockedReason(gap));
    t.skip(gap.length > 0, releaseBlockedReason(gap));
  });
}
