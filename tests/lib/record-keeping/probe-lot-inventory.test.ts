import { describe, expect, it } from "vitest";
import {
  buildProbeLotOptions,
  activeProbeLotOptionsForProbe,
  probeLotOptionsForProbe,
  filterProbeLotOptions,
  resolveInventoryAutofill,
  probeLotOptionLabel,
  PROBE_LOT_LABEL_DELIMITER,
  type ProbeLotInventoryRow,
} from "@/lib/record-keeping/probe-lot-inventory";

// Inventory-backed probe-lot options (Chloe item #9, migration 0155). Identity
// is the inventory row id; options are probe-specific via probe_key; expired
// lots stay selectable but never auto-fill.

const TODAY = "2026-07-13";
const F3 = "sterex-gold-two-piece-f3-short";
const F2 = "sterex-stainless-steel-two-piece-f2-short";

function row(over: Partial<ProbeLotInventoryRow> = {}): ProbeLotInventoryRow {
  return {
    id: over.id ?? "id-" + (over.lotNumber ?? "460941"),
    probeKey: F3,
    lotNumber: "460941",
    itemDescription: "Sterex Gold F3 probe",
    manufacturerName: "Sterex",
    expiryDate: "2026-12-01",
    ...over,
  };
}

describe("buildProbeLotOptions: one option per inventory row (NO dedupe by lot)", () => {
  it("(#14) two DIFFERENT inventory rows with the SAME lot number stay DISTINCT (by id)", () => {
    const opts = buildProbeLotOptions(
      [
        row({ id: "a", lotNumber: "LOT1", manufacturerName: "Sterex" }),
        row({ id: "b", lotNumber: "LOT1", manufacturerName: "Ballet", probeKey: F2 }),
      ],
      TODAY,
    );
    expect(opts).toHaveLength(2);
    expect(opts.map((o) => o.id).sort()).toEqual(["a", "b"]);
  });

  it("classifies expired by todayIso; a null expiry never expires; active sorts first", () => {
    const opts = buildProbeLotOptions(
      [
        row({ id: "old", lotNumber: "OLD", expiryDate: "2025-01-01" }),
        row({ id: "new", lotNumber: "NEW", expiryDate: "2026-12-01" }),
        row({ id: "none", lotNumber: "NONE", expiryDate: null }),
      ],
      TODAY,
    );
    expect(opts.find((o) => o.id === "old")?.isExpired).toBe(true);
    // active (NONE null-expiry, NEW) before expired (OLD)
    expect(opts[opts.length - 1].id).toBe("old");
    expect(opts.find((o) => o.id === "old")).toBeTruthy(); // expired NOT dropped
  });

  it("carries id + probeKey through and drops blank lot numbers", () => {
    const opts = buildProbeLotOptions(
      [row({ id: "x", lotNumber: "   " }), row({ id: "y", probeKey: F2 })],
      TODAY,
    );
    expect(opts).toHaveLength(1);
    expect(opts[0].id).toBe("y");
    expect(opts[0].probeKey).toBe(F2);
  });
});

describe("probe-specific selection (#7 other probe never appears)", () => {
  const opts = buildProbeLotOptions(
    [
      row({ id: "f3a", probeKey: F3, lotNumber: "AAA", expiryDate: "2026-12-01" }),
      row({ id: "f2a", probeKey: F2, lotNumber: "BBB", expiryDate: "2026-12-01" }),
      row({ id: "f3exp", probeKey: F3, lotNumber: "CCC", expiryDate: "2025-01-01" }),
    ],
    TODAY,
  );
  it("activeProbeLotOptionsForProbe returns only ACTIVE options with the matching probe_key", () => {
    expect(activeProbeLotOptionsForProbe(opts, F3).map((o) => o.id)).toEqual(["f3a"]);
    expect(activeProbeLotOptionsForProbe(opts, F2).map((o) => o.id)).toEqual(["f2a"]);
    expect(activeProbeLotOptionsForProbe(opts, "")).toEqual([]);
  });
  it("probeLotOptionsForProbe includes expired for the probe (edit visibility) but not other probes", () => {
    expect(probeLotOptionsForProbe(opts, F3).map((o) => o.id).sort()).toEqual(["f3a", "f3exp"]);
    expect(probeLotOptionsForProbe(opts, F3).some((o) => o.probeKey === F2)).toBe(false);
  });
});

