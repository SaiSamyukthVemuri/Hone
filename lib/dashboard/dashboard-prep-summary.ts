import type { AppointmentPrepMemory } from "@/lib/sessions/appointment-prep-memory";
import { compactSummary } from "@/lib/dashboard/today-treatment-summary";

// ===========================================================================
// THE COMPACT PROJECTION — what the browser is allowed to receive up front
// ===========================================================================
//
// Deliberately small, and deliberately NOT a second clinical model: it is a
// projection of the existing `AppointmentPrepMemory`, built on the server and
// containing ONLY the values the collapsed row actually paints.
//
// The invariant it exists to make checkable: every field here is visible. If a
// field is not rendered in the collapsed state, it does not belong in this
// type, because anything in this type crosses to the browser before the
// practitioner has asked to see the visit.
//
// The full model stays server-side until an explicit disclosure, where the
// server re-resolves authority and returns it for ONE appointment.

export type DashboardPrepSummary = {
  /** There IS a previous treatment to open. Drives the disclosure control. */
  hasTreatment: boolean;
  /**
   * A read failed, or the batch window was truncated. NOT "no history" — the
   * distinction the charted-session authority exists to preserve.
   */
  unavailable: boolean;
  /** "12 Mar 2026 · electrolysis · chin, upper lip · 25 min". Rendered. */
  compactSummary: string | null;
  /**
   * The newest recorded "for next visit" note. Rendered off Today, where the
   * Before-Today model does not run and this is the only place it can appear.
   */
  remember: string | null;
};

/** Project the server-only model down to exactly what the row paints. */
export function toDashboardPrepSummary(args: {
  memory: AppointmentPrepMemory | null;
  unavailable: boolean;
  planNote: string | null;
}): DashboardPrepSummary {
  return {
    hasTreatment: args.memory !== null,
    unavailable: args.unavailable,
    compactSummary: args.memory ? compactSummary(args.memory) : null,
    remember: args.planNote,
  };
}
