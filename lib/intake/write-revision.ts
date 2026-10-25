import type { SupabaseClient } from "@supabase/supabase-js";
import { intakeRevision, INTAKE_CONFLICT, INTAKE_TERMINAL } from "./revision";

export type IntakeWriteResult =
  | { ok: true; revision: string; outcome: "saved" | "submitted" }
  | { ok: false; code: "conflict" | "terminal" | "unavailable"; error: string };

export async function writeIntakeRevision(
  admin: Pick<SupabaseClient, "rpc">,
  input: {
    intakeId: string; studioId: string; clientId: string;
    expectedRevision: string; responses: Record<string, unknown>; step: number;
    operation: "save" | "submit" | "handoff";
    profile?: Record<string, string | null>;
  },
): Promise<IntakeWriteResult> {
  const unavailable: IntakeWriteResult = {
    ok: false, code: "unavailable", error: "We couldn't save your intake. Your changes have not been submitted. Please try again.",
  };
  if (intakeRevision(input.expectedRevision) !== input.expectedRevision) return unavailable;
  try {
    const { data, error } = await admin.rpc("write_intake_revision", {
      p_intake_id: input.intakeId, p_studio_id: input.studioId, p_client_id: input.clientId,
      p_expected_revision: input.expectedRevision, p_responses: input.responses,
      p_step: input.step, p_operation: input.operation, p_profile: input.profile ?? {},
    });
    if (error || !Array.isArray(data) || data.length !== 1) return unavailable;
    const row = data[0];
    if (row?.outcome === "conflict") return { ok: false, code: "conflict", error: INTAKE_CONFLICT };
    if (row?.outcome === "terminal") return { ok: false, code: "terminal", error: INTAKE_TERMINAL };
    const revision = intakeRevision(row?.new_revision);
    const expectedOutcome = input.operation === "submit" ? "submitted" : "saved";
    if (row?.outcome !== expectedOutcome || revision === null || BigInt(revision) <= BigInt(input.expectedRevision)) return unavailable;
    return { ok: true, revision, outcome: expectedOutcome };
  } catch {
    // No raw token, answers, profile, database message or existence oracle.
    return unavailable;
  }
}
