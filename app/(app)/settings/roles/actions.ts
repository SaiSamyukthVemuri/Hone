"use server";

import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { loadStudioPolicyState } from "@/lib/settings/roles/policy-store";
import { validateEdits } from "@/lib/settings/roles/validate";
import {
  reasonAcceptable,
  type CommandResult,
  type HistoryResult,
  type Operation,
  type PreviewResult,
  type RoleError,
} from "@/lib/settings/roles/api";

// Server actions of the Roles page (R2). Every one re-checks that the caller is the OWNER of the studio on the server. The preview
// and the write are the permission core's (R1): the page never computes a diff. Until the core is on, previews and writes answer
// code "unavailable": a refusal is honest, never a fake save. A submission is atomic: one invalid key refuses the lot.

const refuse = (error: RoleError): { ok: false; error: RoleError } => ({ ok: false, error });

async function assertOwner(): Promise<{ studioId: string } | null> {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  return practitioner.role === "owner" ? { studioId: studio.id } : null;
}

const isRole = (v: unknown): v is "practitioner" | "receptionist" => v === "practitioner" || v === "receptionist";

/** Pure preview of a draft's changed keys. Bound to nothing; returns the version it was computed against. */
export async function previewRoleChangesAction(edits: unknown): Promise<PreviewResult> {
  const owner = await assertOwner();
  if (!owner) return refuse({ code: "refused" });
  const state = await loadStudioPolicyState(owner.studioId);
  const checked = validateEdits(edits, { practitioner: state.policy, receptionist: state.policy });
  if (!checked.ok) return refuse({ code: "unknown_key", key: checked.field });
  // R1: call preview_role_changes(studio, changes) here.
  return refuse({ code: "unavailable" });
}

export async function previewResetAction(role: unknown): Promise<PreviewResult> {
  const owner = await assertOwner();
  if (!owner) return refuse({ code: "refused" });
  if (!isRole(role)) return refuse({ code: "unknown_key" });
  // R1: call preview_reset(studio, role) here.
  return refuse({ code: "unavailable" });
}

export async function previewAdoptAction(): Promise<PreviewResult> {
  const owner = await assertOwner();
  if (!owner) return refuse({ code: "refused" });
  // R1: call preview_adopt_new_defaults(studio) here.
  return refuse({ code: "unavailable" });
}

async function guardedWrite(
  op: Operation,
  expectedVersion: unknown,
  reason: unknown,
  sensitive: boolean,
  validate?: (policyState: Awaited<ReturnType<typeof loadStudioPolicyState>>) => RoleError | null,
): Promise<CommandResult> {
  const owner = await assertOwner();
  if (!owner) return refuse({ code: "refused" });
  const state = await loadStudioPolicyState(owner.studioId);
  // A draft is bound to the policy version its preview was computed against. A stale one is refused, never applied (P-3).
  if (expectedVersion !== state.version) return refuse({ code: "stale_version", currentVersion: state.version });
  if (!reasonAcceptable(op, sensitive, typeof reason === "string" ? reason : "")) return refuse({ code: "reason_required" });
  const invalid = validate?.(state);
  if (invalid) return refuse(invalid);
  if (!state.writable) return refuse({ code: "unavailable" });
  // R1: call save_role_permissions / reset_role_to_defaults / adopt_new_defaults here. Until then the line above always returns.
  return refuse({ code: "unavailable" });
}

/** Save the changed keys of both roles in one atomic request. `edits` is { role: { key: scope } } with ONLY the changed keys. */
export async function saveRolePolicyAction(
  edits: unknown,
  expectedVersion: unknown,
  sensitiveConfirmed: unknown,
  reason: unknown,
): Promise<CommandResult> {
  return guardedWrite("save", expectedVersion, reason, sensitiveConfirmed === true, (state) => {
    const empty = typeof edits === "object" && edits !== null && Object.values(edits).every((v) => typeof v === "object" && v !== null && Object.keys(v).length === 0);
    if (empty) return { code: "nothing_changed" };
    const checked = validateEdits(edits, { practitioner: state.policy, receptionist: state.policy });
    return checked.ok ? null : { code: "unknown_key", key: checked.field };
  });
}

/** Reset one role to the studio's own basis. Separate from Save: it replaces the role's overrides and has its own preview. */
export async function resetRolePolicyAction(role: unknown, expectedVersion: unknown, reason: unknown): Promise<CommandResult> {
  return guardedWrite("reset", expectedVersion, reason, false, () => (isRole(role) ? null : { code: "unknown_key" }));
}

/** The only way an existing studio takes the new defaults. */
export async function adoptNewDefaultsAction(expectedVersion: unknown, reason: unknown): Promise<CommandResult> {
  return guardedWrite("adopt", expectedVersion, reason, false);
}

/** The change history, newest first. Read-only; the core's list_permission_audit answers it. */
export async function listPermissionAuditAction(_before: unknown): Promise<HistoryResult> {
  const owner = await assertOwner();
  if (!owner) return refuse({ code: "refused" });
  // R1: call list_permission_audit(studio, limit, before) here.
  return refuse({ code: "unavailable" });
}
