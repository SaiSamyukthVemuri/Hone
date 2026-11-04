import { isInertUntilReleased, shownEffectiveScope, type PolicyWithServer } from "./server-effective";
import { COMMON_KEYS, consequenceOf, SECTIONS, sectionOfKey, type Consequence, type SectionId } from "./sections";
import {
  CATALOG,
  GATES,
  GROUPS,
  catalogByKey,
  checkChange,
  enforcementOf as catalogEnforcementOf,
  scopeRank,
  scopesFor,
  type EnforcementState,
  type PermissionDef,
  type SnapshotBasis,
  type Role,
  type Scope,
  type StudioPolicy,
} from "@/lib/permissions/catalog";

// The Roles page's view model (R2). PURE: it reads the one permission catalog and a studio policy and says what the page shows
// and what each control may do. It never decides a permission itself: prerequisites, scopes and ship gates all come from the
// catalog's own helpers, so the page, the server and the database cannot drift. Setting one key never changes another.

export const ROLE_LABELS: Record<Role, string> = { practitioner: "Practitioner", receptionist: "Receptionist" };

// Page order is the catalog's GROUPS order; a group the catalog adds later falls back to a readable label and is shown last.
export const GROUP_LABELS: Record<string, string> = {
  appointments: "Appointments",
  clients_identity: "Clients and identity",
  clinical_records: "Clinical records",
  communications: "Communications",
  payments: "Payments",
  pricing: "Pricing",
  availability: "Availability",
  reports: "Reports",
  waitlist_operations: "Waitlist: entries",
  waitlist_rules: "Waitlist: rules and automation",
  accepting_new_clients: "Accepting new clients",
};

