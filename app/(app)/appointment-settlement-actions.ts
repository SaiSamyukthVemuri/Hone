"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { resolveAuthoritativeSessionPaymentAmount } from "@/lib/billing/session-payment-amount";
import { todayInTz } from "@/lib/booking/tz";
import {
  isPractitionerMethod,
  isSettlementMethod,
  SETTLEMENT_RESULT_MESSAGE,
  type SettlementMethod,
  type SettlementResultCode,
} from "@/lib/billing/settlement-types";

// PAY-SETTLE — the WRITE side. Three server actions over the three 0187
// commands, and nothing else.
//
// NOTHING HERE IS THE AUTHORITY. Every rule these actions appear to enforce is
// re-enforced inside the SECURITY DEFINER command: membership, ownership,
// tenancy, appointment status, mutual exclusion with card charging, and the
// single-live-settlement law. A forged POST that skips this file entirely meets
// exactly the same refusals. What lives here is (a) deriving facts the browser
// must never supply, and (b) turning closed result codes into safe copy.
//
// NO STRIPE. These actions issue no Stripe call of any kind, and the settlement
// table has no Stripe column to write. That is the structural half of "a
// practitioner attestation can never manufacture a receipt".

const NOT_AUTHORIZED = "You are not authorized to do that.";

export type SettlementActionResult =
  | { ok: true; code: SettlementResultCode; message: string; settlementId: string | null }
  | { ok: false; code: SettlementResultCode | "unavailable"; message: string };

function failure(code: SettlementResultCode): SettlementActionResult {
  return { ok: false, code, message: SETTLEMENT_RESULT_MESSAGE[code] };
}

function readCode(rows: unknown): SettlementResultCode | null {
  const row = (Array.isArray(rows) ? rows[0] : rows) as
    | { result?: unknown }
    | null;
  const value = row?.result;
  return typeof value === "string" &&
    value in SETTLEMENT_RESULT_MESSAGE
    ? (value as SettlementResultCode)
    : null;
}

function readId(rows: unknown): string | null {
  const row = (Array.isArray(rows) ? rows[0] : rows) as
    | { settlement_id?: unknown }
    | null;
  return typeof row?.settlement_id === "string" ? row.settlement_id : null;
}

/**
 * THE PRICE SNAPSHOT, resolved server-side from the SAME resolver the card path
 * uses.
 *
 * `resolveAuthoritativeSessionPaymentAmount` is the single pure resolver behind
 * getAuthoritativeSessionPaymentAmount (the prepare action's reference price)
 * and behind the dashboard's free-visit detection. Reusing it here is what
 * stops FIN-01A drifting away from what Checkout displayed.
 *
 * It is resolved from the APPOINTMENT rather than from a session, because a
 * cash settlement must not require charting first — that coupling is the whole
 * reason the fake-payment workaround existed. The lookup mirrors
 * getFreeAppointmentIds: appointment -> service -> this client's custom pricing.
 *
 * Returns null when the price cannot be resolved. Null is stored as null: a
 * zero would be a manufactured financial fact, and this release exists to stop
 * manufacturing those.
 */
async function resolveQuotedAmountCents(
  studioId: string,
  appointmentId: string,
  studioTimezone: string,
): Promise<number | null> {
  const supabase = await createClient();
  const { data: appt, error: apptError } = await supabase
    .from("appointments")
    .select(
      "id, client_id, duration_minutes, service:services(name, price_cents)",
    )
    .eq("studio_id", studioId)
    .eq("id", appointmentId)
    .maybeSingle();
  if (apptError || !appt) return null;

  const svcEmbed = (appt as { service?: unknown }).service;
  const svc = (Array.isArray(svcEmbed) ? svcEmbed[0] : svcEmbed) as
    | { name?: string | null; price_cents?: number | null }
    | null;
  if (!svc?.name) return null;

  const clientId = (appt as { client_id: string | null }).client_id;
  const { data: pricingRows, error: pricingError } = clientId
    ? await supabase
        .from("client_pricing")
        .select("service_name, price_cents, notes, effective_from")
        .eq("studio_id", studioId)
        .eq("client_id", clientId)
    : { data: [] as never[], error: null };
  // A failed pricing read inverts prices (a positive custom price over a $0
  // menu service), so it is never treated as "no custom pricing". No snapshot
  // is better than a wrong one.
  if (pricingError) return null;

  const result = resolveAuthoritativeSessionPaymentAmount({
    service: { name: svc.name, price_cents: svc.price_cents ?? null },
    appointmentDurationMinutes:
      (appt as { duration_minutes: number | null }).duration_minutes ?? null,
    customPricing: (pricingRows ?? []) as Array<{
      service_name: string;
      price_cents: number;
      notes: string | null;
      effective_from: string;
    }>,
    today: todayInTz(studioTimezone),
  });

  if (result.kind === "resolved") return result.amountCents;
  // An authoritative $0 service is a real price, and the only one that is
  // truthfully zero.
  if (result.kind === "free") return 0;
  return null;
}

