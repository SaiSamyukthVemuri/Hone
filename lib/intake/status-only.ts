import type { ClientIntakeForm } from "@/lib/types/database";

// Roles R4 (Privacy X1): what a viewer WITHOUT clin.view_intake may carry of an intake row. Built field by field from this allow-list,
// never by blanking a full row, so a column added to client_intake_forms later (notes, snapshot, reviewer) cannot leak through.
export type IntakeStatusOnly = Pick<
  ClientIntakeForm,
  "id" | "client_id" | "status" | "started_at" | "submitted_at" | "reviewed_at" | "intake_link_last_sent_at" | "intake_link_expires_at" | "intake_link_send_count"
>;

export function toIntakeStatusOnly(row: IntakeStatusOnly): IntakeStatusOnly {
  return {
    id: row.id,
    client_id: row.client_id,
    status: row.status,
    started_at: row.started_at,
    submitted_at: row.submitted_at,
    reviewed_at: row.reviewed_at,
    // Link display metadata (when the link was last sent / expires): status of the request, not an answer.
    intake_link_last_sent_at: row.intake_link_last_sent_at,
    intake_link_expires_at: row.intake_link_expires_at,
    intake_link_send_count: row.intake_link_send_count,
  };
}

/** The full row when the viewer holds clin.view_intake; otherwise the status-only allow-list. */
export function intakeForViewer<T extends IntakeStatusOnly>(row: T | null, canViewIntake: boolean): T | IntakeStatusOnly | null {
  if (!row) return null;
  return canViewIntake ? row : toIntakeStatusOnly(row);
}
