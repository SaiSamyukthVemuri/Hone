"use server";

import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { loadStudioPolicyState } from "@/lib/settings/roles/policy-store";
import { validateRoleSubmission } from "@/lib/settings/roles/validate";

// Server actions of the Roles page (R2). Every one re-checks that the caller is the OWNER of the studio on the server, validates
// the whole submission against the one catalog, and only then asks the policy store to write. The store cannot write yet (R1), so
// today every action that would change a policy answers "not available" after validating: a refusal is honest, never a fake save.
// A submission is atomic: one invalid key refuses the lot and nothing is partly applied.

export type RolesActionResult = { ok: true } | { ok: false; error: string; field?: string };

const STALE = "This page is out of date. Reload it and review the changes again.";
const OWNER_ONLY = "Only the studio owner can change roles and permissions.";

async function assertOwner(): Promise<{ studioId: string } | null> {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  return practitioner.role === "owner" ? { studioId: studio.id } : null;
}

async function guarded(
  role: unknown,
  values: unknown,
  expectedVersion: unknown,
): Promise<RolesActionResult> {
  const owner = await assertOwner();
  if (!owner) return { ok: false, error: OWNER_ONLY };
  const state = await loadStudioPolicyState(owner.studioId);
  // A preview or a draft is bound to the policy version it was computed from. A stale one is refused, never applied (P-3).
  if (expectedVersion !== state.version) return { ok: false, error: STALE };
  const checked = validateRoleSubmission(role, values, state.policy);
  if (!checked.ok) return checked;
  if (!state.writable) return { ok: false, error: state.notWritableReason ?? "Saving is not available yet." };
  // R1 wires the audited writer here, passing state.version. Until then the branch above always returns.
  return { ok: false, error: "Saving is not available yet." };
}

export async function saveRolePolicyAction(role: unknown, values: unknown, expectedVersion: unknown): Promise<RolesActionResult> {
  return guarded(role, values, expectedVersion);
}

/** Reset to the shipped defaults, or adopt them: a role's stored overrides are replaced by none and the basis becomes new-studio. */
export async function resetRolePolicyAction(role: unknown, expectedVersion: unknown): Promise<RolesActionResult> {
  return guarded(role, {}, expectedVersion);
}
