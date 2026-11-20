// Persisted progress of a confirmed batch, as pure logic over the batch item rows (state + reason class). Shown on every page load from the DATABASE,
// so reopening the page shows where the batch is, and nothing depends on a page staying open.

/** A retry click handles at most this many refused deliveries (one round). The confirm box shows min(refused, this) and the action uses the same value. */
export const RETRY_CLICK_MAX = 5;

export type ItemRow = { state: string; reason_class: string | null; issued_at?: string | null };

export type BatchProgress = {
  sent: number;
  /** Not yet processed (queued or in a round now). The background route sends these. */
  waiting: number;
  /** Issued within the lease and not yet settled: an email is being sent right now. Shown as "Sending", never as unknown. */
  sending: number;
  /** A delivery whose outcome we do not know (it may have reached the provider), or an invitation issued but not confirmed delivered. NEVER retried automatically. */
  unknown: number;
  /** The unknown outcomes the owner may retry through the separate unknown-retry action (a subset of `unknown`: settled ones only). */
  unknownRetryable: number;
  /** A delivery the provider REFUSED. Retried only by the owner's separate, confirmed action. */
  refused: number;
  /** Not sent for a reason (consent, already invited, no longer waiting...). */
  skipped: number;
  /** Not sent because the owner stopped the rest. */
  stopped: number;
  /** The invitation was released or expired before it was sent. */
  ended: number;
  /** Anything else that failed. */
  otherFailed: number;
};

/** Longer than a worst-case round (see DEFAULT_LIMITS): an issued item younger than this is still being sent. Equals the claim lease. */
export const SENDING_WINDOW_MS = 120_000;

export function tallyItems(rows: readonly ItemRow[], now: number = Date.now()): BatchProgress {
  const t: BatchProgress = { sent: 0, waiting: 0, sending: 0, unknown: 0, unknownRetryable: 0, refused: 0, skipped: 0, stopped: 0, ended: 0, otherFailed: 0 };
  for (const r of rows) {
    if (r.state === "sent") t.sent += 1;
    else if (r.state === "pending" || r.state === "claimed") t.waiting += 1;
    else if (r.state === "issued") {
      const at = r.issued_at ? new Date(r.issued_at).getTime() : NaN;
      if (Number.isFinite(at) && now - at < SENDING_WINDOW_MS) t.sending += 1;
      else t.unknown += 1; // past the lease: it becomes `unknown` at the next claim, so it is shown as such
    } else if (r.state === "unknown") {
      t.unknown += 1;
      t.unknownRetryable += 1;
    }
    else if (r.state === "skipped") {
      if (r.reason_class === "owner_stopped") t.stopped += 1;
      else if (r.reason_class === "invitation_ended") t.ended += 1;
      else t.skipped += 1;
    }
    else if (r.state === "failed") {
      if (r.reason_class === "delivery_refused") t.refused += 1;
      else if (r.reason_class === "delivery_unknown") {
        t.unknown += 1;
        t.unknownRetryable += 1;
      }
      else t.otherFailed += 1;
    }
  }
  return t;
}

export function ageLabel(iso: string, now: number): string {
  const mins = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return `${Math.floor(hrs / 24)} days ago`;
}