function parseAmountCents(raw: FormDataEntryValue | null): number | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,7}$/.test(text)) return null;
  const n = Number.parseInt(text, 10);
  return Number.isSafeInteger(n) && n >= 0 && n <= 200000 ? n : null;
}

function parseNote(raw: FormDataEntryValue | null): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) return null;
  return text.length <= 500 ? text : null;
}

async function refresh(): Promise<void> {
  revalidatePath("/dashboard");
  revalidatePath("/calendar", "layout");
  revalidatePath("/clients", "layout");
}

/**
 * Record an initial non-card disposition.
 *
 * Authority is the EXISTING Checkout boundary and is re-derived twice: here by
 * getCurrentPractitionerWithStudio (which redirects/throws for an
 * unauthenticated or inactive caller) and again inside the command by
 * session_actor_practitioner. `waived` is refused in both places.
 */
export async function recordAppointmentSettlementAction(
  formData: FormData,
): Promise<SettlementActionResult> {
  let studioId: string;
  let studioTimezone: string;
  try {
    const { studio } = await getCurrentPractitionerWithStudio();
    studioId = studio.id;
    studioTimezone = studio.timezone;
  } catch {
    return { ok: false, code: "unavailable", message: NOT_AUTHORIZED };
  }

  const appointmentId = String(formData.get("appointment_id") ?? "");
  const method = String(formData.get("method") ?? "");
  // The four a practitioner may record. `waived` reaching this action means a
  // hand-built POST; the command refuses it too, and returns owner_only.
  if (!appointmentId || !isPractitionerMethod(method)) {
    return failure(method === "waived" ? "owner_only" : "invalid_input");
  }

  const amountCents = parseAmountCents(formData.get("amount_cents"));
  if (amountCents === null) return failure("invalid_input");
  const note = formData.get("note") ? parseNote(formData.get("note")) : null;
  if (formData.get("note") && note === null) return failure("invalid_input");

  const quoted = await resolveQuotedAmountCents(
    studioId,
    appointmentId,
    studioTimezone,
  );

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("record_appointment_settlement", {
    p_studio_id: studioId,
    p_appointment_id: appointmentId,
    p_method: method,
    p_amount_cents: amountCents,
    p_quoted_amount_cents: quoted,
    p_note: note,
    // A DEPLOYMENT fact, from the Stripe key prefix — never from the form. The
    // command trusts it asymmetrically: livemode card money always blocks
    // whatever this says.
    p_livemode: inferStripeLivemode(),
  });
  if (error) return { ok: false, code: "unavailable", message: NOT_AUTHORIZED };

  const code = readCode(data);
  if (!code) return { ok: false, code: "unavailable", message: NOT_AUTHORIZED };
  if (code === "recorded" || code === "already_settled") {
    await refresh();
    return {
      ok: true,
      code,
      message: SETTLEMENT_RESULT_MESSAGE[code],
      settlementId: readId(data),
    };
  }
  return failure(code);
}

/**
 * Waive the fee. OWNER ONLY.
 *
 * The owner fact is derived HERE from the authenticated practitioner and from
 * nowhere else — the same F-PAY-002 discipline the prepare action follows,
 * where there is deliberately no `is_owner` form field because no code path
 * consults one. It is then re-derived independently in SQL by is_studio_owner,
 * so this check is a courtesy and the database is the authority.
 */
