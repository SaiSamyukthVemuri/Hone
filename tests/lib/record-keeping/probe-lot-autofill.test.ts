import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  probeLotDraftPatch,
  probeLotSourceMessage,
  resolveProbeLotAutofill,
} from "@/lib/record-keeping/probe-lot-autofill";
import { buildProbeLotOptions } from "@/lib/record-keeping/probe-lot-inventory";
import {
  normalizeProbeLabel,
  type ProbeLotSuggestion,
  type ProbeLotSuggestions,
} from "@/lib/record-keeping/probe-lot-suggestion";
import { PROBE_OPTIONS } from "@/lib/probes";

// Probe-lot auto-fill precedence (Chloe: "when I pick a probe the lot should
// already be there").
//
// THE DEFECT THIS PINS. Auto-fill considered ACTIVE INVENTORY ONLY. A studio
// with no probe inventory got `choose` on every probe pick, the lot field was
// CLEARED, and the picker rendered "No active inventory lot for this probe.
// Type the lot/batch manually…" — even for a probe whose lot had been charted
// many times. `resolveProbeLotSuggestion` resolved exactly that history, was
// exported and unit-tested, and was never called by any application code.
//
// Production shape that made it bite every appointment: zero probe inventory
// rows, four distinct probes with recorded lots across 21 rows, none linked.

const probe = PROBE_OPTIONS[0];
const other = PROBE_OPTIONS.find((p) => p.key !== probe.key)!;

const NO_SUGGESTIONS: ProbeLotSuggestions = { byKey: {}, byLabel: {} };

// `lot` is the DISPLAY winner (confirmed-first); `lastCharted` is recency-only.
// They default to the same value so a test that cares about neither reads
// naturally, and a test that cares about the difference sets them apart.
function suggestion(
  over: Partial<ProbeLotSuggestion> = {},
): ProbeLotSuggestion {
  const lot = over.lot ?? "HISTLOT";
  return {
    lot,
    confirmed: false,
    inventoryItemId: null,
    lastConfirmedInventoryItemId: null,
    lastCharted: lot,
    ...over,
  };
}

function byKey(key: string, over: Partial<ProbeLotSuggestion> = {}): ProbeLotSuggestions {
  return { byKey: { [key]: suggestion(over) }, byLabel: {} };
}

// A fixed "today" keeps expiry classification deterministic — the suite must
// not start failing on a calendar boundary.
const TODAY = "2026-07-31";
const FUTURE = "2099-01-01";
const PAST = "2000-01-01";

function inv(rows: Array<{ id: string; lot: string; probeKey: string; expiry?: string | null }>) {
  return buildProbeLotOptions(
    rows.map((r) => ({
      id: r.id,
      lotNumber: r.lot,
      probeKey: r.probeKey,
      itemDescription: "Sterex Gold F3",
      manufacturerName: "Sterex",
      expiryDate: r.expiry === undefined ? null : r.expiry,
    })),
    TODAY,
  );
}

describe("precedence 1-2 — inventory wins and carries a link", () => {
  it("exactly one active matching lot auto-fills AND links it", () => {
    const r = resolveProbeLotAutofill({
      probeKey: probe.key,
      inventory: inv([{ id: "i1", lot: "A1", probeKey: probe.key, expiry: FUTURE }]),
      suggestions: NO_SUGGESTIONS,
    });
    expect(r.kind).toBe("only-active");
    expect(probeLotDraftPatch(r)).toEqual({
      probeLotNumber: "A1",
      probeInventoryItemId: "i1",
      probeLotConfirmed: false,
    });
  });

  it("the last CONFIRMED + LINKED lot wins over another active lot", () => {
    const r = resolveProbeLotAutofill({
      probeKey: probe.key,
      inventory: inv([
        { id: "i1", lot: "A1", probeKey: probe.key, expiry: FUTURE },
        { id: "i2", lot: "A2", probeKey: probe.key, expiry: FUTURE },
      ]),
      suggestions: byKey(probe.key, { lastConfirmedInventoryItemId: "i2" }),
    });
    expect(r.kind).toBe("last-confirmed");
    expect(probeLotDraftPatch(r).probeInventoryItemId).toBe("i2");
  });

  it("auto-fill NEVER marks the lot confirmed", () => {
    for (const r of [
      resolveProbeLotAutofill({ probeKey: probe.key, inventory: inv([{ id: "i1", lot: "A1", probeKey: probe.key, expiry: FUTURE }]), suggestions: NO_SUGGESTIONS }),
      resolveProbeLotAutofill({ probeKey: probe.key, inventory: [], suggestions: byKey(probe.key, { confirmed: true }) }),
    ]) {
      expect(probeLotDraftPatch(r).probeLotConfirmed).toBe(false);
    }
  });
});

