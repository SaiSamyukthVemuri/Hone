import "server-only";
import type { ClaimedJob } from "./job-result";
import type { AppointmentState, LinkRow } from "./link-transition-store";

// Google Calendar — Phase B2.3-c1: the execution-time stale fence (Decision G).
//
// A PURE decision over a read snapshot (job + current appointment + current
// active link) taken immediately before any Google call. It yields either a
// no-op/conflict result (ZERO Google calls) or a proceed-mode. It runs AFTER the
// handler's connection/scope/intent eligibility gate, so it does not re-check
// those here.
//
// COMPLETION PROOF (§6): a create/update is "already applied" ONLY when the link
// has a confirmed google_event_id AND last_hone_version >= the job version. A
// placeholder (google_event_id null, last_hone_version 0) NEVER satisfies
// completion proof by merely existing — it always resolves to create-and-bind.

export type FenceDecision =
  | { kind: "noop"; code: "ok_noop_superseded" | "ok_noop_no_active_link" | "ok_noop_tombstone_deleted" }
  | { kind: "conflict" }
  | { kind: "proceed"; mode: "create" | "update" | "delete" };

export function jobSyncVersion(job: ClaimedJob): number {
  const v = job.payload?.["sync_version"];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function evaluateStaleFence(input: {
  job: ClaimedJob;
  appointment: AppointmentState | null;
  link: LinkRow | null;
}): FenceDecision {
  const { job, appointment, link } = input;
  const jobVersion = jobSyncVersion(job);

  // Ownership sanity: a link that belongs to a different studio/entity is a
  // conflict (never bind/mutate it).
  if (
    link &&
    (link.studioId !== job.studioId ||
      link.honeEntityId !== job.honeEntityId ||
      link.honeEntityType !== job.honeEntityType)
  ) {
    return { kind: "conflict" };
  }

  if (job.opType === "event.delete") {
    if (!link) return { kind: "noop", code: "ok_noop_no_active_link" };
    // A newer op brought the appointment back to confirmed (un-cancel / reschedule
    // rebind) — the stale delete must not fire.
    if (appointment && appointment.status === "confirmed" && appointment.syncVersion > jobVersion) {
      return { kind: "noop", code: "ok_noop_superseded" };
    }
    return { kind: "proceed", mode: "delete" };
  }

  // create / update (create-and-bind for a placeholder).
  if (!appointment) return { kind: "noop", code: "ok_noop_superseded" }; // entity gone
  if (appointment.status !== "confirmed") return { kind: "noop", code: "ok_noop_superseded" };
  if (jobVersion < appointment.syncVersion) return { kind: "noop", code: "ok_noop_superseded" };
  if (!link) return { kind: "noop", code: "ok_noop_no_active_link" };

  // Already applied? (crash-recovery: link bound at >= this version but the outbox
  // result was never recorded). Requires a CONFIRMED provider id — a placeholder
  // never proves completion.
  if (link.googleEventId !== null && link.lastHoneVersion >= jobVersion) {
    return { kind: "noop", code: "ok_noop_superseded" };
  }
  if (link.googleEventId === null) return { kind: "proceed", mode: "create" };
  return { kind: "proceed", mode: "update" };
}
