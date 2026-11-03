import "server-only";

import type { Role, StudioPolicy } from "@/lib/permissions/catalog";
import { coreGetState } from "./core";

// Where the Roles page gets a studio's policy: the permission core's get_role_permissions (0287), as the signed-in owner. The core
// returns the stored choices, the studio's basis and the version a save must bind to. If the core cannot be read the page falls
// back to today's APPROVED snapshot, marked not reviewed and not writable, so it still shows the truth and cannot save.

export type StudioPolicyState = {
  policies: Record<Role, StudioPolicy>;
  // The owner has adopted new defaults or saved a custom configuration. False keeps the review banner up (C.6).
  reviewed: boolean;
  // Policy version; 0 before any row exists. A write binds to the version a PREVIEW returned, not to this one.
  version: number;
  writable: boolean;
  notWritableReason: string | null;
};

export const NOT_WRITABLE_REASON =
  "The permission core could not be read, so this page shows the approved access for each role and cannot save. Reload to try again.";

const snapshot = (): StudioPolicy => ({ basis: "existing_snapshot", values: {}, gates: {} });

export async function loadStudioPolicyState(studioId: string): Promise<StudioPolicyState> {
  const state = await coreGetState(studioId);
  if (!state) {
    return {
      policies: { practitioner: snapshot(), receptionist: snapshot() },
      reviewed: false,
      version: 0,
      writable: false,
      notWritableReason: NOT_WRITABLE_REASON,
    };
  }
  return { policies: state.policies, reviewed: state.reviewed, version: state.version, writable: true, notWritableReason: null };
}