describe("precedence 3 — ambiguous inventory is never guessed", () => {
  it("more than one active lot returns choose and fills NOTHING", () => {
    const r = resolveProbeLotAutofill({
      probeKey: probe.key,
      inventory: inv([
        { id: "i1", lot: "A1", probeKey: probe.key, expiry: FUTURE },
        { id: "i2", lot: "A2", probeKey: probe.key, expiry: FUTURE },
      ]),
      suggestions: NO_SUGGESTIONS,
    });
    expect(r.kind).toBe("choose");
    expect(probeLotDraftPatch(r)).toEqual({
      probeLotNumber: "",
      probeInventoryItemId: null,
      probeLotConfirmed: false,
    });
  });

  it("ambiguous inventory is NOT silently replaced by history", () => {
    const r = resolveProbeLotAutofill({
      probeKey: probe.key,
      inventory: inv([
        { id: "i1", lot: "A1", probeKey: probe.key, expiry: FUTURE },
        { id: "i2", lot: "A2", probeKey: probe.key, expiry: FUTURE },
      ]),
      suggestions: byKey(probe.key, { lot: "HISTLOT" }),
    });
    expect(r.kind).toBe("choose");
  });
});

describe("precedence 4 — THE FIX: recent charting fills when inventory has nothing", () => {
  it("zero inventory + a recorded exact-key lot fills the NUMBER, with no link", () => {
    const r = resolveProbeLotAutofill({
      probeKey: probe.key,
      inventory: [],
      suggestions: byKey(probe.key, { lot: "460941" }),
    });
    expect(r).toEqual({ kind: "from-history", lotNumber: "460941" });
    expect(probeLotDraftPatch(r)).toEqual({
      probeLotNumber: "460941",
      // A history lot must NEVER fabricate an inventory link.
      probeInventoryItemId: null,
      probeLotConfirmed: false,
    });
  });

  it("EXPIRED-only inventory falls through to history for a DIFFERENT lot number", () => {
    const r = resolveProbeLotAutofill({
      probeKey: probe.key,
      inventory: inv([{ id: "i1", lot: "OLD", probeKey: probe.key, expiry: PAST }]),
      suggestions: byKey(probe.key, { lot: "460941" }),
    });
    expect(r).toEqual({ kind: "from-history", lotNumber: "460941" });
  });

  // Review finding (P2): the server enforces the expired-lot rule ONLY on the
  // inventory-LINKED path, so auto-filling an expired lot as free text would
  // route around it and hide the expiry. Send her to the picker instead, where
  // the lot appears flagged Expired and can only be recorded by confirming it.
  it("refuses to auto-fill a history lot that IS a known-expired inventory lot", () => {
    const r = resolveProbeLotAutofill({
      probeKey: probe.key,
      inventory: inv([{ id: "i1", lot: "460941", probeKey: probe.key, expiry: PAST }]),
      suggestions: byKey(probe.key, { lot: "460941" }),
    });
    expect(r).toEqual({ kind: "choose" });
    expect(probeLotDraftPatch(r).probeLotNumber).toBe("");
  });

  it("matches the expired lot the way a human reads a package (case/space-insensitive)", () => {
    const r = resolveProbeLotAutofill({
      probeKey: probe.key,
      inventory: inv([{ id: "i1", lot: "  ab-4609  ", probeKey: probe.key, expiry: PAST }]),
      suggestions: byKey(probe.key, { lot: "AB-4609" }),
    });
    expect(r).toEqual({ kind: "choose" });
  });

  it("an expired lot for ANOTHER probe never blocks this probe's history", () => {
    const r = resolveProbeLotAutofill({
      probeKey: probe.key,
      inventory: inv([{ id: "i1", lot: "460941", probeKey: other.key, expiry: PAST }]),
      suggestions: byKey(probe.key, { lot: "460941" }),
    });
    expect(r).toEqual({ kind: "from-history", lotNumber: "460941" });
  });

  it("legacy label fallback works when the recorded row had no probe_key", () => {
    const r = resolveProbeLotAutofill({
      probeKey: probe.key,
      inventory: [],
      suggestions: {
        byKey: {},
        byLabel: { [normalizeProbeLabel(probe.displayLabel)]: suggestion({ lot: "LEGACY1" }) },
      },
    });
    expect(r).toEqual({ kind: "from-history", lotNumber: "LEGACY1" });
  });

  it("an exact key match beats the label fallback", () => {
    const r = resolveProbeLotAutofill({
      probeKey: probe.key,
      inventory: [],
      suggestions: {
        byKey: { [probe.key]: suggestion({ lot: "KEYLOT" }) },
        byLabel: { [normalizeProbeLabel(probe.displayLabel)]: suggestion({ lot: "LABELLOT" }) },
      },
    });
    expect(r).toEqual({ kind: "from-history", lotNumber: "KEYLOT" });
  });

  it("a blank/whitespace recorded lot is not offered", () => {
    expect(
      resolveProbeLotAutofill({ probeKey: probe.key, inventory: [], suggestions: byKey(probe.key, { lot: "   " }) }).kind,
    ).toBe("none");
  });
});

