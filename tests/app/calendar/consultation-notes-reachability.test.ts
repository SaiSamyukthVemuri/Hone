import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Consultation + skin/hair notes must be REACHABLE from the appointment.
//
// Both note kinds already existed and already worked; Chloe could not find
// them. So these tests pin the reachability contract itself — the CTA, its
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

describe("G1 — the appointment reaches the notes", () => {
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

  it("the primary 'Record consultation notes' CTA is scoped to consultation modality", () => {
    expect(CARD).toMatch(/Record consultation notes/);
    // The label is chosen by isConsultation, never rendered unconditionally.
    expect(CARD).toMatch(
      /isConsultation[\s\S]{0,120}Record consultation notes/,
    );
    // And the page derives that flag from the SERVICE modality it already has.
    expect(APPT).toMatch(
      /isConsultation=\{data\.service\?\.modality === "consultation"\}/,
    );
  });

  it("Chart session remains available — a consultation may include a test treatment", () => {
    // The consultation CTA must not replace charting: the postcare section on
    // this same page already encodes that consultations can include a short
    // electrolysis test treatment.
    expect(APPT).toMatch(/<ChartSessionCard/);
    const chartAt = APPT.indexOf("<ChartSessionCard");
    const notesAt = APPT.indexOf("<ConsultationNotesCard");
    expect(chartAt).toBeGreaterThan(-1);
    expect(notesAt).toBeGreaterThan(chartAt);
  });

  it("a client-less appointment renders nothing rather than a broken link", () => {
    expect(CARD).toMatch(/if \(!clientId\) return null;/);
  });

  it("a non-consultation appointment with NO notes renders nothing at all", () => {
    // No empty panel on every electrolysis appointment.
    expect(CARD).toMatch(/if \(!isConsultation && !hasAnyNote\) return null;/);
  });
});

describe("G2 — pre-visit note context reuses the existing authority", () => {
  it("reads through the EXISTING summary helper, adding no new query shape", () => {
    expect(APPT).toMatch(
      /import \{ getClinicalNotesSummary \} from "@\/lib\/clinical-notes\/queries"/,
    );
    expect(APPT).toMatch(/await getClinicalNotesSummary\(clientId\)/);
  });

  it("renders both kinds, each only when present", () => {
    expect(CARD).toMatch(/\{consultation && \(/);
    expect(CARD).toMatch(/\{skinHair && \(/);
    expect(CARD).toMatch(/Consultation note/);
    expect(CARD).toMatch(/Skin\/hair analysis/);
  });

  it("shows the CURRENT entry and says so when there are more", () => {
    // Never reads as the whole record; history stays on the tab.
    expect(CARD).toMatch(/latest of \$\{total\}|latest of /);
  });

  it("does not truncate clinical text", () => {
    // The point-of-care card has an excerpt contract; this surface does not
    // borrow it, because silently shortening clinical text is worse than a
    // longer card.
    expect(CARD).toMatch(/whitespace-pre-wrap/);
    expect(CARD).not.toMatch(/slice\(0,|substring\(0,|line-clamp/);
  });
});

describe("G3 — the tab says what it holds, without changing its URL", () => {
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
