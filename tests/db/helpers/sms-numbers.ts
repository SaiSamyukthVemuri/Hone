// Claimed-number allocation for tests/db/studio-sms-sender.db.test.ts.
//
// 0226 reserves a claimed number atomically across every live sender row, and
// the claim command's insert is `on conflict do nothing`. A second studio that
// asks for a number a live row already holds therefore does NOT raise: it gets
// `not_claimable` with a null claim key. The file derived each studio's number
// from a 32-bit hash folded into 7000 slots, so two of its random studios could
// land on the same slot and the later claim silently failed. A test then
// asserted on the null key (`renew_studio_sms_lease(..., null, ...)` is false)
// and read as a broken lease, in production push run 40716437947. The chance
// per run is small and was never zero.

/** The hash the file used. Kept only so the collision it permits stays provable. */
export function hashedNumberFor(studioId: string, slot: "A" | "B"): string {
  let h = 0x811c9dc5;
  for (const ch of `${studioId}:${slot}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return `+1416556${String(2000 + (h % 7000)).padStart(4, "0")}`;
}

const SLOTS = 7000;

/**
 * One number per (studio, slot), never repeated within an allocator. The start
 * is random so two worktrees sharing a database still begin in different
 * places (the file is documented as safe to re-run against a shared database),
 * and the walk is sequential so this process cannot collide with itself.
 */
export function makeNumberAllocator(start: number = Math.floor(Math.random() * SLOTS)) {
  const issued = new Map<string, string>();
  return (studioId: string, slot: "A" | "B"): string => {
    const key = `${studioId}:${slot}`;
    const existing = issued.get(key);
    if (existing) return existing;
    if (issued.size >= SLOTS) throw new Error("sms number allocator exhausted");
    const n = `+1416556${String(2000 + ((start + issued.size) % SLOTS)).padStart(4, "0")}`;
    issued.set(key, n);
    return n;
  };
}
