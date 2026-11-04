"use server";

import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import {
  coreAccess,
  coreAdopt,
  coreHistory,
  corePreviewAdopt,
  corePreviewChanges,
  corePreviewReset,
  coreReset,
  coreSave,
} from "@/lib/settings/roles/core";
import { enforcementRefusal } from "@/lib/settings/roles/model";
import { loadStudioPolicyState, type StudioPolicyState } from "@/lib/settings/roles/policy-store";
import { reasonAcceptable, type AccessResult, type CommandResult, type HistoryResult, type PreviewResult, type RoleError } from "@/lib/settings/roles/api";

// Server actions of the Roles page (R2). Each one re-checks on the server that the caller is the owner, then hands the request to the
// permission core, which decides everything again from the CURRENT membership row and answers with a code. The page never computes a
// diff and never decides whether a change is valid. Pre-checks here are only shape and the "reason" convenience; the core refuses the
// same things. A submission is atomic in the core: one invalid key refuses the lot.

const refuse = (error: RoleError): { ok: false; error: RoleError } => ({ ok: false, error });

async function assertOwner(): Promise<{ studioId: string } | null> {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  return practitioner.role === "owner" ? { studioId: studio.id } : null;
}

const isRole = (v: unknown): v is "practitioner" | "receptionist" => v === "practitioner" || v === "receptionist";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isVersion = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

// { role: { key: scope } } with string scopes only. Anything else is refused before the core is called.
function changesShape(edits: unknown): Record<string, Record<string, string>> | null {
  if (!isObj(edits)) return null;
  const out: Record<string, Record<string, string>> = {};
  for (const [role, keys] of Object.entries(edits)) {
    if (!isRole(role) || !isObj(keys)) return null;
    out[role] = {};
    for (const [k, v] of Object.entries(keys)) {
      if (typeof v !== "string") return null;
      out[role][k] = v;
    }
  }
  return out;
}

// Enforcement is a fact about app wiring and lives in the TypeScript catalog, so the core cannot refuse it. This guard runs BEFORE the
// core on every free-form change (preview and save): a key the app does not yet enforce is not changed, and a deny_only key is not
// widened above the studio's baseline. Reset and adopt carry no per-key input (a role, a version and a reason) so this guard has nothing
// to refuse there, but they are NOT neutral: adopt moves the studio to the new defaults, which can be wider than today's access for
// deny_only and not_yet keys, and reset can move a stored narrowing back up. Those values are inert until the key is released and the
// owner activates it (the Activation rule); the guard does not prevent storing them. An owner calling the RPC directly can still store
// an inert value; that is owner-only and grants no one anything that is read.
async function wiringRefusal(studioId: string, changes: Record<string, Record<string, string>>): Promise<{ ok: false; error: RoleError } | null> {
  const state = await loadStudioPolicyState(studioId);
  if (!state.writable) return refuse({ code: "unavailable" });
  for (const [role, keys] of Object.entries(changes)) {
    if (!isRole(role)) continue;
    for (const [key, scope] of Object.entries(keys)) {
      const code = enforcementRefusal(role, state.policies[role], key, scope);
      if (code) return refuse({ code, key, role });
    }
  }
  return null;
}

const reasonText = (v: unknown) => (typeof v === "string" ? v : "");

/** The authoritative policy as get_role_permissions holds it NOW. The page reads this after a save instead of assuming its draft became the saved state. */
export async function reloadPolicyAction(): Promise<{ ok: true; state: StudioPolicyState } | { ok: false; error: RoleError }> {
  const owner = await assertOwner();
  if (!owner) return refuse({ code: "refused" });
  const state = await loadStudioPolicyState(owner.studioId);
  // A snapshot fallback is not authoritative: the core could not be read.
  return state.writable ? { ok: true, state } : refuse({ code: "unavailable" });
}

/** Pure preview of a draft's changed keys; returns the version it was computed against. Writes nothing. */
export async function previewRoleChangesAction(edits: unknown): Promise<PreviewResult> {
  const owner = await assertOwner();
  if (!owner) return refuse({ code: "refused" });
  const changes = changesShape(edits);
  if (!changes) return refuse({ code: "invalid_changes" });
  return (await wiringRefusal(owner.studioId, changes)) ?? corePreviewChanges(owner.studioId, changes);
}

export async function previewResetAction(role: unknown): Promise<PreviewResult> {
  const owner = await assertOwner();
  if (!owner) return refuse({ code: "refused" });
  if (!isRole(role)) return refuse({ code: "unknown_role" });
  return corePreviewReset(owner.studioId, role);
}

export async function previewAdoptAction(): Promise<PreviewResult> {
  const owner = await assertOwner();
  if (!owner) return refuse({ code: "refused" });
  return corePreviewAdopt(owner.studioId);
}

/** Save the changed keys of both roles in one atomic request, bound to the version a preview returned. */
export async function saveRolePolicyAction(
  edits: unknown,
  expectedVersion: unknown,
  sensitiveConfirmed: unknown,
  reason: unknown,
): Promise<CommandResult> {
  const owner = await assertOwner();
  if (!owner) return refuse({ code: "refused" });
  const changes = changesShape(edits);
  if (!changes) return refuse({ code: "invalid_changes" });
  if (!isVersion(expectedVersion)) return refuse({ code: "version_required" });
  const text = reasonText(reason);
  // Optional here; the core requires it when the save widens sensitive access. Placeholder-only text is never entered.
  if (!reasonAcceptable("save", false, text)) return refuse({ code: "reason_invalid" });
  return (await wiringRefusal(owner.studioId, changes)) ?? coreSave(owner.studioId, expectedVersion, changes, text.trim(), sensitiveConfirmed === true);
}

/** Reset one role to the studio's own basis. Separate from Save; it has its own preview. */
export async function resetRolePolicyAction(role: unknown, expectedVersion: unknown, reason: unknown): Promise<CommandResult> {
  const owner = await assertOwner();
  if (!owner) return refuse({ code: "refused" });
  if (!isRole(role)) return refuse({ code: "unknown_role" });
  if (!isVersion(expectedVersion)) return refuse({ code: "version_required" });
  if (!reasonAcceptable("reset", false, reasonText(reason))) return refuse({ code: "reason_required" });
  return coreReset(owner.studioId, role, expectedVersion, reasonText(reason).trim());
}

/** The only way an existing studio takes the new defaults. */
export async function adoptNewDefaultsAction(expectedVersion: unknown, reason: unknown): Promise<CommandResult> {
  const owner = await assertOwner();
  if (!owner) return refuse({ code: "refused" });
  if (!isVersion(expectedVersion)) return refuse({ code: "version_required" });
  if (!reasonAcceptable("adopt", false, reasonText(reason))) return refuse({ code: "reason_required" });
  return coreAdopt(owner.studioId, expectedVersion, reasonText(reason).trim());
}

/** The change history, newest first. Read-only. */
export async function listPermissionAuditAction(before: unknown): Promise<HistoryResult> {
  const owner = await assertOwner();
  if (!owner) return refuse({ code: "refused" });
  return coreHistory(owner.studioId, typeof before === "string" && /^\d+$/.test(before) ? before : null);
}

/** What one person can do right now, from the core's resolver. */
export async function effectiveAccessAction(membershipId: unknown): Promise<AccessResult> {
  const owner = await assertOwner();
  if (!owner) return refuse({ code: "refused" });
  if (typeof membershipId !== "string" || membershipId.length === 0) return refuse({ code: "not_found" });
  return coreAccess(owner.studioId, membershipId);
}
