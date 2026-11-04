import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/permissions/catalog";
import type { AccessResult, ActivationPreviewResult, CommandResult, HistoryResult, PreviewResult } from "./api";
import { UNEXPECTED, parseAccess, parseActivationPreview, parseCommand, parseHistory, parsePreview, parseState, type CoreState } from "./core-parse";

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

export async function coreReset(studioId: string, role: Role, version: number, reason: string): Promise<CommandResult> {
  return parseCommand(await call("reset_role_to_defaults", { p_studio: studioId, p_role: role, p_expected_version: version, p_reason: reason }));
}

export async function coreAdopt(studioId: string, version: number, reason: string): Promise<CommandResult> {
  return parseCommand(await call("adopt_new_defaults", { p_studio: studioId, p_expected_version: version, p_reason: reason }));
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