// A group the catalog adds before this map learns it still reads as words, never as an id.
export const groupLabel = (group: string): string => {
  if (GROUP_LABELS[group]) return GROUP_LABELS[group];
  const words = group.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const SCOPE_LABELS: Record<Scope, string> = { off: "Off", own: "Own assigned", studio: "Whole studio" };
// A boolean key is Off / On: "Whole studio" means nothing for a switch.
export const scopeLabel = (d: PermissionDef, scope: Scope): string =>
  d.scopes.length === 2 ? (scope === "off" ? "Off" : "On") : SCOPE_LABELS[scope];

// Whether the app yet enforces a key is a fact about APP WIRING, so it lives in the TypeScript catalog (`enforcement`, proven against the
// wired keys by #1341's truth test) and NOT in the database (OPS decision, 3 Nov). ONLY "enforced" makes a key fully editable. An absent or
// unrecognised value reads as "not_yet": a missing flag makes the page more read-only, never more open.
// "deny_only": refusal works but a wider grant may be inert because a legacy check still stands in front, so the key can be set at or
// BELOW the studio's current snapshot/default and wider options are disabled. Only "enforced" takes effect both ways.
export type Enforcement = EnforcementState;
export const WIDENING_LATER_LINE = "Widening arrives in a later release.";
export const NOT_ENFORCED_LINE = "Not enforced yet. This setting does nothing today, and it will not switch on by itself when that area is wired.";
export const ENFORCEMENT_SCOPE_LINE = "This release enforces: appointments, clinical viewing, photos, availability; other areas are shown for planning.";
const KNOWN_ENFORCEMENT: readonly string[] = ["enforced", "deny_only", "observe", "not_yet"];
const enforcementState = (key: string): Enforcement => {
  const v = catalogEnforcementOf(key);
  return KNOWN_ENFORCEMENT.includes(v) ? v : "not_yet";
};

export type OptionState = { scope: Scope; label: string; selected: boolean; disabled: boolean; reason: string | null };

export type RoleRow = {
  key: string;
  label: string;
  description: string;
  ownMeaning: string | null;
  defaultScope: Scope; // what a NEW studio ships with, shown beside the current value
  chosen: Scope; // what the owner has set (or the basis value)
  effective: Scope; // what is actually in force after prerequisites and gates
  inactiveBecause: string | null; // set when effective is lower than chosen
  // NQ-10: set when the saved choice is ALSO held down by a prerequisite that is off (judged from the core's effective values), even
  // while the more general "not in force yet" line is showing. Names what must be on; the choice is kept.
  inactiveUntil: string | null;
  options: OptionState[];
  locked: string | null; // why no control is offered at all
  enforcement: Enforcement; // "enforced" is editable; "deny_only" only at or below the baseline; "observe" and "not_yet" are shown for planning
  futureBusiness: boolean;
  sensitive: boolean;
  consequence: Consequence;
  section: SectionId;
  // Finer controls sit under Advanced: a fixed baseline, a key held by a ship gate, or one still awaiting a decision.
  advanced: boolean;
  pendingDecision: boolean;
  // approved_policy: the value shown is the APPROVED narrower policy; the database may still allow more until the closing PRs ship (P-1).
  snapshotBasis: SnapshotBasis;
  // 'Not available yet' is ONLY for the receptionist legal-name keys (Sam, group 6). It never describes a practitioner's current access.
  gateNote: string | null;
  // Any other ship gate: raising the key is held until the condition is met. Plain information, not a refusal of current access.
  heldUntil: string | null;
  needs: string[]; // labels of prerequisites
  alsoSwitchesOff: string[]; // labels of dependents that follow this key down (their stored values are kept)
};

export type RoleGroupModel = { group: string; label: string; rows: RoleRow[] };

const isPending = (d: PermissionDef): boolean => (d.pendingDecision?.length ?? 0) > 0;

const dependentsOf = (key: string, role: Role): PermissionDef[] =>
  (CATALOG as readonly PermissionDef[]).filter((d) => d.requires.includes(key) && d.offeredTo[role]);

/** The scope a deny_only key may not be raised above: the studio's current baseline (new-studio default or existing snapshot). */
const baselineScope = (d: PermissionDef, role: Role, policy: StudioPolicy): Scope => (policy.basis === "new_studio" ? d.newStudioDefault[role] : d.existingSnapshot[role]);

// NQ-10 (Sam, 3 Nov): a saved choice whose prerequisite is off is PRESERVED but INACTIVE. It is never deleted, and turning it on never
// turns the prerequisite on for the owner: the row says what it needs and the owner decides.
// The core says this saved choice is not in force: its key is not released yet, or the release has not been activated by the owner.
export const NOT_ACTIVE_YET_LINE = "Saved, but not in force yet. It takes effect when this setting is released and you activate it.";

export const inactiveUntilOn = (labels: string[]): string => `Inactive until ${labels.join(" and ")} ${labels.length > 1 ? "are" : "is"} on. Your choice is kept.`;

export const inactiveNeeds = (labels: string[]): string =>
  `Inactive: needs ${labels.join(", ")}. Your choice is kept and applies again when ${labels.length > 1 ? "those are" : "that is"} on.`;

export function buildRoleModel(role: Role, policy: PolicyWithServer): RoleGroupModel[] {
  const defs = CATALOG as readonly PermissionDef[];
  const order = [...GROUPS, ...Array.from(new Set(defs.map((d) => d.group))).filter((g) => !(GROUPS as readonly string[]).includes(g))];
  const out: RoleGroupModel[] = [];
  for (const group of order) {
    const rows: RoleRow[] = [];
    for (const d of defs.filter((x) => x.group === group)) {
      const chosen: Scope = policy.values[d.key] ?? (policy.basis === "new_studio" ? d.newStudioDefault[role] : d.existingSnapshot[role]);
      const effective = shownEffectiveScope(role, d.key, policy);
      const locked = !d.ownerConfigurable
        ? "A fixed part of this role. It is not a switch."
        : !d.offeredTo[role]
          ? `Not offered to ${ROLE_LABELS[role].toLowerCase()}s in this version.`
          : null;
      const enforcement = enforcementState(d.key);
      const options: OptionState[] = scopesFor(d, role).map((scope) => {
        const check = scope === chosen || locked ? ({ ok: true } as const) : checkChange(role, d.key, scope, policy);
        const widerThanBaseline = enforcement === "deny_only" && scope !== chosen && scopeRank(scope) > scopeRank(baselineScope(d, role, policy));
        return {
          scope,
          label: scopeLabel(d, scope),
          selected: scope === chosen,
          disabled: locked !== null || (enforcement !== "enforced" && enforcement !== "deny_only") || widerThanBaseline || !check.ok,
          reason: check.ok ? (widerThanBaseline ? WIDENING_LATER_LINE : null) : check.reason, // a missing prerequisite is the more specific reason
        };
      });
      const dependents = dependentsOf(d.key, role).filter((x) => shownEffectiveScope(role, x.key, policy) !== "off");
      const gate = d.shipGate?.[role];
      rows.push({
        key: d.key,
        label: d.label,
        description: d.description,
        ownMeaning: d.scopes.includes("own") && role === "practitioner" ? (d.own ?? null) : null,
        defaultScope: d.newStudioDefault[role],
        chosen,
        effective,
        inactiveBecause:
          scopeRank(effective) < scopeRank(chosen)
            ? isInertUntilReleased(policy.server?.source[d.key])
              ? NOT_ACTIVE_YET_LINE
              : gate && policy.gates?.[gate] !== true && scopeRank(chosen) > scopeRank(d.existingSnapshot[role])
              ? `Inactive: not yet available: ${GATES[gate]}.`
              : inactiveNeeds(d.requires.map((r) => catalogByKey.get(r)?.label ?? r))
            : null,
        inactiveUntil: (() => {
          if (scopeRank(effective) >= scopeRank(chosen) || !isInertUntilReleased(policy.server?.source[d.key])) return null;
          const off = d.requires.filter((r) => scopeRank(shownEffectiveScope(role, r, policy)) < scopeRank(chosen));
          return off.length > 0 ? inactiveUntilOn(off.map((r) => catalogByKey.get(r)?.label ?? r)) : null;
        })(),
        options,
        locked,
        enforcement,
        futureBusiness: d.affectsFutureStudioBusiness === true,
        sensitive: d.sensitive === true,
        consequence: consequenceOf(d),
        section: sectionOfKey(d),
        advanced: !COMMON_KEYS.has(d.key) || locked !== null || isPending(d) || (gate !== undefined && policy.gates?.[gate] !== true),
        pendingDecision: isPending(d),
        snapshotBasis: d.snapshotBasis,
        gateNote: gate === "receptionist_legal_name" && role === "receptionist" && policy.gates?.[gate] !== true ? GATES[gate] : null,
        heldUntil: gate && gate !== "receptionist_legal_name" && policy.gates?.[gate] !== true ? GATES[gate] : null,
        needs: d.requires.map((r) => catalogByKey.get(r)?.label ?? r),
        alsoSwitchesOff: dependents.map((x) => x.label),
      });
    }
    if (rows.length > 0) out.push({ group, label: groupLabel(group), rows });
  }
  return out;
}

/**
 * The wiring rule, for the server action as much as the page: a key the app does not yet enforce cannot be changed, and a deny_only key
 * cannot be raised above the studio's baseline. A choice equal to what is already in force is no change and is never refused here.
 * Unknown keys return null: the core refuses them with its own code.
 */
export function enforcementRefusal(role: Role, policy: StudioPolicy, key: string, next: string): "not_enforced" | "widening_not_yet" | null {
  const def = catalogByKey.get(key);
  if (!def) return null;
  const inForce = policy.values[key] ?? baselineScope(def, role, policy);
  if (inForce === next) return null;
  // Discard: putting a key back on the studio's basis never grants anything the basis does not, so it is allowed for every key,
  // including ones the app does not enforce yet (the owner can always take back a choice that is waiting on a release).
  if (next === baselineScope(def, role, policy)) return null;
  const mode = enforcementState(key);
  if (mode === "observe" || mode === "not_yet") return "not_enforced";
  if (mode === "deny_only" && scopeRank(next as Scope) > scopeRank(baselineScope(def, role, policy))) return "widening_not_yet";
  return null;
}

/** Apply one owner edit to a draft. It changes ONLY that key, and only when the catalog allows it; otherwise it returns the refusal. */
export function applyEdit(
  role: Role,
  policy: StudioPolicy,
  key: string,
  next: Scope,
): { ok: true; policy: StudioPolicy } | { ok: false; reason: string } {
  {
    const mode = enforcementState(key);
    const defOf = catalogByKey.get(key);
    const toBasis = defOf !== undefined && next === baselineScope(defOf, role, policy);
    if (!toBasis && (mode === "observe" || mode === "not_yet")) return { ok: false, reason: NOT_ENFORCED_LINE };
    if (mode === "deny_only" && defOf && scopeRank(next) > scopeRank(baselineScope(defOf, role, policy)) && policy.values[key] !== next) {
      return { ok: false, reason: WIDENING_LATER_LINE };
    }
  }
  const current = policy.values[key];
  if (current === next) return { ok: true, policy };
  const def = catalogByKey.get(key);
  const basisValue = def ? (policy.basis === "new_studio" ? def.newStudioDefault[role] : def.existingSnapshot[role]) : undefined;
  if (current === undefined && basisValue === next) return { ok: true, policy };
  const check = checkChange(role, key, next, policy);
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, policy: { ...policy, values: { ...policy.values, [key]: next } } };
}

export type RoleSectionModel = { id: SectionId; label: string; common: RoleRow[]; advanced: RoleRow[] };

/** The eight sections for a role, common actions first and finer controls under Advanced. Presentation only: every row is one key. */
export function buildRoleSections(role: Role, policy: PolicyWithServer): RoleSectionModel[] {
  const rows = buildRoleModel(role, policy).flatMap((g) => g.rows);
  return SECTIONS.map((s) => {
    const mine = rows.filter((r) => r.section === s.id);
    return { id: s.id, label: s.label, common: mine.filter((r) => !r.advanced), advanced: mine.filter((r) => r.advanced) };
  }).filter((s) => s.common.length + s.advanced.length > 0);
}
