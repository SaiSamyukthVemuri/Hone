import { isMaterialChange, type OverInvitePreview } from "./over-invite-preview";

// The owner's confirmed over-invite batch, as pure logic over an injected send port. NO real command is called here: the port is where the
// batch command attaches once it exists. The rule this pins: a CONFIRMED batch is never blocked or reduced by the capacity estimate. Capacity is
// a warning the owner has already acknowledged, not a guard. Only real guards refuse an item: consent, duplicates, the entry's status, and
// delivery failure. Booking-conflict protection happens at booking time, not here.

/** The refusals that are real guards. Anything else a send reports is a failure to be shown and retried, never a silent skip. */
export const REAL_GUARD_CODES = ["consent_missing", "duplicate", "entry_status", "not_found"] as const;
export type RealGuardCode = (typeof REAL_GUARD_CODES)[number];
const GUARDS = new Set<string>(REAL_GUARD_CODES);

export type SendOutcome =
  | { kind: "sent" }
  | { kind: "refused"; code: string }
  | { kind: "failed"; systemic?: boolean };

export type ItemResult =
  | { entryId: string; status: "pending" }
  | { entryId: string; status: "sent" }
  | { entryId: string; status: "skipped"; code: RealGuardCode }
  | { entryId: string; status: "failed"; detail: "refused_unexpectedly" | "delivery" };

/** The confirm control exists whenever at least one recipient is chosen. Zero or exhausted capacity never disables it. */
export function canConfirmOverInvite(selectedCount: number): boolean {
  return Number.isInteger(selectedCount) && selectedCount >= 1;
}

/**
 * Before sending, compare the numbers the owner saw with fresh ones. Re-ask ONLY when they differ: a capacity that is still zero, or that fell to
 * zero, is a change only if the owner was shown a different number. Confirming again on the new numbers sends.
 */
export function recheckBeforeSend(
  shown: Pick<OverInvitePreview, "fit" | "active" | "extra">,
  fresh: Pick<OverInvitePreview, "fit" | "active" | "extra">,
): "send" | "reconfirm" {
  return isMaterialChange(shown, fresh) ? "reconfirm" : "send";
}

export const DEFAULT_CHUNK = 25;
export const DEFAULT_SPACING_MS = 500;

/**
 * Send one confirmed batch: every recipient at most once, in order, one in flight, spaced. One call handles at most `chunkSize` sends to bound its
 * duration and leaves the rest `pending` with `more: true`, so the batch is finished by further calls: the chunk never reduces the selected
 * quantity. A per-recipient failure never stops the batch. A systemic provider failure pauses it and leaves the rest pending.
 */
export async function runInviteBatch(input: {
  entryIds: readonly string[];
  send: (entryId: string) => Promise<SendOutcome>;
  sleep?: (ms: number) => Promise<void>;
  chunkSize?: number;
  spacingMs?: number;
  /**
   * Results of an earlier call for this same batch. Every TERMINAL one (sent, skipped, failed) is carried over unchanged and never attempted
   * again; only `pending` and new entries are. To retry failures, pass `previous` through `reopenFailed` first, so a retry is always explicit.
   */
  previous?: readonly ItemResult[];
}): Promise<{ results: ItemResult[]; paused: boolean; more: boolean }> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const spacing = input.spacingMs ?? DEFAULT_SPACING_MS;
  const requested = input.chunkSize ?? DEFAULT_CHUNK;
  const chunk = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : DEFAULT_CHUNK;
  const prior = new Map<string, ItemResult>();
  for (const r of input.previous ?? []) if (r.status !== "pending") prior.set(r.entryId, r);
  const seen = new Set<string>();
  const ids = input.entryIds.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  const results: ItemResult[] = [];
  let paused = false;
  let sends = 0;
  for (const entryId of ids) {
    const done = prior.get(entryId);
    if (done) {
      results.push(done);
      continue;
    }
    if (paused || sends >= chunk) {
      results.push({ entryId, status: "pending" });
      continue;
    }
    if (sends > 0) await sleep(spacing);
    sends += 1;
    let out: SendOutcome;
    try {
      out = await input.send(entryId);
    } catch {
      out = { kind: "failed" };
    }
    if (out.kind === "sent") results.push({ entryId, status: "sent" });
    else if (out.kind === "refused" && GUARDS.has(out.code)) results.push({ entryId, status: "skipped", code: out.code as RealGuardCode });
    else if (out.kind === "refused") results.push({ entryId, status: "failed", detail: "refused_unexpectedly" });
    else {
      results.push({ entryId, status: "failed", detail: "delivery" });
      if (out.systemic) paused = true;
    }
  }
  return { results, paused, more: results.some((r) => r.status === "pending") };
}

/** Turn the failed items of a previous call back into pending, so the next call retries exactly those and nothing else. */
export function reopenFailed(results: readonly ItemResult[]): ItemResult[] {
  return results.map((r) => (r.status === "failed" ? { entryId: r.entryId, status: "pending" as const } : r));
}

/**
 * Retry targets: the failed items only. A sent item is never resent, a skipped one is a guard the owner must resolve first. Items still `pending`
 * after a pause or a chunk are NOT here: the caller continues them by calling again with `previous`.
 * Per-person duplicate protection (two entries for one person), consent and the messaging limits are enforced by the server command behind the
 * send port, never by this module, and the 500 ms spacing is per call: the caller must space its own calls.
 */
export function retryTargets(results: readonly ItemResult[]): string[] {
  return results.filter((r) => r.status === "failed").map((r) => r.entryId);
}

/** Counts for the owner's view: pending, sent, failed (skipped shown separately with their reasons). */
export function summarize(results: readonly ItemResult[]) {
  const c = { pending: 0, sent: 0, skipped: 0, failed: 0 };
  for (const r of results) c[r.status] += 1;
  return c;
}
