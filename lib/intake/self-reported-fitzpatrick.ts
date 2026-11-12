import type { Gated } from "@/lib/permissions/gated";
import { gatedOk, GATED_RESTRICTED } from "@/lib/permissions/gated";
import { computeFitzpatrickEstimate } from "@/lib/intake/fitzpatrick";
import { questionnaireForRow } from "@/lib/intake/questionnaire";

export type SelfReportedFitzpatrick = { type: number; score: number };

type SubmittedIntakeRow = { questionnaire_snapshot?: unknown; responses?: unknown } | null | undefined;

// The Overview Skin card's self-reported Fitzpatrick, as a GATED result (clin.view_intake).
//   restricted  the viewer may not read intake answers: nothing was read, so the card says so. It must never say "Not completed"
//               ("not read" is not "not done").
//   ok(null)    the viewer may read intake and no usable submitted intake exists: "Not completed" is a true statement here.
//   ok(value)   the estimate.
// Pre-0246 rows genuinely lack questionnaire_snapshot; only that absent-field shape uses legacy decoding. A present undefined/malformed snapshot
// refuses the derived summary, as the intake review page does.
export function selfReportedFitzpatrickFor(allowed: boolean, submitted: SubmittedIntakeRow): Gated<SelfReportedFitzpatrick | null> {
  if (!allowed) return GATED_RESTRICTED;
  if (!submitted) return gatedOk(null);
  const snapshot = Object.hasOwn(submitted, "questionnaire_snapshot") ? submitted.questionnaire_snapshot : null;
  if (questionnaireForRow(snapshot as never).kind === "invalid") return gatedOk(null);
  return gatedOk(computeFitzpatrickEstimate((submitted.responses ?? {}) as Record<string, unknown>) as SelfReportedFitzpatrick | null);
}
