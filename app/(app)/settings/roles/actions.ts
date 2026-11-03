"use server";

import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { loadStudioPolicyState } from "@/lib/settings/roles/policy-store";
import { validateEdits } from "@/lib/settings/roles/validate";

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
  input: unknown,
  expectedVersion: unknown,
): Promise<RolesActionResult> {
  const owner = await assertOwner();
  if (!owner) return { ok: false, error: OWNER_ONLY };
  const state = await loadStudioPolicyState(owner.studioId);
  // A preview or a draft is bound to the policy version it was computed from. A stale one is refused, never applied (P-3).
  if (expectedVersion !== state.version) return { ok: false, error: STALE };
  const checked = validateEdits(input, { practitioner: state.policy, receptionist: state.policy });
  if (!checked.ok) return checked;
  if (!state.writable) return { ok: false, error: state.notWritableReason ?? "Saving is not available yet." };
  // R1 wires the audited, atomic, versioned writer here. Until then the branch above always returns.
  return { ok: false, error: "Saving is not available yet." };
}

/** Save the whole draft (both roles) in one atomic request. `edits` is { role: { key: scope } } with ONLY the changed keys. */
export async function saveRolePolicyAction(edits: unknown, expectedVersion: unknown): Promise<RolesActionResult> {
  return guarded(edits, expectedVersion);
}

/** Reset a role to the shipped defaults, or adopt them. Separate from Save: it replaces the role's overrides and needs its own preview. */
export async function resetRolePolicyAction(role: unknown, expectedVersion: unknown): Promise<RolesActionResult> {
  const owner = await assertOwner();
  if (!owner) return { ok: false, error: OWNER_ONLY };
  const state = await loadStudioPolicyState(owner.studioId);
  if (expectedVersion !== state.version) return { ok: false, error: STALE };
  if (role !== "practitioner" && role !== "receptionist") return { ok: false, error: "Unknown role." };
  if (!state.writable) return { ok: false, error: state.notWritableReason ?? "Saving is not available yet." };
  return { ok: false, error: "Saving is not available yet." };
}
