import type { InvitationRole } from "@/lib/types/database";
import type { PlanKey } from "./plans";

export interface TeamSeats {
  plan: PlanKey;
  practitioner_limit: number;
  practitioner_used: number;
  receptionist_limit: number;
  receptionist_used: number;
}

export function hasTeamSeat(seats: TeamSeats, role: InvitationRole) {
  return role === "receptionist"
    ? seats.receptionist_used < seats.receptionist_limit
    : seats.practitioner_used < seats.practitioner_limit;
}

export function seatLimitMessage(code: string | undefined) {
  if (code === "HN001")
    return "All practitioner seats are in use. Pending invitations also reserve a seat.";
  if (code === "HN002")
    return "No receptionist seat is available on this plan. Check the team and pending invitations.";
  return null;
}
