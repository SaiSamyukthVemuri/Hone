import { requirePermission } from "@/lib/permissions/require-permission";
import { intakeReadAllowed } from "@/lib/clients/intake-read-gate";

// ONE answer to "may this viewer read intake STATUS?" for the dashboard surfaces (Today pill, missing-records assistant). The owner, a holder of
// clin.view_intake_status, or a holder of clin.view_intake may; anyone else is RESTRICTED ("Not available to your role."), which is not "no
// intake" (RO-1). The same pure rule the directory uses (intakeReadAllowed), so the two surfaces cannot disagree. The 0334 projection enforces
// the same rule in the database; this check only decides what the surface SAYS.
export async function canReadIntakeStatus(
  supabase: Parameters<typeof requirePermission>[0],
  studioId: string,
  isOwner: boolean,
): Promise<boolean> {
  if (isOwner) return intakeReadAllowed({ isOwner: true, statusAllowed: false, answersAllowed: false });
  const [status, answers] = await Promise.all([
    requirePermission(supabase, studioId, "clin.view_intake_status"),
    requirePermission(supabase, studioId, "clin.view_intake"),
  ]);
  return intakeReadAllowed({ isOwner: false, statusAllowed: status.allowed, answersAllowed: answers.allowed });
}
