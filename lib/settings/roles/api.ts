import type { Role } from "@/lib/permissions/catalog";
import type { RoleDiff } from "./diff";

// The contract between the Roles page and the permission core (R1), agreed with Team 3 Nov (general/ROLES-R1-INTERFACE-REPLY-20261103.md).
// Types and pure helpers only, so the client editor, the server actions and the tests share one shape. The DB computes every preview
// and every refusal; the page never recomputes a diff and never decides whether a save is valid.

/** Refusal codes the permission core returns. `unavailable` is the page's own: the core is not on yet, nothing was attempted. */
export const ROLE_ERROR_CODES = [
  "stale_version",
  "refused",
  "unknown_key",
  "fixed_key",
  "not_offered",
  "scope_not_allowed",
  "prerequisite_unmet",
  "gate_unmet",
  "sensitive_unconfirmed",
  "reason_required",
  "nothing_changed",
  "unavailable",
] as const;
export type RoleErrorCode = (typeof ROLE_ERROR_CODES)[number];

/** `key` and `role` are present on the per-key refusals so the message lands on the row; `currentVersion` on `stale_version`. */
export type RoleError = { code: RoleErrorCode; key?: string; role?: Role; currentVersion?: number };

export type PersonRef = { id: string; name: string; state: "active" | "invited" | "deactivated" };

export type RolePreview = { role: Role; diff: RoleDiff; people: PersonRef[]; count: number };

/** What every preview returns: the diff per role AND the policy version it was computed against. A save binds to that version. */
export type ServerPreview = { version: number; roles: RolePreview[] };

export type PreviewResult = { ok: true; preview: ServerPreview } | { ok: false; error: RoleError };
export type CommandResult = { ok: true; newVersion: number } | { ok: false; error: RoleError };

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
  sensitive_unconfirmed: "Confirm that you understand the newly enabled financial or sensitive access, then save again.",
  reason_required: "Say why you are making this change.",
  nothing_changed: "There is nothing to save. Your choices match what is already saved.",
  unavailable: "Saving role changes turns on with the permission core. Nothing was changed.",
};

export const roleErrorMessage = (e: RoleError): string => MESSAGES[e.code];

/** Codes that point at one row. The page keeps the draft, opens that role and shows the message on the row. */
export const isRowError = (e: RoleError): e is RoleError & { key: string } =>
  e.key !== undefined &&
  (["unknown_key", "fixed_key", "not_offered", "scope_not_allowed", "prerequisite_unmet", "gate_unmet"] as const).includes(
    e.code as never,
  );
