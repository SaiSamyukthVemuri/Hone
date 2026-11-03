import { requirePermission, type PermissionContext, type PermissionDb } from "./require-permission";

// comm.send_routine (R5): appointment, receipt and booking-link messages a staff member's action causes. A message is a SIDE EFFECT of an
// action that already passed its own key (book, cancel, move), so a denial WITHHOLDS the message and never fails the committed action.
// On the existing-snapshot basis every active practitioner holds the key studio-wide, so nothing changes until an owner narrows it.
// The log carries ids and the key only: no recipient, no message content.
export async function routineMessageAllowed(db: PermissionDb, studioId: string, ctx: PermissionContext = {}): Promise<boolean> {
  const decision = await requirePermission(db, studioId, "comm.send_routine", ctx);
  if (!decision.allowed) {
    console.warn(
      JSON.stringify({
        event: "routine_message_withheld_by_permission",
        key: "comm.send_routine",
        appointmentId: ctx.appointment ?? null,
        timestamp: new Date().toISOString(),
      }),
    );
  }
  return decision.allowed;
}
