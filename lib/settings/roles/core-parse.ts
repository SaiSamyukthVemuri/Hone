import {
  CATALOG,
  scopeRank,
  type PermissionDef,
  type Role,
  type Scope,
  type StudioPolicy,
} from "@/lib/permissions/catalog";
import { groupLabel } from "./model";
import type { RoleChange, RoleDiff } from "./diff";
import {
  ROLE_ERROR_CODES,
  type AccessResult,
  type AuditKind,
  type AuditRow,
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
    ? raw.fixed_narrowings.filter(isObj).map((n) => ({ id: str(n.id) ?? "", label: str(n.label) ?? "", note: str(n.notice) }))
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

export function parseCommand(raw: unknown): CommandResult {
  if (!isObj(raw)) return { ok: false, error: UNEXPECTED };
  if (raw.ok !== true) return { ok: false, error: parseError(raw) };
  const v = num(raw.new_version);
  return v === null ? { ok: false, error: UNEXPECTED } : { ok: true, newVersion: v };
}

const KINDS: readonly AuditKind[] = ["role_permissions_saved", "defaults_adopted", "role_reset", "staff_role_changed"];
const scopeWord = (v: unknown): string => (v === "studio" ? "Whole studio" : v === "own" ? "Own assigned" : v === "off" ? "Off" : typeof v === "string" ? v : "unset");

/** Display strings for what changed in one audit row. Saved rows carry {key:{stored,effective}}; reset and adopt carry effective maps. */
function auditChanges(kind: AuditKind, before: unknown, after: unknown): { before: Record<string, string>; after: Record<string, string> } {
  const b: Record<string, string> = {};
  const a: Record<string, string> = {};
  const label = (k: string) => byKey.get(k)?.label ?? k;
  if (!isObj(after)) return { before: b, after: a };
  const pre = isObj(before) ? before : {};
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
    const aEff = isObj(av) ? av.effective : av;
    const bEff = isObj(bv) ? bv.effective : bv;
    if (kind !== "role_permissions_saved" && aEff === bEff) continue;
    b[label(k)] = scopeWord(bEff);
    a[label(k)] = scopeWord(aEff);
  }
  return { before: b, after: a };
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
    });
  }
  const last = rows.length === limit ? rows[rows.length - 1]?.id ?? null : null;
  return { ok: true, rows, next: last };
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
    const entries = isObj(raw.roles[role]) ? (raw.roles[role] as Json) : {};
    for (const [key, v] of Object.entries(entries)) {
      if (isObj(v) && typeof v.stored === "string") {
        values[key] = toScope(v.stored);
        customised = true;
      }
    }
    policies[role] = { basis, values, gates } as StudioPolicy;
  }
  return { version, basis, policies, reviewed: basis === "new_studio" || customised };
}
