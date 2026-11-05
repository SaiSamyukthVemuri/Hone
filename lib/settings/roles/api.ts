import type { Role } from "@/lib/permissions/catalog";
import type { RoleDiff } from "./diff";

// The contract between the Roles page and the permission core (R1), agreed with Team 3 Nov (general/ROLES-R1-INTERFACE-REPLY-20261103.md).
// Types and pure helpers only, so the client editor, the server actions and the tests share one shape. The DB computes every preview
// and every refusal; the page never recomputes a diff and never decides whether a save is valid.

/** Refusal codes the permission core returns. `unavailable`, `not_enforced` and `widening_not_yet` are the page's own: the first means the core is not on yet; the other two are the server action's wiring guard (enforcement lives in the TypeScript catalog, not the core). Nothing was attempted in any of them. */
export const ROLE_ERROR_CODES = [
  "stale_version",
  "refused",
  "unknown_key",
  "fixed_key",
  "not_offered",
  "scope_not_allowed",
  "prerequisite_unmet",
  "gate_unmet",
  "keys_required",
  "preview_required",
  "stale_preview",
  "not_released",
  "not_enforced",
  "widening_not_yet",
  "sensitive_unconfirmed",
  "reason_required",
  "nothing_changed",
  "invalid_changes",
  "version_required",
  "unknown_role",
  "reason_invalid",
  "not_found",
  "owner_role_fixed",
  "self_change",
  "not_active",
  "has_upcoming_appointments",
  "email_required",
  "unexpected",
  "unavailable",
] as const;
export type RoleErrorCode = (typeof ROLE_ERROR_CODES)[number];

/** `key` and `role` are present on the per-key refusals so the message lands on the row; `currentVersion` on `stale_version`. */
export type RoleError = { code: RoleErrorCode; key?: string; role?: Role; currentVersion?: number; count?: number };

export type PersonRef = { id: string; name: string; state: "active" | "invited" | "deactivated" };

/** A stored choice a reset would delete (0287 stored_removed). When access in force does not move, the choice was held inactive: not released, not activated, or blocked by a prerequisite. */
export type StoredRemoval = { key: string; label: string; stored: string; effectiveBefore: string; effectiveAfter: string };

export type RolePreview = { role: Role; diff: RoleDiff; people: PersonRef[]; count: number; storedRemoved: StoredRemoval[] };

/** What every preview returns: the diff per role AND the policy version it was computed against. A save binds to that version. */
export type ServerPreview = { version: number; roles: RolePreview[] };

export type PreviewResult = { ok: true; preview: ServerPreview } | { ok: false; error: RoleError };
export type CommandResult = { ok: true; newVersion: number } | { ok: false; error: RoleError };

/** change_staff_role: the membership the person now holds and the role they now have. */
export type ChangeRoleResult = { ok: true; membershipId: string; role: Role } | { ok: false; error: RoleError };

/** An activation preview: the usual per-role diff plus the keys it names and the hash a commit must carry back (0287 Insurance AA-1). */
export type ActivationPreview = ServerPreview & { keys: string[]; digest: string; sensitiveKeys: string[]; confirmationRequired: boolean };
export type ActivationPreviewResult = { ok: true; preview: ActivationPreview } | { ok: false; error: RoleError };

export type AuditKind = "role_permissions_saved" | "defaults_adopted" | "role_reset" | "staff_role_changed" | "permissions_activated";

/** One audit row as list_permission_audit returns it: names resolved at read time, no emails. A removed member reads as "former member". */
export type AuditRow = {
  id: string;
  at: string;
  kind: AuditKind;
  role: Role | null;
  actorName: string;
  personName: string | null;
  personState: "active" | "deactivated" | null;
  reason: string | null;
  // Only what changed, as display strings keyed by permission key (or "role" for a staff role change).
  // What was IN FORCE (the effective scope).
  before: Record<string, string>;
  after: Record<string, string>;
  // The owner's SAVED choice, where the audit row recorded one. It differs from the effective scope while a setting is not released or not
  // activated yet, or is held inactive by a prerequisite; History shows both so "Studio to Off" is never printed as "Studio to Studio".
  storedBefore: Record<string, string>;
  storedAfter: Record<string, string>;
};

/** One row of effective_access: the scope in force, where it came from, and what capped it. */
export type AccessRow = { key: string; scope: string; source: string; cappedBy: string | null };
export type AccessResult = { ok: true; state: "active" | "deactivated"; role: string; rows: AccessRow[] } | { ok: false; error: RoleError };
export type HistoryResult = { ok: true; rows: AuditRow[]; next: string | null } | { ok: false; error: RoleError };

/** Append an older page to the rows already shown. A row seen twice (a page that overlaps) is kept once; order is newest first. */
export function appendHistoryPage(shown: AuditRow[], older: AuditRow[]): AuditRow[] {
  const seen = new Set(shown.map((r) => r.id));
  return [...shown, ...older.filter((r) => !seen.has(r.id))];
}

