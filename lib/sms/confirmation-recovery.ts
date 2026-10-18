import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client, Studio } from "@/lib/types/database";
import { classifyNanpNumber } from "./nanp";
import { listedRoutingStudioIds, type SendTimeRouteReader } from "./send-time-route";
import { normalizePhoneForSms } from "./twilio";
import { stampIntakeLinkIssued } from "@/lib/intake/queries";
import { sendRecoveredConfirmationSmsToClient, type SmsSendResult } from "./send-appointment";

// ===========================================================================
// D5 (WILLOW-ROUTING-CANDIDATE-01, #824): an OWED booking confirmation.
// ===========================================================================
//
// THE GAP. A confirmation is one-shot: booking, calendar, reschedule and
// portal rebook each call sendBookingConfirmationSmsToClient ONCE for their
// new appointment row and discard the result, and nothing rescans. For a
// studio routed through its own sender, a confirmation refused because that
// sender was not ready yet (claimed nothing, spent no attempt) was never sent.
//
// THE RULE. A confirmation is OWED while all of these hold:
//   * its studio is listed for routing (platform-routed studios keep today's
//     behaviour exactly; nothing here reads or sends for them);
//   * the appointment is `confirmed`;
//   * NO provider attempt was ever made: sent_at null, attempts 0, no claim.
//     Any attempt -- sent, failed, or possibly sent -- ends recovery for good;
//   * it was booked within RECOVERY_MAX_AGE_MS, and at least
//     RECOVERY_GRACE_MS ago (the booking request's own send has finished);
//   * it starts more than RECOVERY_MIN_LEAD_MS from now, i.e. after the 2h
//     reminder's window, so a late confirmation never lands on top of it.
// An owed confirmation is delivered on the first run where EVERY send-time
// gate passes again: the studio's switch, the client's consent and STOP (read
// fresh), the fence, and the studio's sender and destination readiness. A
// refusal leaves it owed until it expires.
//
// DUPLICATES. claim_sms_send (0049) admits one claim at a time and never after
// sent_at; recovery only takes attempts = 0; and the appointment is re-read
// BEFORE the claim (a refusal or an unreadable row spends nothing, so it stays
// owed) and AFTER it (still confirmed, still beyond the horizon) before the
// provider is called. A reschedule creates a new row, so the old one is no
// longer `confirmed` and is never confirmed late. Residual: if the post-claim
// re-read fails on every look, the claim is released with its attempt spent
// and that confirmation is no longer owed. Closing that needs an atomic
// validate-and-claim command (0206's pattern), i.e. a migration.
//
// FAIRNESS. Each listed studio is paged separately (keyset on the unique
// (created_at, id), RECOVERY_PAGE_SIZE rows per page) through its WHOLE
// 24-hour window: there is no page ceiling, so no owed row sits beyond reach.
// What bounds a run is the window itself, RECOVERY_MAX_PROVIDER_ATTEMPTS_PER_RUN
// and RECOVERY_RUN_TIME_BUDGET_MS. A refusing row costs no read beyond its
// page: gate refusals are local, and route refusals are remembered for the
// run per studio (studio-wide) or per studio and destination country. A route
// is looked at once per row, the next run being the retry.
//
// FRESHNESS. An APPROVAL is never reused: every recovered send reads the
// sender snapshot afresh, immediately before its claim, so a sender
// suspended, released or replaced mid-run is seen. Only a STUDIO-WIDE refusal
// (unreadable, no or ambiguous sender, wrong studio, no identity) is
// remembered for the rest of the run, and only to skip that studio's other
// rows; destination refusals depend on the recipient and are not. The
// client's STOP, consent and phone are re-read with the appointment, before
// AND after the claim, so a STOP that lands mid-run is honoured, as are the
// studio's confirmation switch and the 24-hour maximum age (against the
// current time).
//
// DIRECTION. Each studio is scanned oldest-first in even 15-minute slots and
// newest-first in odd ones, so a run cut off by its time budget does not keep
// starving the same rows. Residual: rows in the middle of a window that two
// consecutive runs both fail to reach within their budgets wait for a later
// run. A persisted per-studio cursor would close it, and needs a store this
// candidate does not add.
//
// STUDIOS SHARE A RUN. Each listed studio first gets an equal share of the
// provider-attempt cap; attempts a quiet studio leaves unused are then split
// among the studios stopped at their share, each resuming from its keyset
// cursor, until the cap is spent or no studio has work left. The studio a
// run starts with rotates every
// 15-minute slot, so one studio's backlog never holds another's confirmations
// until they expire. When every listed studio fits in one run the start moves
// by one studio per slot. When more studios have backlogs than the cap can
// serve (perStudio is then 1, so at most 50 per run), the start moves by the
// run's capacity instead (Codex P2 4250550574): consecutive runs serve
// abutting windows, so every studio is reached within ceil(studios / 50)
// slots, inside the 24h recovery age for up to 4,800 studios. Residual: a run
// cut short by its time budget leaves the rest of its window to the next
// full rotation.
//
// THE INTAKE LINK. As the booking confirmation does, a recovered one carries
// the client's intake link when their latest intake for the studio is still
// in progress: read live at the pre-claim check (no intake is ever created
// here), minted fresh, and stamped as issued once the message is sent. A read
// error means no link, never a blocked confirmation.
//
// BOUNDS. At most RECOVERY_MAX_PROVIDER_ATTEMPTS_PER_RUN provider requests per
// run, counting failures as well as sends, so a provider outage cannot turn
// one run into a burst. The horizon is re-checked against the CURRENT time at
// each re-read, so a slow run never confirms an appointment that has since
// entered the 2h reminder window.
//
// ACTIVATION. Off unless SMS_CONFIRMATION_RECOVERY=on AND the studio is
// listed in SMS_STUDIO_ROUTING_STUDIO_IDS. Both are unset everywhere, and the
// route that runs this (app/api/cron/sms-confirmation-recovery) is on no
// scheduler. Disabled, it reads nothing.
// ===========================================================================