describe("precedence 5 — nothing known", () => {
  it("no inventory and no history leaves the field blank", () => {
    const r = resolveProbeLotAutofill({ probeKey: probe.key, inventory: [], suggestions: NO_SUGGESTIONS });
    expect(r.kind).toBe("none");
    expect(probeLotDraftPatch(r).probeLotNumber).toBe("");
  });

  it("an empty probe key resolves to none", () => {
    expect(resolveProbeLotAutofill({ probeKey: "", inventory: [], suggestions: byKey(probe.key) }).kind).toBe("none");
    expect(resolveProbeLotAutofill({ probeKey: "   ", inventory: [], suggestions: byKey(probe.key) }).kind).toBe("none");
  });
});

describe("matching never widens", () => {
  it("a DIFFERENT probe's inventory lot is never used", () => {
    const r = resolveProbeLotAutofill({
      probeKey: probe.key,
      inventory: inv([{ id: "i1", lot: "OTHER", probeKey: other.key, expiry: FUTURE }]),
      suggestions: NO_SUGGESTIONS,
    });
    expect(r.kind).toBe("none");
  });

  it("a DIFFERENT probe's recorded lot is never used", () => {
    const r = resolveProbeLotAutofill({
      probeKey: probe.key,
      inventory: [],
      suggestions: byKey(other.key, { lot: "OTHERLOT" }),
    });
    expect(r.kind).toBe("none");
  });

  it("changing the probe resolves a different lot", () => {
    const suggestions: ProbeLotSuggestions = {
      byKey: { [probe.key]: suggestion({ lot: "FIRST" }), [other.key]: suggestion({ lot: "SECOND" }) },
      byLabel: {},
    };
    expect(resolveProbeLotAutofill({ probeKey: probe.key, inventory: [], suggestions })).toEqual({ kind: "from-history", lotNumber: "FIRST" });
    expect(resolveProbeLotAutofill({ probeKey: other.key, inventory: [], suggestions })).toEqual({ kind: "from-history", lotNumber: "SECOND" });
  });
});

// Review finding (P1): `lot` is the confirmed-first DISPLAY winner. Auto-fill
// never confirms, so using it would let ONE old confirmed row pin the field
// forever while every newer charted lot stayed unconfirmed — she would keep
// retyping, which is the complaint this PR exists to fix.
describe("history uses RECENCY (lastCharted), not the confirmed-first display winner", () => {
  it("fills the most recently charted lot even when an older lot was the confirmed one", () => {
    const r = resolveProbeLotAutofill({
      probeKey: probe.key,
      inventory: [],
      suggestions: byKey(probe.key, {
        lot: "OLD-CONFIRMED",
        confirmed: true,
        lastCharted: "NEW-9",
      }),
    });
    expect(r).toEqual({ kind: "from-history", lotNumber: "NEW-9" });
  });

  it("falls back to nothing when only a display winner exists with no charted value", () => {
    const r = resolveProbeLotAutofill({
      probeKey: probe.key,
      inventory: [],
      suggestions: byKey(probe.key, { lot: "SOMETHING", lastCharted: "" }),
    });
    expect(r).toEqual({ kind: "none" });
  });
});

describe("provenance copy is truthful", () => {
  it("names inventory vs recent charting, and never claims a link for history", () => {
    // The three inventory strings are the SHIPPED copy, unchanged.
    expect(probeLotSourceMessage("only-active")).toBe(
      "Only active inventory lot for this probe. Confirm the package.",
    );
    expect(probeLotSourceMessage("last-confirmed")).toBe(
      "Auto-filled from your last confirmed inventory lot. Confirm the package.",
    );
    // Only the history string is new — and it must never imply inventory.
    expect(probeLotSourceMessage("from-history")).toMatch(/last charted lot for this probe/);
    expect(probeLotSourceMessage("from-history")).toMatch(/not linked to inventory/);
    expect(probeLotSourceMessage("from-history")).not.toMatch(/^Auto-filled from your last confirmed inventory/);
    expect(probeLotSourceMessage("choose")).toMatch(/Choose/i);
    expect(probeLotSourceMessage("none")).toBeNull();
  });
});

