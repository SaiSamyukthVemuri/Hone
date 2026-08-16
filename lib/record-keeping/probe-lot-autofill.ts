import {
  activeProbeLotOptionsForProbe,
  isCurrentStock,
  probeLotOptionsForProbe,
  resolveInventoryAutofill,
  type ProbeLotOption,
} from "@/lib/record-keeping/probe-lot-inventory";
import {
  resolveProbeLotSuggestion,
  type ProbeLotSuggestions,
} from "@/lib/record-keeping/probe-lot-suggestion";

// THE probe-lot auto-fill rule for the charting form (Chloe: "when I pick a
// probe the lot should already be there").
//
// WHY THIS MODULE EXISTS
// ----------------------
// Every piece needed for this already shipped, but the two halves were never
// joined:
//
//   * `resolveInventoryAutofill` (migration 0155) resolves an ACTIVE INVENTORY
//     lot for the selected probe. The charting form calls it.
//   * `resolveProbeLotSuggestion` resolves the most recent RECORDED lot for the
//     selected probe: exact `probe_key` first, normalized display-label second
//     for legacy rows with a null key. It is exported and unit-tested, and no
//     application code has ever called it. The form imports its module for the
//     TYPE only.
//
// So when a studio had no probe inventory, `resolveInventoryAutofill` returned
// `choose`, the form CLEARED the lot field, and the picker rendered "No active
// inventory lot for this probe. Type the lot/batch manually…", every single
// appointment, even for a probe whose lot the practitioner had already charted
// many times. Willow is exactly that shape: zero probe inventory rows, but four
// distinct probes with recorded lots across 21 rows, none inventory-linked.
//
// This module joins them in one place, so the precedence is stated once and is
// unit-testable without a DOM or a database.
//
// PRECEDENCE (highest first):
//   1. `last-confirmed`, the practitioner's last CONFIRMED, INVENTORY-LINKED
//      lot, when it is still active and matches the selected probe.
//   2. `only-active`   , exactly one active inventory lot for this probe.
//   3. `choose`        , MORE THAN ONE active inventory lot. Never guess;
//      the form shows the selector. (Note: `resolveInventoryAutofill` collapses
//      "none" and "many" into `choose`; this module separates them, which is
//      what makes the history fallback reachable at all.)
//   4. `from-history`  , no active inventory, but a recorded lot exists for
//      this probe. Fills the NUMBER only: never an inventory link, never
//      auto-confirmed, because nothing was scanned off a package today. Uses
//      `lastCharted` (recency ONLY), NOT `lot`, which is confirmed-first and
//      would pin one old confirmed row forever, since auto-fill never confirms.
//      A number matching an inventory lot that is not CURRENT STOCK — expired,
//      or discarded (0182) — is refused here and falls to `choose`: the server
//      only enforces those rules on the LINKED path, so auto-filling it as free
//      text would route around them entirely.
//   5. `none`          , nothing known. Leave the field blank for manual entry.
//
// Studio isolation and probe matching are enforced upstream: `options` are
// already studio-scoped and probe-filtered, and `suggestions` are built from a
// studio-scoped query. This module never widens either.

export type ProbeLotAutofillResult =
  // Inventory-backed: carries a durable inventory link.
  | { kind: "last-confirmed"; option: ProbeLotOption }
  | { kind: "only-active"; option: ProbeLotOption }
  // Ambiguous inventory: the practitioner picks. Nothing is filled.
  | { kind: "choose" }
  // History-backed: a lot NUMBER only, never a link, never confirmed.
  | { kind: "from-history"; lotNumber: string }
  // Nothing known.
  | { kind: "none" };

