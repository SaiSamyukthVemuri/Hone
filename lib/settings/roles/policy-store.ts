import "server-only";

import type { StudioPolicy } from "@/lib/permissions/catalog";

// Where the Roles page gets a studio's policy. The permission core (R1: the overrides table, the policy basis, the audit and the
// version token) is not in production yet, so until it is this returns today's APPROVED policy for every studio: the existing-
// studio snapshot with no overrides and no gate satisfied, marked not reviewed and not writable. The page therefore shows the
// truth (what staff can do today) and cannot save. When R1 lands this is the ONE function that changes; the page and the actions
// already read the shape below. Nothing here reads or writes the database.

export type StudioPolicyState = {
  policy: StudioPolicy;
  // The owner has adopted new defaults or saved a custom configuration. False keeps the review banner up (C.6).
  reviewed: boolean;
  // Policy version the save sends back so a stale edit is refused instead of overwriting a newer one. 0 before any row exists.
  version: number;
  // Saving needs R1's audited writer. False renders the controls as a read-only review and the save actions refuse.
  writable: boolean;
  notWritableReason: string | null;
};

export const NOT_WRITABLE_REASON =
  "Saving role changes turns on with the permission core. Until then this page shows the approved access for each role. Some of it is not enforced everywhere yet, and those rows say so.";

export async function loadStudioPolicyState(_studioId: string): Promise<StudioPolicyState> {
  return {
    policy: { basis: "existing_snapshot", values: {}, gates: {} },
    reviewed: false,
    version: 0,
    writable: false,
    notWritableReason: NOT_WRITABLE_REASON,
  };
}