describe("form wiring — provenance is PER PROBE, not a global latch", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  const FORM = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");

  it("the effect exits while the SAME probe is selected (so a typed/copied value survives re-renders)", () => {
    expect(FORM).toMatch(/if \(draft\.probeKey === lotOwnerProbeKey\) return;/);
  });

  it("a probe CHANGE always re-resolves — there is no manual latch that can survive it", () => {
    // The old global `lotEditedManually` boolean latched true on the first
    // keystroke and never cleared, so one probe's lot stayed attached to the
    // next probe she selected. It is gone entirely.
    expect(FORM).not.toMatch(/lotEditedManually/);
    const guard = "if (draft.probeKey === lotOwnerProbeKey) return;";
    const start = FORM.indexOf(guard) + guard.length;
    const body = FORM.slice(start, FORM.indexOf("}, [draft.probeKey", start));
    // Nothing between the same-probe guard and the resolve can skip the resolve.
    expect(body).not.toMatch(/\breturn;/);
    expect(body).toMatch(/resolveProbeLotAutofill\(\{/);
    expect(body).toMatch(/setLotOwnerProbeKey\(draft\.probeKey\);/);
    expect(body).toMatch(/const patch = probeLotDraftPatch\(result\);/);
  });

  it("every value-setting path binds the value to the probe selected at that moment", () => {
    // Typed, and explicitly picked from inventory.
    const binds = FORM.match(/setLotOwnerProbeKey\(draft\.probeKey\);/g) ?? [];
    expect(binds.length).toBeGreaterThanOrEqual(2);
    // Copied — bound to the COPIED probe, not the one previously selected.
    expect(FORM).toMatch(/setLotOwnerProbeKey\(patch\.probeKey\);/);
  });

  it("a cleared manual field drops the provenance line instead of claiming 'choose'", () => {
    expect(FORM).toMatch(/setLotStatus\(value\.trim\(\) !== "" \? "manual" : null\)/);
  });
});

describe("copy workflows carry the EXACT lot with the probe", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  const FORM = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");
  const SNAP = read("lib/sessions/treatment-setup-snapshot.ts");

  it("the reusable setup snapshot now carries the lot + link, never a confirmation", () => {
    // Copying the probe WITHOUT its lot left the destination with a probe whose
    // lot then auto-resolved from unrelated history — silently swapping a
    // traceability value the practitioner believed she had copied.
    expect(SNAP).toMatch(/"probe_lot_number",/);
    expect(SNAP).toMatch(/"probe_inventory_item_id",/);
    expect(SNAP).toMatch(/probeLotNumber: \(block\.probe_lot_number \?\? ""\)\.trim\(\),/);
    expect(SNAP).toMatch(/probeLotConfirmed: false,/);
    expect(SNAP).not.toMatch(/probeLotConfirmed: true/);
  });

  it("a copied inventory LINK is kept only when the item is still linkable for the copied probe", () => {
    expect(SNAP).toMatch(/function resolveCopiedInventoryLink\(/);
    expect(SNAP).toMatch(/return linkable\.has\(sourceItemId\) \? sourceItemId : null;/);
    // No linkable set supplied → lot NUMBER only, link dropped (safe default).
    expect(SNAP).toMatch(/if \(!linkable\) return null;/);
  });

  it("the form supplies only ACTIVE lots for the COPIED probe as linkable", () => {
    expect(FORM).toMatch(/activeProbeLotOptionsForProbe\(\s*probeLotInventory,\s*source\.probe_key \?\? "",\s*\)/);
    expect(FORM).toMatch(/buildTreatmentSetupDraftPatch\(source, firstEntry, linkable\)/);
  });

  it("a copied lot is bound to the copied probe, so the resolver cannot overwrite it", () => {
    expect(FORM).toMatch(/setLotOwnerProbeKey\(patch\.probeKey\);/);
    expect(FORM).toMatch(/setLotStatus\(patch\.probeLotNumber\.trim\(\) !== "" \? "copied" : null\)/);
  });

  it("'Add another pass' never touches the block's lot or inventory link", () => {
    // A pass is an electrolysis_entries row under the SAME block; the lot lives
    // on the block. The add-pass action must never update those columns.
    const ACTIONS = read("app/(app)/clients/[id]/sessions/[sessionId]/actions.ts");
    const start = ACTIONS.indexOf("export async function addElectrolysisEntryAction");
    expect(start).toBeGreaterThan(-1);
    // Strip comments: the action documents the legacy free-text lot in prose.
    const body = ACTIONS.slice(start, ACTIONS.indexOf("\nexport ", start + 10))
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(body).not.toMatch(/probe_lot_number/);
    expect(body).not.toMatch(/probe_inventory_item_id/);
    expect(body).not.toMatch(/probe_lot_confirmed/);
    // And it never issues an update against session_blocks at all.
    expect(body).not.toMatch(/from\("session_blocks"\)[\s\S]{0,200}\.update\(/);
  });
});