export const CONFIRMATION_RECOVERY_ENV = "SMS_CONFIRMATION_RECOVERY";
export const RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const RECOVERY_GRACE_MS = 5 * 60 * 1000;
/** The 2h reminder window ends 2h15m out (lib/cron/reminder-schedule). */
export const RECOVERY_MIN_LEAD_MS = (2 * 60 + 15) * 60 * 1000;
export const RECOVERY_PAGE_SIZE = 50;
/** The scheduler's cadence; the first studio of a run rotates per slot. */
export const RECOVERY_SLOT_MS = 15 * 60 * 1000;
/** Wall time one run may spend; the scheduler fires every 15 minutes. */
export const RECOVERY_RUN_TIME_BUDGET_MS = 4 * 60 * 1000;
/** Provider requests per run: sends AND failed or possibly-sent attempts. */
export const RECOVERY_MAX_PROVIDER_ATTEMPTS_PER_RUN = 50;
/** Post-claim re-read looks on a read failure, before releasing the claim. */
export const RECOVERY_POST_CLAIM_LOOKS = 3;

type Env = Readonly<Record<string, string | undefined>>;

export function confirmationRecoveryEnabled(env: Env = process.env): boolean {
  return env[CONFIRMATION_RECOVERY_ENV] === "on";
}

export type OwedConfirmationRow = {
  id: string;
  studio_id: string;
  client_id: string;
  status: string;
  starts_at: string;
  created_at: string;
  sms_confirmation_sent_at: string | null;
  sms_confirmation_send_attempts: number;
  sms_confirmation_claimed_at: string | null;
  studio: Pick<
    Studio,
    "id" | "name" | "timezone" | "send_confirmation_sms" | "send_24h_sms_reminders" | "send_2h_sms_reminders"
  > | null;
  client: Pick<Client, "phone" | "sms_consent_at" | "sms_opted_out_at"> | null;
};

