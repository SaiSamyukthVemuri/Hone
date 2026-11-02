import { catalogByKey, checkChange, ROLES, SCOPES, type Role, type Scope, type StudioPolicy } from "@/lib/permissions/catalog";

const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);
const isScope = (v: unknown): v is Scope => typeof v === "string" && (SCOPES as readonly string[]).includes(v);

/** Validate a whole role submission against the catalog. Pure given the policy. */
export function validateRoleSubmission(
  role: unknown,
  values: unknown,
  base: StudioPolicy,
): { ok: true; role: Role; values: Record<string, Scope> } | { ok: false; error: string; field?: string } {
  if (!isRole(role)) return { ok: false, error: "Unknown role." };
  if (!values || typeof values !== "object" || Array.isArray(values)) return { ok: false, error: "Nothing to save." };
  const next: Record<string, Scope> = {};
  // Apply keys in catalog order is unnecessary: each key is checked against the FINAL submitted set, so a prerequisite and its
  // dependent can be submitted together, but a dependent above its prerequisite is still refused.
  const submitted = values as Record<string, unknown>;
  for (const [key, scope] of Object.entries(submitted)) {
    if (!catalogByKey.has(key)) return { ok: false, error: "Unknown permission.", field: key };
    if (!isScope(scope)) return { ok: false, error: "Unknown scope.", field: key };
    next[key] = scope;
  }
  const final: StudioPolicy = { ...base, values: next };
  for (const [key, scope] of Object.entries(next)) {
    const check = checkChange(role, key, scope, final);
    if (!check.ok) {
      // A value equal to what is already in force is not a change, so an unchanged field never refuses the submission.
      const current = base.values[key];
      if (current === scope) continue;
      return { ok: false, error: check.reason, field: key };
    }
  }
  return { ok: true, role, values: next };
}

