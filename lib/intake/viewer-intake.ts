import { getLatestIntakeForClient } from "@/lib/intake/queries";
import { readIntakeStatusProjection, type IntakeStatusRpc } from "@/lib/intake/status-projection";
import { GATED_RESTRICTED, gatedOk, type Gated } from "@/lib/permissions/gated";
import type { ClientIntakeForm } from "@/lib/types/database";

// ONE reader of "the intake of THIS client" for the two practitioner pages that show it (client profile, appointment briefing). After 0334 the table
// itself needs clin.view_intake, so a viewer who holds only clin.view_intake_status reads through the status projection and gets the status and the
// form-created date, never the answers or the link metadata. A viewer with neither key is RESTRICTED, which is not "no intake" (RO-1).
//
//   detail  holds clin.view_intake: the row from the table (`null` is a real "no intake on file")
//   status  holds clin.view_intake_status only: { status, createdAt } from the projection (`null` = the projection found none)
export type IntakeSummary = { status: ClientIntakeForm["status"]; createdAt: string };
export type ViewerIntake =
  | { mode: "detail"; intake: ClientIntakeForm | null }
  | { mode: "status"; summary: IntakeSummary | null };

export async function loadIntakeForViewer(
  db: IntakeStatusRpc,
  studioId: string,
  clientId: string,
  access: { canViewIntake: boolean; canViewStatus: boolean },
): Promise<Gated<ViewerIntake>> {
  if (access.canViewIntake) return gatedOk({ mode: "detail", intake: await getLatestIntakeForClient(studioId, clientId) });
  if (!access.canViewStatus) return GATED_RESTRICTED;
  const rows = await readIntakeStatusProjection(db, studioId, [clientId]);
  if (rows === null) throw new Error("Failed to load intake status");
  const row = rows[0];
  return gatedOk({ mode: "status", summary: row ? { status: row.status as IntakeSummary["status"], createdAt: row.created_at } : null });
}
