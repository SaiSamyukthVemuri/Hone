// The desk's booking commands: the receptionist commands of migration 0220 (already on production)
// and the 0274 studio clock. Sam's decision (1 Nov): a receptionist books, moves and cancels within
// the studio's approved scope; nothing clinical, no photo, no legal identity, no money.
//
// What is NOT in here, by design: no table read, no price, no notes (the commands write none), no
// duration or outside-hours override (the database refuses them for a receptionist), no free-text
// cancellation reason (a closed list), no client-facing notification (see the PR: not sent from the
// desk). The actor is never named by the caller: the database derives it from the signed-in user.
//
// Fixed messages only: no id, name, time or SQL text is ever put in a message.

import type { DeskRpc } from "./read";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BookingService = { id: string; name: string; durationMinutes: number | null };
export type BookingPractitioner = { id: string; name: string; color: string | null };
export type BookingOptions = { services: BookingService[]; practitioners: BookingPractitioner[] };

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function readBookingOptions(db: DeskRpc, studioId: string): Promise<BookingOptions> {
  const res = await db.rpc("receptionist_booking_options", { p_studio_id: studioId });
  if (res.error || !Array.isArray(res.data)) throw new Error("Failed to load booking options");
  const services: BookingService[] = [];
  const practitioners: BookingPractitioner[] = [];
  for (const raw of res.data) {
    const r = raw as Record<string, unknown>;
    const id = str(r.id);
    const name = str(r.name);
    if (!id || !name) continue;
    if (r.kind === "service") {
      services.push({ id, name, durationMinutes: typeof r.duration_minutes === "number" ? r.duration_minutes : null });
    } else if (r.kind === "practitioner") {
      practitioners.push({ id, name, color: str(r.color) });
    }
  }
  return { services, practitioners };
}

export async function readStudioTimezone(db: DeskRpc, studioId: string): Promise<string> {
  const res = await db.rpc("receptionist_studio_timezone", { p_studio_id: studioId });
  if (res.error || typeof res.data !== "string" || res.data.length === 0) throw new Error("Failed to load studio clock");
  return res.data;
}

/** The closed list of cancellation reasons. The text is stored, so it is never free-form. */
export const CANCEL_REASONS = {
  client_requested: "Client asked to cancel",
  studio_cancelled: "Studio cancelled",
  no_longer_needed: "No longer needed",
  other: "Other",
} as const;
export type CancelReason = keyof typeof CANCEL_REASONS;

export function isCancelReason(v: unknown): v is CancelReason {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(CANCEL_REASONS, v);
}

export type BookingOutcome =
  | { ok: true }
  | { ok: false; message: string };

const FAILURES: Record<string, string> = {
  not_authorized: "You don't have access to do that.",
  booking_paused: "Online booking is paused for this studio, so appointments can't be changed right now.",
  invalid_client: "That client can't be booked. Search again and choose a client.",
  invalid_service: "That service isn't available. Choose another.",
  invalid_practitioner: "That practitioner isn't available. Choose another.",
  not_eligible: "That practitioner doesn't offer that service.",
  invalid_time: "That time isn't available. Choose another time.",
  invalid_duration: "That service has no usable length. Ask the studio owner.",
  studio_not_found: "Something went wrong. Try again.",
  appointment_not_found: "That appointment no longer exists. Refresh the schedule.",
  appointment_not_movable: "That appointment can't be moved.",
  stale_appointment: "That appointment changed while you were looking. Refresh the schedule and try again.",
  no_change: "Choose a different time or practitioner to move it.",
  not_cancelable: "That appointment can't be cancelled.",
  already_cancelled: "That appointment is already cancelled.",
  slot_taken: "That time was just taken. Choose another time.",
};

export const UNKNOWN_FAILURE = "That didn't go through. Try again.";

function failure(code: string | null): BookingOutcome {
  return { ok: false, message: (code && FAILURES[code]) || UNKNOWN_FAILURE };
}

/** An exclusion-constraint violation is the database's own "that slot is taken" answer. */
function errorOutcome(error: unknown): BookingOutcome {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return failure(code === "23P01" ? "slot_taken" : null);
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const r = data[0];
  return typeof r === "object" && r !== null ? (r as Record<string, unknown>) : null;
}

export async function createDeskBooking(
  db: DeskRpc,
  studioId: string,
  input: { practitionerId: string; clientId: string; serviceId: string; startsAtIso: string },
): Promise<BookingOutcome> {
  const res = await db.rpc("receptionist_create_appointment", {
    p_studio_id: studioId,
    p_target_practitioner_id: input.practitionerId,
    p_client_id: input.clientId,
    p_service_id: input.serviceId,
    p_starts_at: input.startsAtIso,
  });
  if (res.error) return errorOutcome(res.error);
  const row = firstRow(res.data);
  const result = row ? str(row.result) : null;
  return result === "created" ? { ok: true } : failure(result);
}

export async function moveDeskBooking(
  db: DeskRpc,
  studioId: string,
  input: {
    appointmentId: string;
    practitionerId: string;
    expectedStartsAtIso: string;
    expectedEndsAtIso: string;
    newStartsAtIso: string;
  },
): Promise<BookingOutcome> {
  const res = await db.rpc("receptionist_move_appointment", {
    p_studio_id: studioId,
    p_appointment_id: input.appointmentId,
    p_target_practitioner_id: input.practitionerId,
    p_expected_starts_at: input.expectedStartsAtIso,
    p_expected_ends_at: input.expectedEndsAtIso,
    p_new_starts_at: input.newStartsAtIso,
  });
  if (res.error) return errorOutcome(res.error);
  const row = firstRow(res.data);
  const result = row ? str(row.result) : null;
  return result === "moved" || result === "reassigned" || result === "moved_and_reassigned"
    ? { ok: true }
    : failure(result);
}

export async function cancelDeskBooking(
  db: DeskRpc,
  studioId: string,
  input: { appointmentId: string; reason: CancelReason },
): Promise<BookingOutcome> {
  const res = await db.rpc("receptionist_cancel_appointment", {
    p_studio_id: studioId,
    p_appointment_id: input.appointmentId,
    p_reason: CANCEL_REASONS[input.reason],
  });
  if (res.error) return errorOutcome(res.error);
  return res.data === "cancelled" ? { ok: true } : failure(typeof res.data === "string" ? res.data : null);
}