describe("resolveInventoryAutofill (#4/#5/#6/#15)", () => {
  const one = buildProbeLotOptions([row({ id: "solo", probeKey: F3, lotNumber: "SOLO", expiryDate: null })], TODAY);
  const two = buildProbeLotOptions(
    [
      row({ id: "a", probeKey: F3, lotNumber: "A", expiryDate: "2026-12-01" }),
      row({ id: "b", probeKey: F3, lotNumber: "B", expiryDate: "2026-12-01" }),
    ],
    TODAY,
  );

  it("(#4) exactly one active lot for the probe → only-active auto-fill", () => {
    const r = resolveInventoryAutofill(one, F3, null);
    expect(r.kind).toBe("only-active");
    expect(r.kind !== "choose" && r.option.id).toBe("solo");
  });
  it("(#6) multiple active lots + no prior linked id → choose (never auto-select)", () => {
    expect(resolveInventoryAutofill(two, F3, null).kind).toBe("choose");
  });
  it("(#5) a last-confirmed linked active id wins among multiple", () => {
    const r = resolveInventoryAutofill(two, F3, "b");
    expect(r.kind).toBe("last-confirmed");
    expect(r.kind !== "choose" && r.option.id).toBe("b");
  });
  it("(#15) never auto-fills an EXPIRED lot, and a prior linked id pointing at an expired lot does not resolve", () => {
    const mixed = buildProbeLotOptions(
      [
        row({ id: "gone", probeKey: F3, lotNumber: "GONE", expiryDate: "2025-01-01" }),
        row({ id: "x", probeKey: F3, lotNumber: "X", expiryDate: "2026-12-01" }),
        row({ id: "y", probeKey: F3, lotNumber: "Y", expiryDate: "2026-12-01" }),
      ],
      TODAY,
    );
    // Only ACTIVE lots are considered; the expired "gone" is never returned.
    expect(resolveInventoryAutofill(mixed, F3, "gone").kind).toBe("choose");
    expect(resolveInventoryAutofill(mixed, F3, null).kind).toBe("choose");
  });
  it("no probe selected → choose", () => {
    expect(resolveInventoryAutofill(one, "", null).kind).toBe("choose");
  });
});

describe("filterProbeLotOptions + label", () => {
  const opts = buildProbeLotOptions(
    [
      row({ id: "1", lotNumber: "460941", itemDescription: "Gold F3 probe", manufacturerName: "Sterex" }),
      row({ id: "2", lotNumber: "770022", itemDescription: "Insulated probe", manufacturerName: "Ballet", probeKey: F2 }),
    ],
    TODAY,
  );
  it("matches by lot / description / manufacturer (case-insensitive)", () => {
    expect(filterProbeLotOptions(opts, "4609").map((o) => o.id)).toEqual(["1"]);
    expect(filterProbeLotOptions(opts, "ballet").map((o) => o.id)).toEqual(["2"]);
    expect(filterProbeLotOptions(opts, "GOLD").map((o) => o.id)).toEqual(["1"]);
    expect(filterProbeLotOptions(opts, "  ")).toHaveLength(2);
  });
  it("label shows expires / EXPIRED / no expiry", () => {
    const [a] = buildProbeLotOptions([row({ id: "a", lotNumber: "1", expiryDate: "2026-12-01" })], TODAY);
    const [e] = buildProbeLotOptions([row({ id: "e", lotNumber: "2", expiryDate: "2025-01-01" })], TODAY);
    const [n] = buildProbeLotOptions([row({ id: "n", lotNumber: "3", expiryDate: null })], TODAY);
    expect(probeLotOptionLabel(a)).toContain("expires 2026-12-01");
    expect(probeLotOptionLabel(e)).toContain("EXPIRED 2025-01-01");
    expect(probeLotOptionLabel(n)).toContain("no expiry");
  });

  // The lot-number prefix delimiter is a CONTRACT between this producer and
  // components/probe-lot-select.tsx, which strips the prefix so the row can
  // show the description beside the lot number it already renders. When the
  // em-dash cleanup changed the delimiter, changing only one side would have
  // left the prefix visible with nothing failing. Both now import one exported
  // constant, so they cannot disagree, and these pins prove the stripping
  // behaviour rather than the punctuation.
  it("the lot label prefix is stripped by the delimiter the producer actually uses", () => {
    const [o] = buildProbeLotOptions(
      [row({ id: "x", lotNumber: "460941", itemDescription: "Sterex Gold F3", expiryDate: null })],
      TODAY,
    );
    const label = probeLotOptionLabel(o);
    expect(label.startsWith(`460941${PROBE_LOT_LABEL_DELIMITER}`)).toBe(true);

    // Exactly what the component renders beside the lot number.
    const shown = label
      .replace(`${o.lotNumber}${PROBE_LOT_LABEL_DELIMITER}`, "")
      .replace(`${o.lotNumber} · `, "");
    expect(shown).toBe("Sterex Gold F3 · no expiry");
    expect(shown.startsWith("460941")).toBe(false); // no leftover lot prefix
  });

  it("an option with no description still strips cleanly", () => {
    const [o] = buildProbeLotOptions(
      [row({ id: "y", lotNumber: "770022", itemDescription: "", expiryDate: null })],
      TODAY,
    );
    const label = probeLotOptionLabel(o);
    const shown = label
      .replace(`${o.lotNumber}${PROBE_LOT_LABEL_DELIMITER}`, "")
      .replace(`${o.lotNumber} · `, "");
    expect(shown).toBe("no expiry");
    expect(shown).not.toContain("770022");
  });

  it("no typographic em dash remains in the rendered label", () => {
    const [o] = buildProbeLotOptions(
      [row({ id: "z", lotNumber: "1", itemDescription: "Probe", expiryDate: null })],
      TODAY,
    );
    expect(probeLotOptionLabel(o)).not.toContain("\u2014");
  });
});
