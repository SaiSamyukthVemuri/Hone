import {
  CATALOG,
  scopeRank,
  type PermissionDef,
  type Role,
  type Scope,
  type StudioPolicy,
} from "@/lib/permissions/catalog";
import { groupLabel } from "./model";
import { narrowingKind, type RoleChange, type RoleDiff } from "./diff";
import {
  ROLE_ERROR_CODES,
  type AccessResult,
  type AuditKind,
  type ActivationPreviewResult,
  type AuditRow,
  type ChangeRoleResult,
  type CommandResult,
  type HistoryResult,
  type PersonRef,
  type PreviewResult,
  type RoleError,
  type RoleErrorCode,
  type RolePreview,
} from "./api";

// Pure parsers for what the permission core (0287) returns. The core computes every diff, refusal and affected person; these only
// shape its JSON for display (labels from the catalog, snake_case to camelCase). They never decide what is allowed or what changed.

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const isRole = (v: unknown): v is Role => v === "practitioner" || v === "receptionist";
const toScope = (v: unknown): Scope => (v === "own" || v === "studio" ? v : "off");
const byKey = new Map((CATALOG as readonly PermissionDef[]).map((d) => [d.key, d]));

export const UNEXPECTED: RoleError = { code: "unexpected" };

export function parseError(raw: unknown): RoleError {
  if (!isObj(raw)) return UNEXPECTED;
  const code = str(raw.code);
  if (!code || !(ROLE_ERROR_CODES as readonly string[]).includes(code)) return UNEXPECTED;
  const err: RoleError = { code: code as RoleErrorCode };
  const key = str(raw.key);
  if (key) err.key = key;
  if (isRole(raw.role)) err.role = raw.role;
  const v = raw.current_version;
  if (typeof v === "number") err.currentVersion = v;
  else if (typeof v === "string" && /^\d+$/.test(v)) err.currentVersion = Number(v);
  const count = raw.count;
  if (typeof count === "number" && Number.isInteger(count) && count >= 0) err.count = count;
  else if (typeof count === "string" && /^\d+$/.test(count)) err.count = Number(count);
  return err;
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);

function parsePeople(v: unknown): PersonRef[] {
  if (!isObj(v) || !Array.isArray(v.people)) return [];
  return v.people.filter(isObj).map((p) => ({
    id: str(p.membership_id) ?? "",
    name: str(p.display_name) ?? "No name set",
    state: p.state === "deactivated" ? "deactivated" : "active",
  }));
}

function toDiff(entries: unknown, sensitiveKeys: Set<string> | null, narrowings: RoleDiff["fixedNarrowings"]): RoleDiff {
  const changes: RoleChange[] = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!isObj(e)) continue;
    const key = str(e.key);
    if (!key) continue;
    const def = byKey.get(key);
    const from = toScope(e.before);
    const to = toScope(e.after);
    const widens = scopeRank(to) > scopeRank(from);
    changes.push({
      key,
      label: def?.label ?? key,
      group: def?.group ?? "",
      groupLabel: def ? groupLabel(def.group) : "",
      from,
      to,
      direction: widens ? "widens" : "narrows",
      // The core names the sensitive keys a save widens; for reset and adopt it does not, so the catalog flag marks them.
      newlyEnabledSensitive: widens && (sensitiveKeys ? sensitiveKeys.has(key) : def?.sensitive === true),
      futureBusiness: def?.affectsFutureStudioBusiness === true,
    });
  }
  return {
    changes,
    fixedNarrowings: narrowings,
    widened: changes.filter((c) => c.direction === "widens").length,
    narrowed: changes.filter((c) => c.direction === "narrows").length,
    newlyEnabledSensitive: changes.filter((c) => c.newlyEnabledSensitive).length,
  };
}

export function parsePreview(raw: unknown): PreviewResult {
  if (!isObj(raw)) return { ok: false, error: UNEXPECTED };
  if (raw.ok !== true) return { ok: false, error: parseError(raw) };
  const version = num(raw.version);
  if (version === null || !isObj(raw.changes)) return { ok: false, error: UNEXPECTED };
  const sensitive = Array.isArray(raw.sensitive_keys) ? new Set(raw.sensitive_keys.filter((k): k is string => typeof k === "string")) : null;
  // Adopt names the fixed owner-only items that take today's access away from existing practitioners; they belong to that role.
  const narrowings = Array.isArray(raw.fixed_narrowings)
    ? raw.fixed_narrowings.filter(isObj).map((n) => ({ id: str(n.id) ?? "", label: str(n.label) ?? "", note: str(n.notice), kind: narrowingKind(str(n.id) ?? "", n.practitioner_access) }))
    : [];
  const affected = isObj(raw.affected) ? raw.affected : {};
  const roles: RolePreview[] = [];
  for (const role of Object.keys(raw.changes)) {
    if (!isRole(role)) continue;
    const people = parsePeople(affected[role]);
    const count = isObj(affected[role]) ? (num((affected[role] as Json).count) ?? people.length) : people.length;
    roles.push({ role, diff: toDiff(raw.changes[role], sensitive, role === "practitioner" ? narrowings : []), people, count });
  }
  return { ok: true, preview: { version, roles } };
}

