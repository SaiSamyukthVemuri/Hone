import { COMMON_KEYS, consequenceOf, SECTIONS, sectionOfKey, type Consequence, type SectionId } from "./sections";
import {
  CATALOG,
  GATES,
  GROUPS,
  catalogByKey,
  checkChange,
  effectiveScope,
  scopeRank,
  scopesFor,
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

// Whether the database/app yet enforces a key. The permission core reports it per key (get_role_permissions keys{key:{enforcement}});
// the catalog entry carries the same value. ONLY "enforced" makes a key editable. Absent or unrecognised reads as "not_yet": a late or
// missing flag makes the page more read-only, never more open (OPS decision, 3 Nov).
// "deny_only": refusal works but a wider grant may be inert because a legacy check still stands in front, so the key can be set at or
// BELOW the studio's current snapshot/default and wider options are disabled (OPS, 3 Nov). Only "enforced" takes effect both ways.
export type Enforcement = "enforced" | "deny_only" | "observe" | "not_yet";
export const WIDENING_LATER_LINE = "Widening arrives in a later release.";
export type EnforcementMap = Readonly<Record<string, string>>;
export const NOT_ENFORCED_LINE = "Not enforced yet. This switch will apply when that area is wired.";
export const ENFORCEMENT_SCOPE_LINE = "This release enforces: appointments, clinical viewing, photos, availability; other areas are shown for planning.";
export function enforcementOf(key: string, map: EnforcementMap | undefined, catalogValue?: unknown): Enforcement {
  // The core's report is the authority whenever the page has one (even an empty one: a key it does not name is not enforced). The
  // catalog value is used only where no report is passed at all (the model's own unit tests).
  const v = map ? map[key] : catalogValue;
  return v === "enforced" || v === "deny_only" || v === "observe" ? v : "not_yet";
}

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

export function buildRoleModel(role: Role, policy: StudioPolicy, enforcementMap?: EnforcementMap): RoleGroupModel[] {
  const defs = CATALOG as readonly PermissionDef[];
  const order = [...GROUPS, ...Array.from(new Set(defs.map((d) => d.group))).filter((g) => !(GROUPS as readonly string[]).includes(g))];
  const out: RoleGroupModel[] = [];
  for (const group of order) {
    const rows: RoleRow[] = [];
    for (const d of defs.filter((x) => x.group === group)) {
      const chosen: Scope = policy.values[d.key] ?? (policy.basis === "new_studio" ? d.newStudioDefault[role] : d.existingSnapshot[role]);
      const effective = effectiveScope(role, d.key, policy);
      const locked = !d.ownerConfigurable
        ? "A fixed part of this role. It is not a switch."
        : !d.offeredTo[role]
          ? `Not offered to ${ROLE_LABELS[role].toLowerCase()}s in this version.`
          : null;
      const enforcement = enforcementOf(d.key, enforcementMap, (d as { enforcement?: unknown }).enforcement);
      const options: OptionState[] = scopesFor(d, role).map((scope) => {
        const check = scope === chosen || locked ? ({ ok: true } as const) : checkChange(role, d.key, scope, policy);
        const widerThanBaseline = enforcement === "deny_only" && scope !== chosen && scopeRank(scope) > scopeRank(baselineScope(d, role, policy));
        return {
          scope,
          label: scopeLabel(d, scope),
          selected: scope === chosen,
          disabled: locked !== null || (enforcement !== "enforced" && enforcement !== "deny_only") || widerThanBaseline || !check.ok,
          reason: widerThanBaseline ? WIDENING_LATER_LINE : check.ok ? null : check.reason,
        };
      });
      const dependents = dependentsOf(d.key, role).filter((x) => effectiveScope(role, x.key, policy) !== "off");
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
            ? gate && policy.gates?.[gate] !== true && scopeRank(chosen) > scopeRank(d.existingSnapshot[role])
              ? `Not yet available: ${GATES[gate]}.`
              : `Needs ${d.requires.map((r) => catalogByKey.get(r)?.label ?? r).join(", ")} turned on first.`
            : null,
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

/** Apply one owner edit to a draft. It changes ONLY that key, and only when the catalog allows it; otherwise it returns the refusal. */
export function applyEdit(
  role: Role,
  policy: StudioPolicy,
  key: string,
  next: Scope,
  enforcementMap?: EnforcementMap,
): { ok: true; policy: StudioPolicy } | { ok: false; reason: string } {
  if (enforcementMap) {
    const mode = enforcementOf(key, enforcementMap, (catalogByKey.get(key) as { enforcement?: unknown } | undefined)?.enforcement);
    if (mode === "observe" || mode === "not_yet") return { ok: false, reason: NOT_ENFORCED_LINE };
    const defOf = catalogByKey.get(key);
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
export function buildRoleSections(role: Role, policy: StudioPolicy, enforcementMap?: EnforcementMap): RoleSectionModel[] {
  const rows = buildRoleModel(role, policy, enforcementMap).flatMap((g) => g.rows);
  return SECTIONS.map((s) => {
    const mine = rows.filter((r) => r.section === s.id);
    return { id: s.id, label: s.label, common: mine.filter((r) => !r.advanced), advanced: mine.filter((r) => r.advanced) };
  }).filter((s) => s.common.length + s.advanced.length > 0);
}
