import { catalogByKey, checkChange, ROLES, SCOPES, type Role, type Scope, type StudioPolicy } from "@/lib/permissions/catalog";

const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);
const isScope = (v: unknown): v is Scope => typeof v === "string" && (SCOPES as readonly string[]).includes(v);

export type RoleEdits = Partial<Record<Role, Record<string, Scope>>>;
export type ValidateResult =
  | { ok: true; edits: RoleEdits }
  | { ok: false; error: string; role?: Role; field?: string };

/**
 * Validate one submission that may change BOTH roles at once (one draft, one save). Atomic: any invalid edit refuses all.
 * `edits` carries only the keys the owner changed; a key that is not in it is unchanged, never reset (Insurance P-4). Each key is
 * checked against the FINAL submitted set for its role, so a prerequisite and its dependent can travel together, but a dependent
 * above its prerequisite is refused.
 */
export function validateEdits(input: unknown, base: Record<Role, StudioPolicy>): ValidateResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Nothing to save." };
  const out: RoleEdits = {};
  for (const [role, values] of Object.entries(input as Record<string, unknown>)) {
    if (!isRole(role)) return { ok: false, error: "Unknown role." };
    if (!values || typeof values !== "object" || Array.isArray(values)) return { ok: false, error: "Nothing to save.", role };
    const next: Record<string, Scope> = {};
    for (const [key, scope] of Object.entries(values as Record<string, unknown>)) {
      if (!catalogByKey.has(key)) return { ok: false, error: "Unknown permission.", role, field: key };
      if (!isScope(scope)) return { ok: false, error: "Unknown scope.", role, field: key };
      next[key] = scope;
    }
    // The policy as it will be: the stored values with ONLY these keys changed.
    const final: StudioPolicy = { ...base[role], values: { ...base[role].values, ...next } };
    for (const [key, scope] of Object.entries(next)) {
      if (base[role].values[key] === scope) continue; // not a change
      const check = checkChange(role, key, scope, final);
      if (!check.ok) return { ok: false, error: check.reason, role, field: key };
    }
    out[role] = next;
  }
  if (Object.keys(out).length === 0) return { ok: false, error: "Nothing to save." };
  return { ok: true, edits: out };
}