export function owedWindow(nowMs: number) {
  return {
    createdAfterIso: new Date(nowMs - RECOVERY_MAX_AGE_MS).toISOString(),
    createdBeforeIso: new Date(nowMs - RECOVERY_GRACE_MS).toISOString(),
    startsAfterIso: new Date(nowMs + RECOVERY_MIN_LEAD_MS).toISOString(),
  };
}

/** The rule above, applied to one row. The query asks the same; this re-checks. */
export function isOwedConfirmation(row: OwedConfirmationRow, nowMs: number, studioIds: readonly string[]): boolean {
  const created = Date.parse(row.created_at);
  const starts = Date.parse(row.starts_at);
  return (
    studioIds.includes(row.studio_id) &&
    row.studio?.id === row.studio_id &&
    row.status === "confirmed" &&
    row.sms_confirmation_sent_at === null &&
    row.sms_confirmation_send_attempts === 0 &&
    row.sms_confirmation_claimed_at === null &&
    Number.isFinite(created) &&
    Number.isFinite(starts) &&
    created >= nowMs - RECOVERY_MAX_AGE_MS &&
    created <= nowMs - RECOVERY_GRACE_MS &&
    starts > nowMs + RECOVERY_MIN_LEAD_MS
  );
}

/** Route refusals that hold for every row of the studio, whoever the recipient. */
const STUDIO_WIDE_REFUSALS: ReadonlySet<string> = new Set([
  "sms_route_sender_read_failed",
  "sms_route_no_active_sender",
  "sms_route_ambiguous_active_sender",
  "sms_route_sender_wrong_studio",
  "sms_route_sender_identity_missing",
]);

/**
 * The client's intake link, if their latest intake for this studio is still in
 * progress. Studio and client scoped; reads id and status only. Creates
 * nothing. Any failure is "no link".
 */
async function readIntakeLink(
  admin: SupabaseClient,
  studioId: string,
  clientId: string,
  intakeUrlFor: ((intakeId: string) => string | null) | undefined,
): Promise<{ id: string; url: string } | null> {
  if (!intakeUrlFor) return null;
  try {
    const { data, error } = await admin
      .from("client_intake_forms")
      .select("id, status")
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = data as { id: string; status: string } | null;
    if (error || !row || row.status !== "in_progress") return null;
    const url = intakeUrlFor(row.id);
    return url ? { id: row.id, url } : null;
  } catch {
    return null;
  }
}

/** The studio and recipient country a destination refusal applies to. */
function destinationKey(studioId: string, phone: string | null): string | null {
  const n = classifyNanpNumber(normalizePhoneForSms(phone ?? null));
  return n.ok ? `${studioId}:${n.country}` : null;
}

export type RecoveryRun =
  | { ran: false; reason: "disabled" | "no_routed_studios" }
  | { ran: false; reason: "read_failed" }
  | { ran: true; considered: number; sent: number; failed: number; skipped: Record<string, number> };

