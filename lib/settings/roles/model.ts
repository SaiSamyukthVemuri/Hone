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
// wired keys by #1341's truth test) and NOT in the database (platform operator decision, 3 Nov). ONLY "enforced" makes a key fully editable. An absent or
// unrecognised value reads as "not_yet": a missing flag makes the page more read-only, never more open.
// "deny_only": refusal works but a wider grant may be inert because a legacy check still stands in front, so the key can be set at or
// BELOW the studio's current snapshot/default and wider options are disabled. Only "enforced" takes effect both ways.
export type Enforcement = EnforcementState;
export const WIDENING_LATER_LINE = "Widening arrives in a later release.";
export const NOT_ENFORCED_LINE = "Not enforced yet. This setting does nothing today, and it will not switch on by itself when that area is wired.";
// Team's write-enforcement matrix (14 Nov): no hosted policy or RPC reads a permission key yet. On THIS branch the app does not read them
// either (lib/permissions/require-permission.ts and its callers are not here; tests/security/roles-page-only-boundary.test.ts pins that), so the
// line must not say the app is wired to anything. Say only what is true: nothing reads these settings, nothing is released yet, and the
// release rule of the permission core (0287): once a setting is released, a choice that LOWERS access applies at once, and one that RAISES
// access waits for the owner's activation. Saying that every saved choice waits for a release and an activation was false for a lowering. If enforcement ships in the app, this wording changes in that same change (a source test fails until it does).
export const RELEASE_RULE_SENTENCE = "After a setting is released, a choice that lowers access applies at once, and one that raises access waits for you to activate it.";
export const ENFORCEMENT_SCOPE_LINE =
  "These settings are not in force yet. The app does not read them yet, and the database does not check them. Nothing is released yet, so none of them changes anyone's access today. After a setting is released, a choice that lowers access applies at once, and one that raises access waits for you to activate it.";
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
  inactiveBecause: string | null; // set when effective is lower than chosen, or (an inert key) HIGHER than chosen: the access still in force
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
  // approved_policy: the value shown is the APPROVED narrower policy; the database may still allow more until the closing PRs ship.
  snapshotBasis: SnapshotBasis;
  // 'Not available yet' is ONLY for the receptionist legal-name keys (platform operator). It never describes a practitioner's current access.
  gateNote: string | null;
  // Any other ship gate: raising the key is held until the condition is met. Plain information, not a refusal of current access.
  heldUntil: string | null;
  needs: string[]; // labels of prerequisites
  live: LiveStatus; // saved vs in force, from the core's own answer (S3)
  alsoSwitchesOff: string[]; // labels of dependents that follow this key down (their stored values are kept)
};

// S3: one plain line per key saying what the owner SAVED and what is IN FORCE for staff right now. The in-force value is the core's own
// answer (never the TypeScript mirror), so when the core could not be read the line says so instead of guessing. Read-only: no control.
export type LiveStatus = { state: "live" | "not_live" | "unknown"; saved: Scope; inForce: Scope | null };

export const liveStatusOf = (saved: Scope, key: string, policy: PolicyWithServer): LiveStatus => {
  const inForce = policy.server?.effective[key];
  if (inForce === undefined) return { state: "unknown", saved, inForce: null };
  const inert = isInertUntilReleased(policy.server?.source[key]);
  return { state: !inert && inForce === saved ? "live" : "not_live", saved, inForce };
};

export const LIVE_UNKNOWN_LINE = "In force now: not shown, because the current access could not be read.";
export const liveStatusLine = (st: LiveStatus, text: (s: Scope) => string): string =>
  st.state === "unknown"
    ? `Saved: ${text(st.saved)}. ${LIVE_UNKNOWN_LINE}`
    : st.state === "live"
      ? `Saved: ${text(st.saved)}. In force now: ${text(st.inForce as Scope)}.`
      : `Saved: ${text(st.saved)}. In force now: ${text(st.inForce as Scope)}. The saved setting is not in force yet. Once it is released, a choice that lowers access applies at once, and one that raises access waits for your activation.`;

export type RoleGroupModel = { group: string; label: string; rows: RoleRow[] };

const isPending = (d: PermissionDef): boolean => (d.pendingDecision?.length ?? 0) > 0;

const dependentsOf = (key: string, role: Role): PermissionDef[] =>
  (CATALOG as readonly PermissionDef[]).filter((d) => d.requires.includes(key) && d.offeredTo[role]);

/** The scope a deny_only key may not be raised above: the studio's current baseline (new-studio default or existing snapshot). */
const baselineScope = (d: PermissionDef, role: Role, policy: StudioPolicy): Scope => (policy.basis === "new_studio" ? d.newStudioDefault[role] : d.existingSnapshot[role]);

// NQ-10 (platform operator, 3 Nov): a saved choice whose prerequisite is off is PRESERVED but INACTIVE. It is never deleted, and turning it on never
// turns the prerequisite on for the owner: the row says what it needs and the owner decides.
// The core says this saved choice is not in force: its key is not released yet, or the release has not been activated by the owner.
export const NOT_ACTIVE_YET_LINE = "Saved, but not in force yet. A choice that raises access takes effect when this setting is released and you activate it.";

// The OPPOSITE case (Codex P1 on 30555b1d0): an owner's saved or drafted choice is LOWER than what the core keeps in force, because the key is
// not released yet (or released and not activated). Without this line the page shows Off while practitioners still have the access.
export const notActiveYetKeeps = (role: Role, inForce: string): string =>
  `Saved, but not in force yet. Once this setting is released, a choice that lowers access applies at once. Until then, ${ROLE_LABELS[role].toLowerCase()}s keep: ${inForce}.`;

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
            : scopeRank(effective) > scopeRank(chosen) && isInertUntilReleased(policy.server?.source[d.key])
              ? notActiveYetKeeps(role, scopeLabel(d, effective))
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
        live: liveStatusOf(chosen, d.key, policy),
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

/**
 * The value a role is on for a key as the OWNER chose it: the stored value, else the studio basis. A draft that picks a value and then picks the
 * original back holds an explicit basis value where the saved policy holds none; they are the same choice (Codex P2 4582593018).
 */
export function chosenScope(role: Role, policy: StudioPolicy, key: string): Scope | undefined {
  const stored = policy.values[key];
  if (stored !== undefined) return stored;
  const def = catalogByKey.get(key);
  return def ? baselineScope(def, role, policy) : undefined;
}

/** Whether two policies make the same choices for a role, key by key over both key sets. */
export function sameChoices(role: Role, a: StudioPolicy, b: StudioPolicy): boolean {
  for (const key of new Set([...Object.keys(a.values), ...Object.keys(b.values)])) {
    if (chosenScope(role, a, key) !== chosenScope(role, b, key)) return false;
  }
  return true;
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