export const AUDIT_KIND_LABEL: Record<AuditKind, string> = {
  role_permissions_saved: "Permissions changed",
  defaults_adopted: "New defaults adopted",
  role_reset: "Role reset to defaults",
  staff_role_changed: "Staff role changed",
  permissions_activated: "Released settings activated",
};

export type Operation = "save" | "reset" | "adopt";

// Sam, batch 4: a reason is REQUIRED when adopting defaults, resetting saved permissions, or expanding sensitive access (including
// widening its scope); optional otherwise. A character count is not proof of a useful reason, so there is no minimum length. The page
// only refuses blank and placeholder-only text as a convenience; the permission core makes the same refusal. Before/after is
// recorded automatically either way.
export const REASON_REQUIRED: Record<Operation, "always" | "when_sensitive"> = {
  save: "when_sensitive",
  reset: "always",
  adopt: "always",
};

export function reasonRequired(op: Operation, sensitiveRaise: boolean): boolean {
  return REASON_REQUIRED[op] === "always" || sensitiveRaise;
}

const PLACEHOLDERS = new Set(["na", "n/a", "none", "nil", "null", "test", "testing", "asdf", "xxx", "tbd", "todo", "reason", "ok", "idk", "foo", "bar"]);

/** True when the text says something: it has a letter or digit and is not a bare placeholder. */
export function reasonMeaningful(reason: string): boolean {
  const t = reason.trim().toLowerCase();
  if (!/[\p{L}\p{N}]/u.test(t)) return false;
  return !PLACEHOLDERS.has(t.replace(/[.\s]+$/g, ""));
}

/** Required operations need meaningful text. Where optional, an empty reason is fine but placeholder-only text is not entered. */
export function reasonAcceptable(op: Operation, sensitiveRaise: boolean, reason: string): boolean {
  if (reason.trim() === "") return !reasonRequired(op, sensitiveRaise);
  return reasonMeaningful(reason);
}

const MESSAGES: Record<RoleErrorCode, string> = {
  stale_version: "Someone changed these settings since you opened them. Your choices are kept. Review the current changes again before you save.",
  refused: "Only the studio owner can change roles and permissions.",
  unknown_key: "One of these settings is not recognised. Nothing was saved.",
  fixed_key: "This setting cannot be delegated. Nothing was saved.",
  not_offered: "This setting is not offered to this role. Nothing was saved.",
  scope_not_allowed: "This role cannot have that scope for this setting. Nothing was saved.",
  prerequisite_unmet: "A setting this one depends on is off. Turn that on first. Nothing was saved.",
  gate_unmet: "This setting is not available yet. Nothing was saved.",
  not_released: "This setting has not been released yet. Nothing was changed.",
  keys_required: "Choose at least one setting first. Nothing was changed.",
  preview_required: "Review what would change first. Nothing was changed.",
  stale_preview: "What would change has moved since you reviewed it. Review it again. Nothing was changed.",
  not_enforced: "Not enforced yet. This setting does nothing today, and it will not switch on by itself when that area is wired. Nothing was saved.",
  widening_not_yet: "Widening arrives in a later release. You can turn this down now. Nothing was saved.",
  sensitive_unconfirmed: "Confirm that you understand the newly enabled financial or sensitive access, then save again.",
  reason_required: "Say why you are making this change.",
  nothing_changed: "There is nothing to save. Your choices match what is already saved.",
  invalid_changes: "That request was not understood. Nothing was saved.",
  version_required: "This page is out of date. Reload it and try again.",
  unknown_role: "That role does not exist. Nothing was saved.",
  reason_invalid: "That reason is not meaningful. Say why in your own words.",
  not_found: "That person was not found with that role. Their role may have just changed. Reload the page to see the current state. Nothing was changed.",
  owner_role_fixed: "The owner role is fixed and cannot be changed here.",
  self_change: "You cannot change your own role.",
  not_active: "That person is not active. Their role may have just changed. Reload the page to see the current state. Nothing was changed.",
  has_upcoming_appointments: "That practitioner still has upcoming appointments. Move them first.",
  email_required: "That person needs an email address on file first.",
  unexpected: "Something went wrong and we could not confirm the result. Reload the page to see what is saved.",
  unavailable: "Saving role changes turns on with the permission core. Nothing was changed.",
};

export const roleErrorMessage = (e: RoleError): string =>
  e.code === "has_upcoming_appointments" && typeof e.count === "number" && e.count > 0
    ? `That practitioner still has ${e.count} upcoming appointment${e.count === 1 ? "" : "s"}. Move or cancel ${e.count === 1 ? "it" : "them"} first. Nothing was changed.`
    : MESSAGES[e.code];

/** Codes that point at one row. The page keeps the draft, opens that role and shows the message on the row. */
export const isRowError = (e: RoleError): e is RoleError & { key: string } =>
  e.key !== undefined &&
  (["unknown_key", "fixed_key", "not_offered", "scope_not_allowed", "prerequisite_unmet", "gate_unmet", "not_enforced", "widening_not_yet"] as const).includes(
    e.code as never,
  );
