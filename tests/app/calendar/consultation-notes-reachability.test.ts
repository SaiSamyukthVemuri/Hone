import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Consultation + skin/hair notes must be REACHABLE from the appointment.
//
// Both note kinds already existed and already worked; Chloe could not find
// them. So these tests pin the reachability contract itself, the CTA, its
// destination, the modality scoping, and the fact that nothing here became a
// second writer. The rendered journey is proved in the browser
// (e2e/clinical-notes.spec.ts); this file pins the wiring that browser test
// depends on, and the invariants a browser test cannot see.

const REPO = path.resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(path.join(REPO, p), "utf8");

const CARD = read("components/consultation-notes-card.tsx");
const APPT = read("app/(app)/calendar/[id]/page.tsx");
const TABS = read("components/profile-tab-bar.tsx");
const TAB_MODEL = read("components/profile-tab.ts");

describe("G1: the appointment reaches the notes", () => {
  it("the card is mounted on the appointment page", () => {
    expect(APPT).toMatch(/import \{ ConsultationNotesCard \}/);
    expect(APPT).toMatch(/<ConsultationNotesCard/);
  });

  it("the CTA deep-links to the EXISTING consultation tab, not a new route", () => {
    expect(CARD).toMatch(
      /href = `\/clients\/\$\{clientId\}\?tab=consultation`/,
    );
    // No invented route, and no note-composer of its own.
    expect(CARD).not.toMatch(/\/consultation\/new|\/notes\/new/);
  });

  // SOURCE-STRUCTURE test, not a rendering test. The earlier name claimed the
  // CTA "is scoped to consultation modality", which a regex cannot establish,
  // and the old proximity pattern (/isConsultation[\s\S]{0,120}Record .../)
  // would still have matched if the ternary were INVERTED, i.e. the exact
  // regression it named. It now pins the TRUE branch of each ternary, so an
  // inversion fails here. Runtime scoping is proved in the browser:
  // e2e/clinical-notes.spec.ts asserts the record CTA on a consultation
  // appointment.
  it("source: the record CTA is the TRUE branch of the isConsultation ternary", () => {
    // testid ternary: true -> record, false -> view.
    expect(CARD).toMatch(
      /isConsultation\s*\?\s*"appointment-record-consultation-notes"\s*:\s*"appointment-view-consultation-notes"/,
    );
    // label ternary: true -> "Record consultation notes".
    expect(CARD).toMatch(/isConsultation\s*\?\s*\n?\s*"Record consultation notes"/);
    // And the page derives that flag from the SERVICE modality it already has.
    expect(APPT).toMatch(
      /isConsultation=\{data\.service\?\.modality === "consultation"\}/,
    );
  });

  // SOURCE-ORDER test. That ChartSessionCard actually RENDERS beside the notes
  // card on a real consultation appointment is proved in the browser
  // (e2e/clinical-notes.spec.ts asserts the "+ Chart session" link and its
  // appointment-scoped href). This only pins that the notes card was ADDED
  // after it in the tree rather than replacing it.
  it("source: the notes card is added after ChartSessionCard, not in place of it", () => {
    expect(APPT).toMatch(/<ChartSessionCard/);
    const chartAt = APPT.indexOf("<ChartSessionCard");
    const notesAt = APPT.indexOf("<ConsultationNotesCard");
    expect(chartAt).toBeGreaterThan(-1);
    expect(notesAt).toBeGreaterThan(chartAt);
  });

  it("source: a client-less card early-returns null rather than build a link", () => {
    expect(CARD).toMatch(/if \(!clientId\) return null;/);
  });

  it("source: a non-consultation card with no notes early-returns null", () => {
    // No empty panel on every electrolysis appointment.
    expect(CARD).toMatch(/if \(!isConsultation && !hasAnyNote\) return null;/);
  });
});

