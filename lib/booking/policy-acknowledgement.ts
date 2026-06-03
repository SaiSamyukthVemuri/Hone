import "server-only";
import { createHash } from "crypto";

// PR #133. hasAnyPolicy is the shared predicate the cancel +
// reschedule pages AND the server actions both call. "Studio has a
// policy" means at least one of the two policy fields is a non-
// whitespace string; empty + null + whitespace-only all collapse to
// false, mirroring the rule PublicPolicyReminderCard already uses
// to decide whether to render. The page (Server Component) imports
// this to derive a boolean prop for the (client) form; the action
// imports this to derive the ack-required gate from the server-
// resolved studio row. The form itself does not import this module
// (no Node crypto in a client bundle); the form receives a primitive
// boolean prop and renders accordingly.
export function hasAnyPolicy(input: {
  cancellationPolicyText: string | null | undefined;
  noShowPolicyText: string | null | undefined;
}): boolean {
  const c = (input.cancellationPolicyText ?? "").trim();
  const n = (input.noShowPolicyText ?? "").trim();
  return c.length > 0 || n.length > 0;
}

// PR #132. Shared helper for the appointment policy acknowledgement
// rows written by the cancel and reschedule server actions. Lives in
// lib/booking so both surfaces import the same canonical hash
// function; mismatched implementations would cause a future "did the
// policy change?" verification to surface false positives.
//
// The hash is SHA-256 hex over the canonical concatenation:
//
//   <cancellation_policy_text_snapshot>
//   \n---\n
//   <no_show_policy_text_snapshot>
//
// Both snapshots are normalized to a non-null string before hashing
// so an unset studio policy (null in studios.cancellation_policy_text)
// hashes the same as an empty-string policy. The result is a stable
// 64-char lowercase hex string; the DB CHECK
// (appointment_policy_acknowledgements_hash_check) only requires non-
// empty, but the migration comment documents the format.

export type PolicySnapshotInput = {
  cancellationPolicyText: string | null | undefined;
  noShowPolicyText: string | null | undefined;
};

export type PolicySnapshot = {
  cancellationPolicyTextSnapshot: string;
  noShowPolicyTextSnapshot: string;
  policySnapshotHash: string;
};

// Build the snapshot fields + hash from the studio-resolved policy
// text. Inputs are coerced to strings so a missing field hashes
// deterministically. We deliberately do NOT trim or otherwise
// normalize whitespace beyond the null-coalesce because the snapshot
// must capture exactly what the policy column contains at
// acknowledgement time; downstream rendering already trims for
// display.
export function buildPolicySnapshot(
  input: PolicySnapshotInput,
): PolicySnapshot {
  const cancellationPolicyTextSnapshot = input.cancellationPolicyText ?? "";
  const noShowPolicyTextSnapshot = input.noShowPolicyText ?? "";
  const canonical = `${cancellationPolicyTextSnapshot}\n---\n${noShowPolicyTextSnapshot}`;
  const policySnapshotHash = createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex");
  return {
    cancellationPolicyTextSnapshot,
    noShowPolicyTextSnapshot,
    policySnapshotHash,
  };
}
