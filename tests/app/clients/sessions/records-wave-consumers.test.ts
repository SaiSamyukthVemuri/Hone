import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// HON-109 (Records): the session chart's trailing reads joined its one wave. Two things Privacy did not check and the change must prove:
//   (1) NO READ WAS DROPPED OR DUPLICATED: every read the page makes appears exactly once, and the list below is the list the page made BEFORE the change
//       (the same 24 calls, counted from production e27044e10).
//   (2) EACH CONSUMER STILL GETS ITS OWN RESULT: a destructured name is matched to its wave element by POSITION, so a swap (plans <-> previous note) would
//       type-check only when the shapes happen to agree. The pairing is pinned name by name, and each result is checked at the place it is consumed.
const RAW = readFileSync(path.resolve(__dirname, "../../../../app/(app)/clients/[id]/sessions/[sessionId]/page.tsx"), "utf8");
const SRC = RAW.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const count = (needle: string | RegExp) =>
  typeof needle === "string" ? SRC.split(needle).length - 1 : (SRC.match(needle) ?? []).length;

/** The wave's destructure names and its top-level elements, in order. */
function wave() {
  const end = SRC.indexOf("] = await Promise.all([");
  const start = SRC.lastIndexOf("const [", end);
  const names = SRC.slice(start + "const [".length, end).replace(/\s+/g, "").replace(/,$/, "");
  const open = end + "] = await Promise.all([".length;
  const close = SRC.indexOf("\n  ]);", open);
  const body = SRC.slice(open, close);
  const parts: string[] = [];
  let depth = 0, quote: string | null = null, cur = "";
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (quote) { cur += c; if (c === "\\") { cur += body[++i] ?? ""; } else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; }
    else if ("([{".includes(c)) { depth += 1; cur += c; }
    else if (")]}".includes(c)) { depth -= 1; cur += c; }
    else if (c === "," && depth === 0) { parts.push(cur); cur = ""; }
    else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return { names, elements: parts.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean) };
}

// name (as destructured, in order) -> what its wave element must contain
const PAIRING: Array<[string, RegExp]> = [
  ["sessionPhotos", /signedSessionPhotos/],
  ["lastEntry", /getRecentEntryForClient/],
  ["treatmentCounts", /getLaserTreatmentCountsForClient/],
  ["audit", /getSessionAudit/],
  ["clientTags", /getClientTags/],
  ["clinicalNoteSections", /buildClinicalNoteSections/],
  ["sessionPaymentEligibility", /getSessionPaymentEligibility/],
  ["pricedForPage", /getAuthoritativeSessionPaymentAmount/],
  ["settlementLoad", /getAppointmentSettlements/],
  ["apptResult", /"session-chart\.appointment",readLinkedAppointment|"session-chart\.appointment", readLinkedAppointment/],
  ["electrolysisContext", /"session-chart\.electrolysis-context", readElectrolysisContext/],
  ["[activePlansForClient,attachedPlan]", /getActiveTreatmentPlansForClient.*getTreatmentPlanWithCount/],
  ["previousVisit", /"session-chart\.previous-note", readPreviousVisit/],
  ["lastTreatment", /loadLastChartedTreatment/],
  ["copyDescriptorResult", /"session-chart\.copy-descriptor", readCopyDescriptor/],
];

describe("Records wave: each consumer gets its own result", () => {
  it("destructured names and wave elements are the same length and pair up one to one, in order", () => {
    const { names, elements } = wave();
    expect(names).toBe(PAIRING.map(([n]) => n).join(","));
    expect(elements.length).toBe(PAIRING.length);
    PAIRING.forEach(([name, re], i) => expect(elements[i], `${name} must come from its own read`).toMatch(re));
  });

  it("each result is consumed where it belongs", () => {
    expect(SRC).toMatch(/const \{ data: apptRow, error: apptErr \} = apptResult as NonNullable<typeof apptResult>;/);
    expect(SRC).toMatch(/const fromLastVisit = previousVisit\.note;/);
    expect(SRC).toMatch(/lastTreatment\s*\?\s*buildPointOfCareMemory\(\{[\s\S]*?lastTreatment\.session\.id/);
    expect(SRC).toMatch(/const \{ data: copyDescriptor \} = copyDescriptorResult;/);
    expect(SRC).toMatch(/\(copyDescriptor as \{ eligible\?: boolean \} \| null\)\?\.eligible/);
    expect(SRC).toMatch(/activePlansForClient\.length === 1/);
    expect(SRC).toMatch(/defaultAreaForPlan\(attachedPlan\)/);
    expect(SRC).toMatch(/const blockData = electrolysisContext\?\.blockChain\.blockData \?\? null;/);
    expect(SRC).toMatch(/const runningTotal = electrolysisContext\?\.runningTotal \?\? null;/);
    expect(SRC).toMatch(/const priorLaserCount = electrolysisContext\?\.priorLaserCount \?\? 0;/);
    expect(SRC).toMatch(/const multiplexOffer = electrolysisContext\?\.multiplexOffer \?\? null;/);
  });
});

describe("Records wave: no read dropped, none duplicated (the 24 reads the page made before)", () => {
  // Each appears exactly once as a CALL in the page source (the declaration sites are imports, which are not calls).
  const CALLS = [
    "getClientById(", "getSessionForClient(", "signedSessionPhotos(", "getRecentEntryForClient(", "getLaserTreatmentCountsForClient(", "getSessionAudit(",
    "getClientTags(", "buildClinicalNoteSections(", "getSessionPaymentEligibility(", "getAuthoritativeSessionPaymentAmount(", "getAppointmentSettlements(",
    "getSessionWithBlocks(", "readingsForBlock(", "machinesByIds(", "loadMultiplexOffer(", "getProbeLotSuggestions(", "getProbeLotInventory(",
    "getActiveTreatmentPlansForClient(", "getTreatmentPlanWithCount(", "getSessionNumberForClient(", "getPriorLaserSessionCount(", "loadPreviousVisitNote(",
    "loadLastChartedTreatment(",
  ];
  for (const call of CALLS) it(`${call} is called exactly once`, () => expect(count(call)).toBe(1));
  it("the appointment read, the copy-descriptor RPC and the rollout/auth read are each present once", () => {
    expect(count('.from("appointments")')).toBe(1);
    expect(count('.rpc("whole_session_copy_source_descriptor"')).toBe(1);
    expect(count("chartingViewForPage(")).toBe(1);
  });
  it("nothing that is a read is awaited serially after the wave any more", () => {
    const after = SRC.slice(SRC.indexOf("const sessionEntryIds"));
    for (const call of ["loadPreviousVisitNote(", "loadLastChartedTreatment(", "getActiveTreatmentPlansForClient(", "getSessionWithBlocks(", "whole_session_copy_source_descriptor"]) {
      expect(after, `${call} must not run after the wave`).not.toContain(call);
    }
  });
});