/** One recovery pass. Never throws. */
export async function recoverOwedConfirmations(opts: {
  admin: SupabaseClient;
  nowMs: number;
  manageUrlFor: (appointmentId: string, startsAt: Date) => string | null;
  env?: Env;
  routeReader?: SendTimeRouteReader;
  /** Mints an intake link for an in-progress intake; absent, no link. */
  intakeUrlFor?: (intakeId: string) => string | null;
  pageSize?: number;
  /** The current time at each re-read; defaults to the wall clock. */
  clock?: () => number;
}): Promise<RecoveryRun> {
  const clock = opts.clock ?? Date.now;
  const env = opts.env ?? process.env;
  if (!confirmationRecoveryEnabled(env)) return { ran: false, reason: "disabled" };
  const studioIds = listedRoutingStudioIds(env);
  if (studioIds.length === 0) return { ran: false, reason: "no_routed_studios" };

  // Refusals seen this run, studio-wide or per destination country;
  // approvals are never remembered.
  const studioRefusal = new Map<string, string>();
  const destinationRefusal = new Map<string, string>();
  const startedAt = clock();
  const outOfTime = () => clock() - startedAt >= RECOVERY_RUN_TIME_BUDGET_MS;

  const w = owedWindow(opts.nowMs);
  const pageSize = opts.pageSize ?? RECOVERY_PAGE_SIZE;
  const run = { ran: true as const, considered: 0, sent: 0, failed: 0, skipped: {} as Record<string, number> };
  const skip = (reason: string) => {
    run.skipped[reason] = (run.skipped[reason] ?? 0) + 1;
  };
  let anyRead = false;
  const attempted = () => run.sent + run.failed;
  // An equal share per studio, and a rotating first studio.
  const perStudio = Math.max(1, Math.floor(RECOVERY_MAX_PROVIDER_ATTEMPTS_PER_RUN / studioIds.length));
  const slot = Math.floor(opts.nowMs / RECOVERY_SLOT_MS);
  const capacity = Math.floor(RECOVERY_MAX_PROVIDER_ATTEMPTS_PER_RUN / perStudio);
  const stride = capacity >= studioIds.length ? 1 : capacity;
  const first = (slot * stride) % studioIds.length;
  const newestFirst = slot % 2 === 1;
  const ordered = [...studioIds.slice(first), ...studioIds.slice(0, first)];

  // The first pass gives every studio its fair share. A studio stopped at its
  // share with rows still to consider is queued, and each later pass splits
  // the run's UNUSED attempts among the queued studios, resuming each where it
  // stopped (Codex P2 4264089023): a quiet studio's share is never wasted while
  // another studio's confirmations wait.
  type Cursor = { createdAt: string; id: string };
  let visits: Array<{ studioId: string; after: Cursor | null }> = ordered.map((studioId) => ({ studioId, after: null }));
  let share = perStudio;
  passes: while (visits.length > 0) {
    const cutOff: typeof visits = [];
    const atPass = attempted();
    studios: for (const visit of visits) {
      const studioId = visit.studioId;
      const atStart = attempted();
      let after = visit.after;
      let lastSeen = visit.after;
      for (;;) {
        if (attempted() >= RECOVERY_MAX_PROVIDER_ATTEMPTS_PER_RUN || outOfTime()) break passes;
        const rows = await readOwedPage(opts.admin, studioId, w, after, pageSize, newestFirst);
        if (rows === null) {
          skip("read_failed");
          continue studios;
        }
        anyRead = true;
        for (const row of rows) {
          if (attempted() >= RECOVERY_MAX_PROVIDER_ATTEMPTS_PER_RUN || outOfTime()) break passes;
          if (attempted() - atStart >= share) {
            cutOff.push({ studioId, after: lastSeen });
            continue studios;
          }
          lastSeen = { createdAt: row.created_at, id: row.id };
          run.considered += 1;
          if (!isOwedConfirmation(row, opts.nowMs, studioIds) || !row.studio || !row.client) {
            skip("not_owed");
            continue;
          }
          const destKey = destinationKey(studioId, row.client.phone);
          const refused = studioRefusal.get(studioId) ?? (destKey ? destinationRefusal.get(destKey) : undefined);
          if (refused) {
            skip(refused);
            continue;
          }
          const listedPhone = row.client.phone;
          let intake: { id: string; url: string } | null = null;
          let intakeRead = false;
          let result: SmsSendResult;
          try {
            result = await sendRecoveredConfirmationSmsToClient({
              admin: opts.admin,
              appointmentId: row.id,
              timezone: row.studio.timezone,
              studio: row.studio,
              client: row.client,
              routeReader: opts.routeReader,
              manageUrlFor: (startsAt) => opts.manageUrlFor(row.id, startsAt),
              revalidate: async (phase) => {
                const check = await revalidateOwed(opts.admin, row.id, clock(), listedPhone, phase);
                // A confirmation goes WITH its manage link or not at all: refused
                // before the claim, so nothing is spent and it stays owed.
                if (check.ok && !opts.manageUrlFor(row.id, check.startsAt)) {
                  return { ok: false as const, reason: "recovery_manage_link_unavailable" };
                }
                // Read once, at the pre-claim check, only for a row about to send.
                if (check.ok && !intakeRead) {
                  intakeRead = true;
                  intake = await readIntakeLink(opts.admin, row.studio_id, row.client_id, opts.intakeUrlFor);
                }
                return check;
              },
              intakeUrlFor: () => intake?.url ?? null,
            });
          } catch {
            result = { ok: false, error: "recovery_threw", retryable: false };
          }
          // The message may be in the client's hands when it was sent OR when
          // the provider's answer was lost (Codex P2 4305038680, 4305026103):
          // either way the intake link it carried counts as issued, exactly as
          // the reminder path accounts for it. The claim already spent the
          // attempt, so recovery never revisits this row to repair it later.
          const mayHaveReachedClient = result.ok || (!result.skipped && result.possiblySent === true);
          if (mayHaveReachedClient) {
            const issued = intake as { id: string; url: string } | null;
            if (issued) {
              try {
                await stampIntakeLinkIssued(opts.admin, issued.id, { emailed: false });
              } catch {
                // Display metadata only; never fails the run.
              }
            }
          }
          if (result.ok) {
            run.sent += 1;
          }
          else if (result.skipped) {
            skip(result.reason);
            if (STUDIO_WIDE_REFUSALS.has(result.reason)) studioRefusal.set(studioId, result.reason);
            else if (result.reason === "sms_route_destination_not_ready" && destKey) {
              destinationRefusal.set(destKey, result.reason);
            }
          } else run.failed += 1;
        }
        if (rows.length < pageSize) continue studios;
        const last = rows[rows.length - 1];
        after = { createdAt: last.created_at, id: last.id };
      }
    }
    const unused = RECOVERY_MAX_PROVIDER_ATTEMPTS_PER_RUN - attempted();
    if (cutOff.length === 0 || unused <= 0 || attempted() === atPass) break;
    visits = cutOff;
    share = Math.max(1, Math.floor(unused / cutOff.length));
  }
  if (!anyRead) return { ran: false, reason: "read_failed" };
  return run;
}

