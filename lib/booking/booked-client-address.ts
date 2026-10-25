import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hashAppointmentToken } from "@/lib/booking/appointment-token";
import { appointmentEmailAddress } from "@/lib/booking/studio-location";

// HON-50 (Sam, 24 Oct, decision C). The booking-success screen may show a
// studio address the owner keeps OFF the public booking page ("booked-client
// communications only") ONLY after the SERVER has verified, for this request:
//
//   1. the visitor holds the booking's own bearer token: the raw appointment
//      token whose SHA-256 is stored as appointments.cancellation_token_hash
//      (never a URL status flag, never a bare appointment id, never an HMAC
//      link rebuilt from an id);
//   2. that booking belongs to the studio whose page this is (slug match); and
//   3. the booking is CONFIRMED (a pending, cancelled or any other status gets
//      nothing; a waitlist entry is not an appointment and never reaches here).
//
// Anything else answers null and the screen falls back to the address the
// public page may already show (lib/booking/studio-location.ts). Every failure,
// including a read error, also answers null: an address is never revealed on
// doubt, and a committed booking is never failed by this lookup.
//
// The studio row is read with `*` so the lookup works before and after the
// address_visibility column exists (absent = 'both' = the page already shows
// it). It is server-only and nothing but the derived string leaves it.

export async function bookedClientAddressForToken(
  admin: Pick<SupabaseClient, "from">,
  input: { slug: string; token: string },
): Promise<string | null> {
  try {
    const token = typeof input.token === "string" ? input.token.trim() : "";
    if (token.length < 16) return null;
    const { data, error } = await admin
      .from("appointments")
      .select("id, status, studio:studios(*)")
      .eq("cancellation_token_hash", hashAppointmentToken(token))
      .maybeSingle();
    if (error || !data) return null;
    const row = data as unknown as {
      status: string | null;
      studio: { slug: string | null; address: string | null; address_visibility?: unknown } | null;
    };
    if (row.status !== "confirmed") return null;
    if (!row.studio || row.studio.slug !== input.slug) return null;
    return appointmentEmailAddress(row.studio);
  } catch {
    return null;
  }
}