/** preview_activation: the same diff shape as any preview, plus the keys it covers and the hash a commit must present. */
export function parseActivationPreview(raw: unknown): ActivationPreviewResult {
  const base = parsePreview(raw);
  if (!base.ok) return base;
  const r = raw as Json;
  const keys = Array.isArray(r.keys) ? r.keys.filter((k): k is string => typeof k === "string") : null;
  const hash = str(r.preview_hash);
  if (keys === null || hash === null || hash === "") return { ok: false, error: UNEXPECTED };
  const sensitiveKeys = Array.isArray(r.sensitive_keys) ? r.sensitive_keys.filter((k): k is string => typeof k === "string") : [];
  return { ok: true, preview: { ...base.preview, keys, digest: hash, sensitiveKeys, confirmationRequired: r.confirmation_required === true } };
}

export function parseCommand(raw: unknown): CommandResult {
  if (!isObj(raw)) return { ok: false, error: UNEXPECTED };
  if (raw.ok !== true) return { ok: false, error: parseError(raw) };
  const v = num(raw.new_version);
  return v === null ? { ok: false, error: UNEXPECTED } : { ok: true, newVersion: v };
}

/** change_staff_role -> the new membership id and role. Anything that is not exactly that is "unexpected": a success is never guessed. */
export function parseChangeRole(raw: unknown): ChangeRoleResult {
  if (!isObj(raw)) return { ok: false, error: UNEXPECTED };
  if (raw.ok !== true) return { ok: false, error: parseError(raw) };
  const id = str(raw.membership_id);
  return id && isRole(raw.role) ? { ok: true, membershipId: id, role: raw.role } : { ok: false, error: UNEXPECTED };
}

const KINDS: readonly AuditKind[] = ["role_permissions_saved", "defaults_adopted", "role_reset", "staff_role_changed", "permissions_activated"];
const scopeWord = (v: unknown): string => (v === "studio" ? "Whole studio" : v === "own" ? "Own assigned" : v === "off" ? "Off" : typeof v === "string" ? v : "unset");

// A stored choice the audit row recorded as null is a choice that was REMOVED (a reset deletes it): say so, rather than "unset".
const storedWord = (v: unknown): string => (v === null ? "no saved choice" : scopeWord(v));

/** Display strings for what changed in one audit row. Saved rows carry {key:{stored,effective}}; reset and adopt carry effective maps. */
function auditChanges(
  kind: AuditKind,
  before: unknown,
  after: unknown,
): { before: Record<string, string>; after: Record<string, string>; storedBefore: Record<string, string>; storedAfter: Record<string, string> } {
  const b: Record<string, string> = {};
  const a: Record<string, string> = {};
  const sb: Record<string, string> = {};
  const sa: Record<string, string> = {};
  const label = (k: string) => byKey.get(k)?.label ?? k;
  if (!isObj(after)) return { before: b, after: a, storedBefore: sb, storedAfter: sa };
  const pre = isObj(before) ? before : {};
  if (kind === "permissions_activated") {
    // {keys, effective:{key:scope}} on both sides: show only the keys whose effective value moved when the release was activated.
    const aEff = isObj(after.effective) ? after.effective : {};
    const bEff = isObj(pre.effective) ? pre.effective : {};
    for (const k of Object.keys(aEff)) {
      if (aEff[k] === bEff[k]) continue;
      b[label(k)] = scopeWord(bEff[k]);
      a[label(k)] = scopeWord(aEff[k]);
    }
    return { before: b, after: a, storedBefore: sb, storedAfter: sa };
  }
  for (const k of Object.keys(after)) {
    if (kind === "staff_role_changed") {
      if (k === "role") {
        b.Role = String(pre.role ?? "unset");
        a.Role = String(after.role ?? "unset");
      }
      continue;
    }
    const av = after[k];
    const bv = pre[k];
    // A per-key {stored, effective} entry carries the owner's saved choice AND what was in force; a flat value is effective only.
    const aEff = isObj(av) ? av.effective : av;
    const bEff = isObj(bv) ? bv.effective : bv;
    const aSt = isObj(av) && "stored" in av ? av.stored : undefined;
    const bSt = isObj(bv) && "stored" in bv ? bv.stored : undefined;
    if (kind !== "role_permissions_saved" && aEff === bEff && aSt === bSt) continue;
    b[label(k)] = scopeWord(bEff);
    a[label(k)] = scopeWord(aEff);
    if (aSt !== undefined || bSt !== undefined) {
      sb[label(k)] = storedWord(bSt);
      sa[label(k)] = storedWord(aSt);
    }
  }
  return { before: b, after: a, storedBefore: sb, storedAfter: sa };
}

