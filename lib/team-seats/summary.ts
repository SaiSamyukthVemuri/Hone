import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";

// What an owner may see about their own studio's front desk entitlement (0390): whether the platform has switched it on, and the seat
// numbers. No grant reasons, no admin identity: those are for platform admins only. The command re-verifies the active owner in the
// database, so a forged studio or practitioner id gets 'not_authorized', never another studio's numbers.

export type FrontDeskSummary = {
  switchOn: boolean;
  seatLimit: number;
  seatsActive: number;
  seatsReserved: number;
  seatsAvailable: number;
  seatsOverLimit: number;
};

const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** Pure parse of the command's jsonb. Anything unexpected is null (fail closed: the caller treats it as "not available"). */
export function parseFrontDeskSummary(data: unknown): FrontDeskSummary | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.status !== "ok" || typeof d.switch_on !== "boolean") return null;
  const seatLimit = int(d.seat_limit);
  const seatsActive = int(d.seats_active);
  const seatsReserved = int(d.seats_reserved);
  const seatsAvailable = int(d.seats_available);
  const seatsOverLimit = int(d.seats_over_limit);
  if (seatLimit === null || seatsActive === null || seatsReserved === null || seatsAvailable === null || seatsOverLimit === null) return null;
  return { switchOn: d.switch_on, seatLimit, seatsActive, seatsReserved, seatsAvailable, seatsOverLimit };
}

/** Called only after the caller has been verified as the studio owner on the server. Null when it cannot be read. */
export async function readFrontDeskSummary(studioId: string, ownerPractitionerId: string): Promise<FrontDeskSummary | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("owner_front_desk_summary", {
    p_studio_id: studioId,
    p_owner_practitioner_id: ownerPractitionerId,
  });
  if (error) return null;
  return parseFrontDeskSummary(data);
}