// Lot numbers are transcribed off packaging, so compare them the way a human
// reads them: case- and surrounding-whitespace-insensitively.
function sameLot(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function resolveProbeLotAutofill(args: {
  probeKey: string;
  inventory: ReadonlyArray<ProbeLotOption>;
  suggestions: ProbeLotSuggestions;
}): ProbeLotAutofillResult {
  const { probeKey, inventory, suggestions } = args;
  if (!probeKey.trim()) return { kind: "none" };

  const active = activeProbeLotOptionsForProbe(inventory, probeKey);

  // 1-3: inventory wins whenever it has anything to say. Only a CONFIRMED +
  // LINKED prior selection may bias which active lot is chosen, so a newer
  // confirmed MANUAL row can never mask an older confirmed LINKED one.
  if (active.length > 0) {
    const suggestion = resolveProbeLotSuggestion(probeKey, suggestions);
    const inv = resolveInventoryAutofill(
      inventory,
      probeKey,
      suggestion?.lastConfirmedInventoryItemId ?? null,
    );
    if (inv.kind === "choose") return { kind: "choose" }; // >1 active, ambiguous
    return inv;
  }

  // 4: no active inventory: fall back to what the practitioner actually
  // charted for THIS probe. Exact key first, normalized label only for legacy
  // rows; `resolveProbeLotSuggestion` owns that and never crosses studios.
  const suggestion = resolveProbeLotSuggestion(probeKey, suggestions);
  const lot = (suggestion?.lastCharted ?? "").trim();
  if (lot) {
    // The studio DOES stock this probe, but no lot is usable now, and the last
    // one charted is one of them. Auto-filling it as free text would bypass the
    // server's linked-path gate (which only runs on the linked path) and hide
    // the reason from her entirely. Send her to the picker, where the lot still
    // appears, flagged, and can only be recorded by confirming it.
    //
    // Migration 0182 — this covers DISCARDED as well as EXPIRED, and the discard
    // case is the sharper one. Chloe threw the box away; if the number were
    // auto-filled as free text she would be handed back the exact lot she just
    // discarded, unlinked and unflagged, which is the original complaint wearing
    // a different hat. Both states mean "not usable now", so both route to the
    // picker rather than into the field.
    //
    // Guard 1 — BY PROBE + LOT NUMBER. Unchanged pre-existing behaviour, now
    // reading `!isCurrentStock` so it covers discarded as well as expired. It
    // stays scoped to THIS probe deliberately: lot numbers are explicitly not
    // unique, and another probe's same-numbered lot must never block this
    // probe's history (pinned by "an expired lot for ANOTHER probe never blocks
    // this probe's history").
    const notCurrentForProbe = probeLotOptionsForProbe(inventory, probeKey).some(
      (o) => !isCurrentStock(o) && sameLot(o.lotNumber, lot),
    );
    if (notCurrentForProbe) return { kind: "choose" };

    // Guard 2 — BY IDENTITY. Guard 1 matches on the row's CURRENT probe
    // classification, so it misses an item charted under probe P and later
    // RECLASSIFIED to Q: the suggestion still truthfully reports the lot under
    // the historical probe P, but the row is no longer in P's option list, and
    // the discarded lot auto-filled as unlinked free text.
    //
    // Reclassifying a box does not put it back on the shelf. The lot NUMBER
    // cannot answer this (see Guard 1's uniqueness note), so the check is by
    // the inventory id the charted row actually pointed at — the only value
    // that identifies the physical item. Null id = a manual/free-text row,
    // which was never inventory and so has no lifecycle to check.
    const chartedId = (suggestion?.lastChartedInventoryItemId ?? "").trim();
    if (chartedId) {
      const chartedItem = inventory.find((o) => o.id === chartedId);
      if (chartedItem && !isCurrentStock(chartedItem)) return { kind: "choose" };
    }
    return { kind: "from-history", lotNumber: lot };
  }

  // 5.
  return { kind: "none" };
}

// The draft patch a result implies. Returning this (rather than letting the
// component branch) keeps the two invariants that matter in ONE place:
//   * an inventory link is set ONLY for a real inventory selection;
//   * auto-fill NEVER marks a lot confirmed: confirmation means the
//     practitioner checked the physical package, which no resolver can do.
export type ProbeLotDraftPatch = {
  probeLotNumber: string;
  probeInventoryItemId: string | null;
  probeLotConfirmed: false;
};

export function probeLotDraftPatch(
  result: ProbeLotAutofillResult,
): ProbeLotDraftPatch {
  switch (result.kind) {
    case "last-confirmed":
    case "only-active":
      return {
        probeLotNumber: result.option.lotNumber,
        probeInventoryItemId: result.option.id,
        probeLotConfirmed: false,
      };
    case "from-history":
      return {
        // History is a NUMBER, not an inventory row. Linking it would fabricate
        // traceability to a package this studio may no longer hold.
        probeLotNumber: result.lotNumber,
        probeInventoryItemId: null,
        probeLotConfirmed: false,
      };
    case "choose":
    case "none":
    default:
      return {
        probeLotNumber: "",
        probeInventoryItemId: null,
        probeLotConfirmed: false,
      };
  }
}

// Practitioner-facing provenance for the resolved value. The three inventory
// strings are the SHIPPED copy, moved here verbatim so the string and the branch
// that produces it can no longer drift apart; only `from-history` is new.
export function probeLotSourceMessage(
  kind: ProbeLotAutofillResult["kind"],
): string | null {
  switch (kind) {
    case "last-confirmed":
      return "Auto-filled from your last confirmed inventory lot. Confirm the package.";
    case "only-active":
      return "Only active inventory lot for this probe. Confirm the package.";
    case "choose":
      return "Choose the lot/batch from inventory.";
    case "from-history":
      // Truthful about BOTH facts that matter clinically: where it came from,
      // and that it carries no inventory traceability.
      return "Auto-filled from your last charted lot for this probe, not linked to inventory. Check the package.";
    case "none":
    default:
      return null;
  }
}