export function parseHistory(raw: unknown, limit: number): HistoryResult {
  if (!isObj(raw)) return { ok: false, error: UNEXPECTED };
  if (raw.ok !== true || !Array.isArray(raw.rows)) return { ok: false, error: parseError(raw) };
  const rows: AuditRow[] = [];
  for (const r of raw.rows) {
    if (!isObj(r)) continue;
    const kind = str(r.kind) as AuditKind | null;
    if (!kind || !KINDS.includes(kind)) continue;
    const changes = auditChanges(kind, r.before, r.after);
    rows.push({
      id: String(r.id ?? ""),
      at: str(r.at) ?? "",
      kind,
      role: isRole(r.role) ? r.role : null,
      actorName: str(r.actor_name) ?? "Former member",
      personName: str(r.person_name),
      personState: r.person_state === "active" ? "active" : r.person_state === "deactivated" ? "deactivated" : null,
      reason: str(r.reason),
      before: changes.before,
      after: changes.after,
      storedBefore: changes.storedBefore,
      storedAfter: changes.storedAfter,
    });
  }
  // The cursor follows the RAW page: a row of a kind this page does not know is dropped from the list but must not end the paging.
  const lastRaw = raw.rows.length === limit ? raw.rows[raw.rows.length - 1] : null;
  const next = isObj(lastRaw) && lastRaw.id !== undefined && lastRaw.id !== null ? String(lastRaw.id) : null;
  return { ok: true, rows, next };
}

export function parseAccess(raw: unknown): AccessResult {
  if (!isObj(raw)) return { ok: false, error: UNEXPECTED };
  if (raw.ok !== true || !Array.isArray(raw.rows)) return { ok: false, error: parseError(raw) };
  return {
    ok: true,
    state: raw.state === "deactivated" ? "deactivated" : "active",
    role: str(raw.role) ?? "",
    rows: raw.rows.filter(isObj).map((r) => ({ key: str(r.key) ?? "", scope: str(r.scope) ?? "off", source: str(r.source) ?? "", cappedBy: str(r.capped_by) })),
  };
}

export type CoreState = {
  version: number;
  basis: "existing_snapshot" | "new_studio";
  policies: Record<Role, StudioPolicy>;
  reviewed: boolean;
  // gates.staff_role_change: the operator ship gate for change_staff_role. False = the page says "not available yet".
  staffRoleChange: boolean;
};

/** get_role_permissions -> one StudioPolicy per role (stored choices only) and whether the owner has reviewed (adopted or customised). */
export function parseState(raw: unknown): CoreState | null {
  if (!isObj(raw) || raw.ok !== true || !isObj(raw.roles)) return null;
  const version = num(raw.version);
  if (version === null) return null;
  const basis = raw.basis === "new_studio" ? "new_studio" : "existing_snapshot";
  const gates: Record<string, boolean> = {};
  if (isObj(raw.gates)) for (const [g, met] of Object.entries(raw.gates)) gates[g] = met === true;
  const policies = {} as Record<Role, StudioPolicy>;
  let customised = false;
  for (const role of ["practitioner", "receptionist"] as const) {
    const values: Record<string, Scope> = {};
    const effective: Record<string, Scope> = {};
    const source: Record<string, string> = {};
    const entries = isObj(raw.roles[role]) ? (raw.roles[role] as Json) : {};
    for (const [key, v] of Object.entries(entries)) {
      if (isObj(v) && typeof v.effective === "string") effective[key] = toScope(v.effective);
      if (isObj(v) && typeof v.source === "string") source[key] = v.source;
      if (isObj(v) && typeof v.stored === "string") {
        values[key] = toScope(v.stored);
        customised = true;
      }
    }
    policies[role] = { basis, values, gates, server: { stored: { ...values }, effective, source } } as StudioPolicy;
  }
  return { version, basis, policies, reviewed: basis === "new_studio" || customised, staffRoleChange: gates.staff_role_change === true };
}
