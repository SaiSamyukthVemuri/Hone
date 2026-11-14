import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/permissions/catalog";
import type { AccessResult, ActivationPreviewResult, ChangeRoleResult, CommandResult, HistoryResult, PreviewResult, StaffActiveResult } from "./api";
import { UNEXPECTED, parseAccess, parseActivationPreview, parseChangeRole, parseCommand, parseHistory, parsePreview, parseStaffActive, parseState, type CoreState } from "./core-parse";

// The ONLY place the Roles page talks to the permission core (0287). Every call runs as the signed-in user, so the core decides who the
// owner is from the CURRENT membership row (never from anything passed here) and refuses everyone else with a code. A transport error
// is "unexpected": nothing is retried, nothing is guessed. The core computes every preview, refusal and audit row.

export const HISTORY_PAGE = 50;

async function call(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  return error ? null : data;
}

export async function coreGetState(studioId: string): Promise<CoreState | null> {
  return parseState(await call("get_role_permissions", { p_studio: studioId }));
}

export async function corePreviewChanges(studioId: string, changes: unknown): Promise<PreviewResult> {
  return parsePreview(await call("preview_role_changes", { p_studio: studioId, p_changes: changes }));
}

export async function corePreviewReset(studioId: string, role: Role): Promise<PreviewResult> {
  return parsePreview(await call("preview_reset", { p_studio: studioId, p_role: role }));
}

export async function corePreviewAdopt(studioId: string): Promise<PreviewResult> {
  return parsePreview(await call("preview_adopt_new_defaults", { p_studio: studioId }));
}

export async function coreSave(
  studioId: string,
  version: number,
  changes: unknown,
  reason: string,
  sensitiveConfirmed: boolean,
): Promise<CommandResult> {
  return parseCommand(
    await call("save_role_permissions", {
      p_studio: studioId,
      p_expected_version: version,
      p_changes: changes,
      p_reason: reason === "" ? null : reason,
      p_sensitive_confirmed: sensitiveConfirmed,
    }),
  );
}

// Reset and adopt can widen a SENSITIVE key (a role whose override is Off goes back to the default). The core then requires the owner's explicit
// confirmation (`sensitive_unconfirmed` otherwise), exactly as for a save (Codex P2 on 30555b1d0).
export async function coreReset(studioId: string, role: Role, version: number, reason: string, sensitiveConfirmed: boolean): Promise<CommandResult> {
  return parseCommand(
    await call("reset_role_to_defaults", { p_studio: studioId, p_role: role, p_expected_version: version, p_reason: reason, p_sensitive_confirmed: sensitiveConfirmed }),
  );
}

export async function coreAdopt(studioId: string, version: number, reason: string, sensitiveConfirmed: boolean): Promise<CommandResult> {
  return parseCommand(await call("adopt_new_defaults", { p_studio: studioId, p_expected_version: version, p_reason: reason, p_sensitive_confirmed: sensitiveConfirmed }));
}

export async function corePreviewActivation(studioId: string, keys: string[]): Promise<ActivationPreviewResult> {
  return parseActivationPreview(await call("preview_activation", { p_studio: studioId, p_keys: keys }));
}

export async function coreActivate(
  studioId: string,
  keys: string[],
  version: number,
  reason: string,
  previewHash: string,
  sensitiveConfirmed: boolean,
): Promise<CommandResult> {
  return parseCommand(
    await call("activate_released_permissions", {
      p_studio: studioId,
      p_keys: keys,
      p_expected_version: version,
      p_reason: reason,
      p_preview_hash: previewHash,
      p_sensitive_confirmed: sensitiveConfirmed,
    }),
  );
}

export async function coreHistory(studioId: string, before: string | null): Promise<HistoryResult> {
  const raw = await call("list_permission_audit", { p_studio: studioId, p_limit: HISTORY_PAGE, p_before: before === null ? null : Number(before) });
  return raw === null ? { ok: false, error: UNEXPECTED } : parseHistory(raw, HISTORY_PAGE);
}

export async function coreAccess(studioId: string, membershipId: string): Promise<AccessResult> {
  return parseAccess(await call("effective_access", { p_studio: studioId, p_membership: membershipId }));
}

/** Move one person between practitioner and receptionist. The core refuses self, an owner on either side, a gate that is off, a stale
 *  `expectedCurrentRole`, and a practitioner who still has upcoming appointments; it writes the audit row in the same transaction. */
export async function coreChangeRole(
  studioId: string,
  membershipId: string,
  newRole: Role,
  expectedCurrentRole: Role,
  reason: string,
): Promise<ChangeRoleResult> {
  return parseChangeRole(
    await call("change_staff_role", {
      p_studio: studioId,
      p_membership: membershipId,
      p_new_role: newRole,
      p_expected_current_role: expectedCurrentRole,
      p_reason: reason === "" ? null : reason,
    }),
  );
}

export type StaffKind = "practitioner" | "receptionist";

/** Take one person's access away (0342). The core refuses self, an owner, someone already inactive, upcoming appointments (while the studio's rule is
 *  "block"), and a missing reason; it writes the audit row in the same transaction. Nothing is deleted. */
export async function coreDeactivateStaff(studioId: string, membershipId: string, kind: StaffKind, reason: string): Promise<StaffActiveResult> {
  return parseStaffActive(await call("deactivate_staff_member", { p_studio: studioId, p_membership: membershipId, p_kind: kind, p_reason: reason === "" ? null : reason }));
}

/** Give a deactivated person their access back (0342). Behind the same operator gate as a role change. */
export async function coreReactivateStaff(studioId: string, membershipId: string, kind: StaffKind, reason: string): Promise<StaffActiveResult> {
  return parseStaffActive(await call("reactivate_staff_member", { p_studio: studioId, p_membership: membershipId, p_kind: kind, p_reason: reason === "" ? null : reason }));
}