/** One keyset page of one studio's owed rows, oldest first; null when unreadable. */
async function readOwedPage(
  admin: SupabaseClient,
  studioId: string,
  w: ReturnType<typeof owedWindow>,
  after: { createdAt: string; id: string } | null,
  pageSize: number,
  newestFirst: boolean,
): Promise<OwedConfirmationRow[] | null> {
  try {
    let q = admin
      .from("appointments")
      .select(
        "id, studio_id, client_id, status, starts_at, created_at, sms_confirmation_sent_at, sms_confirmation_send_attempts, sms_confirmation_claimed_at, studio:studios(id, name, timezone, send_confirmation_sms, send_24h_sms_reminders, send_2h_sms_reminders), client:clients(phone, sms_consent_at, sms_opted_out_at)",
      )
      .eq("studio_id", studioId)
      .eq("status", "confirmed")
      .is("sms_confirmation_sent_at", null)
      .eq("sms_confirmation_send_attempts", 0)
      .is("sms_confirmation_claimed_at", null)
      .gte("created_at", w.createdAfterIso)
      .lte("created_at", w.createdBeforeIso)
      .gt("starts_at", w.startsAfterIso);
    // Strictly after the last row of the previous page on the UNIQUE key, so
    // rows sharing a created_at are never skipped.
    if (after) {
      // Values are double-quoted: a timestamp holds PostgREST's reserved ':'.
      const op = newestFirst ? "lt" : "gt";
      q = q.or(
        `created_at.${op}."${after.createdAt}",and(created_at.eq."${after.createdAt}",id.${op}."${after.id}")`,
      );
    }
    const { data, error } = await q
      .order("created_at", { ascending: !newestFirst })
      .order("id", { ascending: !newestFirst })
      .limit(pageSize);
    if (error || !Array.isArray(data)) return null;
    const one = <T>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
    return data.map((r) => {
      const row = r as unknown as OwedConfirmationRow;
      return { ...row, studio: one(row.studio as never), client: one(row.client as never) };
    });
  } catch {
    return null;
  }
}

