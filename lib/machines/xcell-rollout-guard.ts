import { readChartingRollout, ROLLOUT_UNAVAILABLE_MESSAGE, xcellRouteDecision } from "@/lib/rollouts/charting-rollout";
import { XCELL_PUR_PROFILE_ID } from "@/lib/machines/xcell-pur";
import type { MachineDb } from "@/lib/machines/machine-queries";

/** Shown when the rollout is Off for a NEW use of the xCell unit. Nothing was sent, so it says nothing was saved. */
export const XCELL_ROLLOUT_OFF_MESSAGE = "That machine is not available for new treatment setups right now. Choose another machine. Nothing was saved.";
/** A failed rollout read: retryable, and nothing was sent. */
export const ROLLOUT_UNAVAILABLE_MESSAGE_SAVE = `${ROLLOUT_UNAVAILABLE_MESSAGE} Nothing was saved.`;

export type XcellRolloutGuard = { ok: true } | { ok: false; error: string; reason: "off" | "unavailable" };

/**
 * THE SERVER-SIDE HALF OF THE ROLLOUT GATE. The picker hides the xCell unit while the rollout is Off, but a form that was opened while it
 * was On can still submit, and a crafted call can name the unit at any time. So every action that would CREATE or ASSIGN an xCell Pur
 * identity on a treatment area asks again here, at write time:
 *  - a unit that is not the xCell Pur: no rollout read, nothing changes (an outage cannot touch a studio's other machines);
 *  - a block that ALREADY stores this unit re-saving it: unaffected, whatever the rollout says (the same rule the picker uses);
 *  - otherwise `xcellRouteDecision`: On goes ahead, Off is refused, and a failed read is refused with the retryable message. It never
 *    degrades to allowing the write.
 * It runs BEFORE any write, so a refusal here has sent nothing. The
 * caller's own inventory read decides which unit this is; an unreadable inventory is refused by the caller's existing checks before this runs.
 */
export async function guardXcellRollout(
  db: MachineDb,
  where: {
    studioId: string;
    /** The unit's model, from the inventory the CALLER already read, so a save that is not for the xCell makes no extra read. */
    unitProfileId: string | null;
    deviceId: string | null;
    blockId?: string | null;
    sessionId?: string | null;
  },
): Promise<XcellRolloutGuard> {
  if (where.deviceId === null || where.unitProfileId !== XCELL_PUR_PROFILE_ID) return { ok: true };
  const existing = where.blockId && where.sessionId ? await blockStoresUnit(db, where.blockId, where.sessionId, where.deviceId) : false;
  const rollout = existing ? "on" : await readChartingRollout(where.studioId);
  const decision = xcellRouteDecision({ existingBlockUsesXcellPur: existing, rollout });
  if (decision === "offer") return { ok: true };
  if (decision === "hide") return { ok: false, error: XCELL_ROLLOUT_OFF_MESSAGE, reason: "off" };
  return { ok: false, error: ROLLOUT_UNAVAILABLE_MESSAGE_SAVE, reason: "unavailable" };
}

/** Does this block already store exactly this unit? A failed or odd read is false: the rollout then decides, and an error refuses. */
async function blockStoresUnit(db: MachineDb, blockId: string, sessionId: string, deviceId: string): Promise<boolean> {
  try {
    const blk = await db.from("session_blocks").select("studio_machine_id").eq("id", blockId).eq("session_id", sessionId).limit(1);
    if (blk.error || !Array.isArray(blk.data) || blk.data.length !== 1) return false;
    const unit = (blk.data[0] as { studio_machine_id?: unknown }).studio_machine_id;
    return typeof unit === "string" && unit.trim() === deviceId;
  } catch {
    return false;
  }
}
