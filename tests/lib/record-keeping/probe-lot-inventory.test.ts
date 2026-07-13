import { describe, expect, it } from "vitest";
import {
  buildProbeLotOptions,
  activeProbeLotOptions,
  filterProbeLotOptions,
  suggestProbeLot,
  probeLotOptionLabel,
  type ProbeLotInventoryRow,
  type ProbeLotOption,
} from "@/lib/record-keeping/probe-lot-inventory";

// Active probe-lot inventory selection logic (migration 0128 charting release).
// Source of truth = record_keeping_sterile_items probe rows; "active" = not past
// expiry. Manual entry + historical snapshots are handled in the form; this
// module only builds/searches/suggests options.

const TODAY = "2026-07-13";

function row(over: Partial<ProbeLotInventoryRow> = {}): ProbeLotInventoryRow {
  return {
    lotNumber: "460941",
    itemDescription: "Sterex Gold F3 probe",
    manufacturerName: "Sterex",
    expiryDate: "2026-12-01",
    ...over,
  };
}

describe("buildProbeLotOptions: classification + ordering + dedupe", () => {
  it("classifies expired by todayIso; a null expiry never expires", () => {
    const opts = buildProbeLotOptions(
      [
        row({ lotNumber: "A", expiryDate: "2026-12-01" }), // future → active
        row({ lotNumber: "B", expiryDate: "2025-01-01" }), // past → expired
        row({ lotNumber: "C", expiryDate: null }), // no expiry → active
      ],
      TODAY,
    );
    const byLot = Object.fromEntries(opts.map((o) => [o.lotNumber, o.isExpired]));
    expect(byLot).toEqual({ A: false, B: true, C: false });
  });

  it("active options sort before expired ones (historical still selectable)", () => {
    const opts = buildProbeLotOptions(
      [
        row({ lotNumber: "OLD", expiryDate: "2025-01-01" }),
        row({ lotNumber: "NEW", expiryDate: "2026-12-01" }),
      ],
      TODAY,
    );
    expect(opts.map((o) => o.lotNumber)).toEqual(["NEW", "OLD"]);
    // The expired lot is NOT dropped — a historical value must stay selectable.
    expect(opts.find((o) => o.lotNumber === "OLD")?.isExpired).toBe(true);
  });

  it("dedupes by case-insensitive lot number, preferring a non-expired row", () => {
    const opts = buildProbeLotOptions(
      [
        row({ lotNumber: "lot1", expiryDate: "2025-01-01" }), // expired
        row({ lotNumber: "LOT1", expiryDate: "2026-12-01" }), // active dup
      ],
      TODAY,
    );
    expect(opts).toHaveLength(1);
    expect(opts[0].isExpired).toBe(false);
  });

  it("drops rows with a blank lot number", () => {
    const opts = buildProbeLotOptions([row({ lotNumber: "   " })], TODAY);
    expect(opts).toHaveLength(0);
  });
});

describe("activeProbeLotOptions", () => {
  it("returns only non-expired options", () => {
    const opts = buildProbeLotOptions(
      [
        row({ lotNumber: "A", expiryDate: "2026-12-01" }),
        row({ lotNumber: "B", expiryDate: "2025-01-01" }),
      ],
      TODAY,
    );
    expect(activeProbeLotOptions(opts).map((o) => o.lotNumber)).toEqual(["A"]);
  });
});

describe("filterProbeLotOptions: search", () => {
  const opts = buildProbeLotOptions(
    [
      row({ lotNumber: "460941", itemDescription: "Gold F3 probe", manufacturerName: "Sterex" }),
      row({ lotNumber: "770022", itemDescription: "Ballet Insulated probe", manufacturerName: "Ballet" }),
    ],
    TODAY,
  );
  it("matches by lot number, description, or manufacturer (case-insensitive)", () => {
    expect(filterProbeLotOptions(opts, "4609").map((o) => o.lotNumber)).toEqual(["460941"]);
    expect(filterProbeLotOptions(opts, "ballet").map((o) => o.lotNumber)).toEqual(["770022"]);
    expect(filterProbeLotOptions(opts, "GOLD").map((o) => o.lotNumber)).toEqual(["460941"]);
  });
  it("an empty query returns everything unchanged", () => {
    expect(filterProbeLotOptions(opts, "  ")).toHaveLength(2);
  });
});

describe("suggestProbeLot: never silently pick among several", () => {
  const twoActive = buildProbeLotOptions(
    [
      row({ lotNumber: "A", expiryDate: "2026-12-01" }),
      row({ lotNumber: "B", expiryDate: "2026-12-01" }),
    ],
    TODAY,
  );
  const oneActive = buildProbeLotOptions([row({ lotNumber: "SOLO", expiryDate: null })], TODAY);

  it("suggests the ONLY active lot when there is exactly one", () => {
    expect(suggestProbeLot(oneActive, null)?.lotNumber).toBe("SOLO");
  });
  it("returns null with multiple active lots and no last-used match", () => {
    expect(suggestProbeLot(twoActive, null)).toBeNull();
  });
  it("a last-used ACTIVE lot is suggested (beats the multiple-active null rule)", () => {
    expect(suggestProbeLot(twoActive, "b")?.lotNumber).toBe("B");
  });
  it("a last-used EXPIRED lot is NOT auto-suggested (only active candidates)", () => {
    const mixed = buildProbeLotOptions(
      [
        row({ lotNumber: "GONE", expiryDate: "2025-01-01" }), // expired
        row({ lotNumber: "X", expiryDate: "2026-12-01" }),
        row({ lotNumber: "Y", expiryDate: "2026-12-01" }),
      ],
      TODAY,
    );
    // last-used points at the expired lot → no active match → multiple active → null
    expect(suggestProbeLot(mixed, "GONE")).toBeNull();
  });
});

describe("probeLotOptionLabel", () => {
  const [active] = buildProbeLotOptions([row({ lotNumber: "460941", expiryDate: "2026-12-01" })], TODAY);
  const [expired] = buildProbeLotOptions([row({ lotNumber: "770022", expiryDate: "2025-01-01" })], TODAY);
  const [noExpiry] = buildProbeLotOptions([row({ lotNumber: "990033", expiryDate: null })], TODAY);
  it("shows expires / EXPIRED / no expiry", () => {
    expect(probeLotOptionLabel(active as ProbeLotOption)).toContain("expires 2026-12-01");
    expect(probeLotOptionLabel(expired as ProbeLotOption)).toContain("EXPIRED 2025-01-01");
    expect(probeLotOptionLabel(noExpiry as ProbeLotOption)).toContain("no expiry");
  });
});