type RevalidatedRow = {
  status: string;
  sms_confirmation_send_attempts: number | null;
  starts_at: string;
  created_at: string;
  studio: { send_confirmation_sms: boolean } | Array<{ send_confirmation_sms: boolean }> | null;
  client: Pick<Client, "phone" | "sms_consent_at" | "sms_opted_out_at"> | Array<Pick<Client, "phone" | "sms_consent_at" | "sms_opted_out_at">> | null;
};

/**
 * Before and after the claim: still confirmed, still starting beyond the
 * horizon, and the client still consenting, not opted out (STOP is stamped
 * on every row holding the number), and still on the number the gate used.
 */
async function revalidateOwed(
  admin: SupabaseClient,
  appointmentId: string,
  nowMs: number,
  listedPhone: string | null,
  phase: "before_claim" | "after_claim",
): Promise<{ ok: true; startsAt: Date } | { ok: false; reason: string }> {
  // An unreadable answer is looked at again; only a READ verdict refuses.
  let row: RevalidatedRow | null = null;
  for (let look = 0; look < RECOVERY_POST_CLAIM_LOOKS && !row; look += 1) {
    try {
      const { data, error } = await admin
        .from("appointments")
        .select(
          "status, starts_at, created_at, sms_confirmation_send_attempts, studio:studios(send_confirmation_sms), client:clients(phone, sms_consent_at, sms_opted_out_at)",
        )
        .eq("id", appointmentId)
        .maybeSingle();
      if (!error && data) row = data as RevalidatedRow;
    } catch {
      // looked at again below
    }
  }
  if (!row) return { ok: false, reason: "recovery_revalidate_failed" };
  const client = Array.isArray(row.client) ? (row.client[0] ?? null) : row.client;
  const studio = Array.isArray(row.studio) ? (row.studio[0] ?? null) : row.studio;
  if (!client || !studio) return { ok: false, reason: "recovery_revalidate_failed" };
  if (studio.send_confirmation_sms !== true) return { ok: false, reason: "studio_toggle_off" };
  // RECOVERY SENDS ONLY A ROW THAT HAS NEVER REACHED THE PROVIDER (Codex P2
  // 4305212716). claim_sms_send accepts any confirmation under three attempts,
  // so two runs that selected the same zero-attempt row could each claim it in
  // turn: the first makes an ambiguous attempt and clears its claim, the second
  // claims the now-one-attempt row and sends a duplicate. The claim increments
  // the count atomically and holds an exclusive lease, so the count read right
  // after it is exactly this claim's: 1 proves no earlier attempt; anything
  // else refuses before the provider (the claim is released, nothing sent).
  const attempts = row.sms_confirmation_send_attempts;
  const expectedAttempts = phase === "before_claim" ? 0 : 1;
  if (attempts !== expectedAttempts) return { ok: false, reason: "recovery_attempt_already_made" };
  const created = Date.parse(row.created_at);
  if (!Number.isFinite(created) || created < nowMs - RECOVERY_MAX_AGE_MS) {
    return { ok: false, reason: "recovery_expired" };
  }
  if (client.sms_opted_out_at) return { ok: false, reason: "client_opted_out" };
  if (!client.sms_consent_at) return { ok: false, reason: "client_no_consent" };
  if (client.phone !== listedPhone) return { ok: false, reason: "recovery_client_phone_changed" };
  if (row.status !== "confirmed") return { ok: false, reason: "recovery_not_confirmed" };
  const startsAt = new Date(row.starts_at);
  if (!Number.isFinite(startsAt.getTime()) || startsAt.getTime() <= nowMs + RECOVERY_MIN_LEAD_MS) {
    return { ok: false, reason: "recovery_too_late" };
  }
  return { ok: true, startsAt };
}
