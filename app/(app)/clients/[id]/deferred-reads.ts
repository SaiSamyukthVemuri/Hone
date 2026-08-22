import type { ProfileTab } from "@/components/profile-tab";

// ===========================================================================
// PERF2 deferred-read invariant — DEV AND TEST ONLY.
//
// #612 stopped loading every tab's data on every tab. A skipped read yields a
// NEUTRAL value — `null`, `[]`, a zeroed total — chosen so the consumer's
// existing empty state renders. That is what makes the optimization safe, and
// it is also its one real hazard: the neutral for NOT LOADED is by
// construction indistinguishable from LOADED AND EMPTY, so a tab whose gate
// stops covering it renders "nothing recorded" over data that exists.
//
// This is the check that tells those two apart. It does NOT inspect values —
// they are identical either way, which is the whole problem. It compares two
// things that were written independently:
//
//   * the TAB, as the JSX below switches on it, and
//   * the GATE that decided whether that tab's read ran.
//
// If a gate stops covering a tab that renders its data, those two disagree and
// this throws by name. Because the table is keyed by tab literal and its values
// are the gate flags themselves, editing a gate cannot quietly edit the
// expectation too.
//
// WHAT THIS IS NOT. It is not a completeness proof. It covers the gated reads
// listed by its caller; a gated read added later and not listed is not covered,
// and nothing here can detect that. The static completeness proof for this page
// was retired for failing to converge, and this deliberately does not attempt
// it again.
//
// Production is untouched: the export returns immediately, so no practitioner
// ever sees behaviour from this file.
// ===========================================================================

const ENABLED = process.env.NODE_ENV !== "production";

export class DeferredReadError extends Error {
  constructor(tab: string, reads: readonly string[]) {
    super(
      `Client Profile "${tab}" renders data whose read was deferred: ` +
        `${reads.join(", ")}. The tab would show an empty state over data ` +
        `that may exist. Widen the gate, or stop rendering it on this tab.`,
    );
    this.name = "DeferredReadError";
  }
}

/**
 * Assert that every read the active tab renders was actually loaded.
 *
 * `contract` maps a tab to the gates its own JSX depends on:
 *
 *   requireLoadedForTab(activeTab, {
 *     personal: { personalNotes: needsPersonalNotes },
 *   });
 *
 * Reads with no entry for the active tab are not this tab's business — a tab
 * absent from the table simply has nothing gated to check.
 *
 * Carries only read NAMES and the tab; never a client id, a name, or any
 * loaded value.
 */
export function requireLoadedForTab(
  activeTab: ProfileTab,
  contract: Partial<Record<ProfileTab, Record<string, boolean>>>,
): void {
  if (!ENABLED) return;
  const required = contract[activeTab];
  if (!required) return;
  const deferred = Object.keys(required).filter((name) => !required[name]);
  if (deferred.length > 0) throw new DeferredReadError(activeTab, deferred);
}
