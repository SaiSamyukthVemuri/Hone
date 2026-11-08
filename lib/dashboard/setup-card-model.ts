import type {
  NewClientBlocker,
  NewClientBlockerKey,
  NewClientReadiness,
} from "@/lib/booking/new-client-readiness";
import { isLaunchComplete, type LaunchStudioFacts } from "@/lib/settings/launch-completion";

// ===========================================================================
// The owner's setup card: which of FIVE states the studio is in.
// ===========================================================================
//
// PURE. Reads nothing; takes the canonical readiness verdict and the studio
// facts the page already holds. It adds no flag and no column.
//
//   hidden           nothing to show: every launch requirement is satisfied
//   incomplete       at least one structural requirement is missing
//   paused_by_owner  the ONLY thing between this studio and "ready" is the
//                    owner's own admission choice (not accepting new clients,
//                    or waitlist instead of booking). That is not unfinished
//                    setup and must not be presented as a to-do.
//   finish_launch    booking is ready, but the launch checklist still has
//                    items (confirmation emails, aftercare text, policies)
//   unknown          an authority could not be read; nobody has evidence either way
//
// Non-owners get `hidden`: setup is owner-only.

// Blockers that are a deliberate admission CHOICE, not a missing setup step.
const OWNER_CHOICE_KEYS: ReadonlySet<NewClientBlockerKey> = new Set([
  "admission_closed",
  "wait_admission",
]);

export type SetupCardState =
  | { kind: "hidden" }
  | {
      kind: "incomplete";
      remaining: number;
      next: NewClientBlocker | null;
      // True when a read failed, so `remaining` is a lower bound.
      listMayBeIncomplete: boolean;
    }
  | { kind: "paused_by_owner"; choices: NewClientBlocker[] }
  | { kind: "finish_launch" }
  | { kind: "unknown" };

export function buildSetupCardState(input: {
  isOwner: boolean;
  readiness: NewClientReadiness | null;
  studio: LaunchStudioFacts;
}): SetupCardState {
  const { isOwner, readiness, studio } = input;
  if (!isOwner || !readiness) return { kind: "hidden" };

  if (readiness.status === "unknown") return { kind: "unknown" };

  if (readiness.status === "not_ready") {
    const structural = readiness.blockers.filter((b) => !OWNER_CHOICE_KEYS.has(b.key));
    const choices = readiness.blockers.filter((b) => OWNER_CHOICE_KEYS.has(b.key));
    if (structural.length > 0 || readiness.unavailable.length > 0) {
      return {
        kind: "incomplete",
        remaining: structural.length,
        next: structural[0] ?? readiness.nextStep,
        listMayBeIncomplete: readiness.unavailable.length > 0,
      };
    }
    return { kind: "paused_by_owner", choices };
  }

  return isLaunchComplete(readiness, studio) ? { kind: "hidden" } : { kind: "finish_launch" };
}