export async function waiveAppointmentFeeAction(
  formData: FormData,
): Promise<SettlementActionResult> {
  let studioId: string;
  let studioTimezone: string;
  let isOwner: boolean;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    studioId = studio.id;
    studioTimezone = studio.timezone;
    isOwner = practitioner.role === "owner";
  } catch {
    return { ok: false, code: "unavailable", message: NOT_AUTHORIZED };
  }
  if (!isOwner) return failure("not_owner");

  const appointmentId = String(formData.get("appointment_id") ?? "");
  if (!appointmentId) return failure("invalid_input");
  const amountCents = parseAmountCents(formData.get("amount_cents"));
  if (amountCents === null) return failure("invalid_input");
  const note = formData.get("note") ? parseNote(formData.get("note")) : null;
  if (formData.get("note") && note === null) return failure("invalid_input");

  const quoted = await resolveQuotedAmountCents(
    studioId,
    appointmentId,
    studioTimezone,
  );

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("waive_appointment_fee", {
    p_studio_id: studioId,
    p_appointment_id: appointmentId,
    p_amount_cents: amountCents,
    p_quoted_amount_cents: quoted,
    p_note: note,
    p_livemode: inferStripeLivemode(),
  });
  if (error) return { ok: false, code: "unavailable", message: NOT_AUTHORIZED };

  const code = readCode(data);
  if (!code) return { ok: false, code: "unavailable", message: NOT_AUTHORIZED };
  if (code === "recorded" || code === "already_settled") {
    await refresh();
    return {
      ok: true,
      code,
      message: SETTLEMENT_RESULT_MESSAGE[code],
      settlementId: readId(data),
    };
  }
  return failure(code);
}

/**
 * Correct a settlement by superseding it. OWNER ONLY, including over the
 * owner's own record and over a practitioner's.
 *
 * There is no "edit" and no "delete" anywhere in this file, because there is no
 * such capability in the schema: the original row keeps its method, amount,
 * actor and timestamp forever, and this inserts its replacement.
 */
export async function supersedeAppointmentSettlementAction(
  formData: FormData,
): Promise<SettlementActionResult> {
  let studioId: string;
  let studioTimezone: string;
  let isOwner: boolean;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    studioId = studio.id;
    studioTimezone = studio.timezone;
    isOwner = practitioner.role === "owner";
  } catch {
    return { ok: false, code: "unavailable", message: NOT_AUTHORIZED };
  }
  if (!isOwner) return failure("not_owner");

  const settlementId = String(formData.get("settlement_id") ?? "");
  const appointmentId = String(formData.get("appointment_id") ?? "");
  const method = String(formData.get("method") ?? "");
  if (!settlementId || !isSettlementMethod(method)) return failure("invalid_input");

  const amountCents = parseAmountCents(formData.get("amount_cents"));
  if (amountCents === null) return failure("invalid_input");
  // A CORRECTION MUST SAY WHY. Required here and by CHECK in 0187.
  const reason = parseNote(formData.get("reason"));
  if (!reason) return failure("invalid_input");
  const note = formData.get("note") ? parseNote(formData.get("note")) : null;
  if (formData.get("note") && note === null) return failure("invalid_input");

  const quoted = appointmentId
    ? await resolveQuotedAmountCents(studioId, appointmentId, studioTimezone)
    : null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("supersede_appointment_settlement", {
    p_studio_id: studioId,
    p_expected_settlement_id: settlementId,
    p_method: method as SettlementMethod,
    p_amount_cents: amountCents,
    p_quoted_amount_cents: quoted,
    p_reason: reason,
    p_note: note,
    p_livemode: inferStripeLivemode(),
  });
  if (error) return { ok: false, code: "unavailable", message: NOT_AUTHORIZED };

  const code = readCode(data);
  if (!code) return { ok: false, code: "unavailable", message: NOT_AUTHORIZED };
  if (code === "corrected") {
    await refresh();
    return {
      ok: true,
      code,
      message: SETTLEMENT_RESULT_MESSAGE[code],
      settlementId: readId(data),
    };
  }
  return failure(code);
}