describe("G2: pre-visit note context reuses the existing authority", () => {
  it("reads through the EXISTING summary helper, adding no new query shape", () => {
    expect(APPT).toMatch(
      /import \{ getClinicalNotesSummary \} from "@\/lib\/clinical-notes\/queries"/,
    );
  });

  it("source: each kind's block is guarded by its own presence check", () => {
    expect(CARD).toMatch(/\{consultation && \(/);
    expect(CARD).toMatch(/\{skinHair && \(/);
    expect(CARD).toMatch(/Consultation note/);
    expect(CARD).toMatch(/Skin\/hair analysis/);
  });

  // That the CURRENT (non-superseded) entry is what actually appears is proved
  // against real records in e2e/clinical-notes.spec.ts, which writes a note,
  // revises it, and asserts the appointment card shows the revision and NOT
  // the superseded original. This only pins the qualifier's condition.
  it("source: the 'latest of N' qualifier sits in the TRUE branch of total > 1", () => {
    // The old pattern (/latest of \$\{total\}|latest of /) matched the bare
    // literal unconditionally, so it could not have detected `total > 1`
    // becoming `total > 100`, nor the qualifier moving branches.
    expect(CARD).toMatch(/total > 1\s*\?[\s\S]{0,40}latest of \$\{total\}/);
  });

  // The PRIMARY CTA's 44px target is measured for real in the browser
  // (e2e/clinical-notes.spec.ts reads its boundingBox). The secondary link only
  // renders on a NON-consultation appointment that already has notes, which
  // that journey does not visit, so it is pinned structurally here: both
  // branches of the className ternary must carry the affordance.
  it("source: BOTH CTA className branches carry the 44px touch target", () => {
    // Reads ONLY the className ternary, with comments stripped. The first
    // version of this assertion counted /min-h-\[44px\]/ across the whole file
    // and stayed green when the secondary branch's class was deleted, because
    // a COMMENT mentioning min-h-[44px] kept the count at two. A negative
    // control caught that; do not loosen it back to a file-wide count.
    const block = CARD.match(/className=\{[\s\S]*?\n\s*\}/)?.[0] ?? "";
    const branches = block.replace(/\/\/.*$/gm, "").match(/"[^"]+"/g) ?? [];
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch).toContain("min-h-[44px]");
    }
  });

  it("does not truncate clinical text", () => {
    // The point-of-care card has an excerpt contract; this surface does not
    // borrow it, because silently shortening clinical text is worse than a
    // longer card.
    expect(CARD).toMatch(/whitespace-pre-wrap/);
    expect(CARD).not.toMatch(/slice\(0,|substring\(0,|line-clamp/);
  });
});

describe("G3: the tab says what it holds, without changing its URL", () => {
  it("the VISIBLE label names both kinds", () => {
    expect(TABS).toMatch(/label: "Consultation & Skin\/Hair"/);
  });

  it("the tab VALUE is still exactly 'consultation'", () => {
    // ?tab=consultation is a real deep link used by the new CTA and by the
    // Overview cards. Renaming the value would break every existing link.
    expect(TABS).toMatch(/value: "consultation"/);
    expect(TABS).not.toMatch(/value: "consultation_skin_hair"/);
    expect(TAB_MODEL).toMatch(/\| "consultation"/);
    expect(TAB_MODEL).toMatch(/value === "consultation"/);
  });
});

// The independent review found this read awaited AFTER the page's six-way
// Promise.all. It depends on nothing in that wave, only `clientId`, already in
// hand, so it added a whole serial round-trip to EVERY appointment render,
// including the electrolysis and laser visits where the card then renders
// nothing at all.
//
// HONEST SCOPE: this is a source-structure guard, NOT a timing measurement. A
// wall-clock concurrency assertion over a Next.js async server component would
// need a full request harness and would be flaky under CI load. What it does
// pin is the two shapes that actually regress, a standalone `await`, or a
// second call site drifting back out of the wave.
describe("the clinical-note read stays inside the page's parallel wave (source structure)", () => {
  // The `] = await Promise.all([ … ]);` array, sliced out of the page source.
  function parallelBlock(): string {
    const open = APPT.indexOf("] = await Promise.all([");
    const close = APPT.indexOf("\n    ]);", open);
    return open > -1 && close > open ? APPT.slice(open, close) : "";
  }

  it("the page still has exactly one parallel wave to belong to", () => {
    expect(parallelBlock().length).toBeGreaterThan(0);
  });

  it("getClinicalNotesSummary is invoked exactly once on this page", () => {
    // The import and the `typeof` in the declaration carry no call paren, so
    // this counts invocations only.
    expect(APPT.match(/getClinicalNotesSummary\(/g) ?? []).toHaveLength(1);
  });

  it("that single invocation sits INSIDE the Promise.all array", () => {
    expect(parallelBlock()).toMatch(/getClinicalNotesSummary\(clientId\)/);
  });

  it("no standalone `await getClinicalNotesSummary(...)` remains", () => {
    // The exact shape that serialized before.
    expect(APPT).not.toMatch(/await\s+getClinicalNotesSummary\(/);
  });

  it("its result is consumed from the wave's destructuring, not re-fetched", () => {
    expect(APPT).toMatch(/clinicalNotesRes,/);
    expect(APPT).toMatch(/clinicalNotesSummary = clinicalNotesRes;/);
  });
});

describe("no second writer", () => {
  it("the card performs no write of any kind", () => {
    for (const forbidden of [
      "insertClinicalNote",
      "createAdminClient",
      "use server",
      ".insert(",
      ".update(",
      ".delete(",
      "supabase",
    ]) {
      expect(CARD, `card must not contain ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });

  it("the appointment page gained a READ, not a note writer", () => {
    expect(APPT).not.toMatch(/insertClinicalNote/);
    expect(APPT).not.toMatch(/from\("client_clinical_notes"\)/);
  });
});
