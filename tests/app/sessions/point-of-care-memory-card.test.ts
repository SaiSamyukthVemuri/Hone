import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Source-contract pins for point-of-care treatment memory (Chloe).
//
// The behavioural rules live in tests/lib/sessions/point-of-care-memory.test.ts
// and tests/lib/sessions/charted-session.test.ts. What CANNOT be proved by a
// pure test is the wiring: that the card is mounted on the live charting page
// above the entry surface, that it is fed from the shared newest-charted-session
// selector, that it stays read-only, and that it never reaches for the
// service-role client. Those are pinned here.

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const SESSION_PAGE = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
);
const NEW_SESSION_PAGE = read("app/(app)/clients/[id]/sessions/new/page.tsx");
const CARD = read("components/last-treatment-memory-card.tsx");
const LOADER = read("lib/sessions/last-treatment-loader.ts");
const MEMORY = read("lib/sessions/point-of-care-memory.ts");
const SELECTOR = read("lib/sessions/charted-session.ts");
const TREATMENT_TIME = read("lib/treatment-time/queries.ts");
const AREA_BUCKET = read("lib/treatment-time/area-bucket.ts");

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\/|^\s*\{?\/\*|^\s*\*/.test(line))
    .join("\n");
}

describe("the memory card is mounted ON the live charting page", () => {
  it("the charting page imports and renders the card", () => {
    expect(SESSION_PAGE).toMatch(
      /import \{ LastTreatmentMemoryCard \} from "@\/components\/last-treatment-memory-card"/,
    );
    expect(SESSION_PAGE).toMatch(/<LastTreatmentMemoryCard/);
  });

  it("it renders BEFORE the block-entry surface, not below the current session's forms", () => {
    const card = SESSION_PAGE.indexOf("<LastTreatmentMemoryCard");
    const blocks = SESSION_PAGE.indexOf("<SessionBlocksView");
    const laserForm = SESSION_PAGE.indexOf("<LogLaserEntryForm");
    expect(card).toBeGreaterThan(-1);
    expect(blocks).toBeGreaterThan(-1);
    expect(card).toBeLessThan(blocks);
    expect(card).toBeLessThan(laserForm);
  });

  it("it renders above the collapsed consultation section too, so memory is first", () => {
    const card = SESSION_PAGE.indexOf("<LastTreatmentMemoryCard");
    const notesSection = SESSION_PAGE.indexOf("<ClinicalNotesSection");
    expect(card).toBeLessThan(notesSection);
  });

  it("it renders nothing for a client with no prior charted treatment", () => {
    expect(SESSION_PAGE).toMatch(/\{pointOfCareMemory && \(/);
  });

  it("a charted visit with NO settings blocks says so, instead of \"Area not recorded\"", () => {
    // A LASER prior visit (or pre-block legacy electrolysis) qualifies as
    // charted but produces zero blocks. Found by adversarial review: the card
    // used to render "Area not recorded" + "Not recorded" over a visit that
    // really happened.
    expect(CARD).toMatch(/const hasBlockDetail = memory\.areas\.length > 0/);
    expect(CARD).toMatch(/\{!hasBlockDetail \? \(/);
    expect(CARD).toMatch(/data-testid="last-treatment-no-blocks"/);
    // The copy is SHARED with the /sessions/new context panel, so the two
    // surfaces cannot describe the same session differently.
    expect(CARD).toMatch(/memory\.blocklessNote/);
    expect(MEMORY).toMatch(/charted as laser passes/i);
    expect(MEMORY).toMatch(/legacy treatment entries without settings blocks/i);
    expect(MEMORY).toMatch(/Open the full chart to review what was recorded/i);
  });

  it("the /sessions/new context panel uses the SAME shared copy, not its own", () => {
    expect(NEW_SESSION_PAGE).toMatch(
      /blocklessTreatmentCopy\(\{/,
    );
    expect(NEW_SESSION_PAGE).toMatch(/data-testid="previous-context-blockless"/);
    // It must not hand-roll the sentence.
    const code = codeOnly(NEW_SESSION_PAGE);
    expect(code).not.toMatch(/charted as laser passes/i);
    // And it must render the fallback INSTEAD of an empty AreaSummaries.
    expect(NEW_SESSION_PAGE).toMatch(/\{blocklessNote \? \(/);
    expect(NEW_SESSION_PAGE).not.toMatch(/Area not recorded/);
  });

  it("the card carries a test handle so the browser spec is not selector-fragile", () => {
    expect(CARD).toMatch(/data-testid="last-treatment-memory"/);
  });
});

describe("both previous-context surfaces use the ONE shared selector", () => {
  it("the charting page loads the last CHARTED treatment", () => {
    expect(SESSION_PAGE).toMatch(/loadLastChartedTreatment\(\{/);
    expect(SESSION_PAGE).toMatch(/excludeSessionId: session\.id/);
    expect(SESSION_PAGE).toMatch(/before: session\.started_at/);
  });

  it("the new-session page loads the last CHARTED treatment", () => {
    expect(NEW_SESSION_PAGE).toMatch(/loadLastChartedTreatment\(\{/);
  });

  it("the new-session page no longer picks the newest session ROW", () => {
    const code = codeOnly(NEW_SESSION_PAGE);
    // The exact defect: `.order("started_at", desc).limit(1)` over sessions
    // with no content predicate.
    expect(code).not.toMatch(/\.order\("started_at", \{ ascending: false \}\)/);
    expect(code).not.toMatch(/\.limit\(1\)/);
  });

  it("the loader is the ONLY thing that reads prior blocks for these surfaces", () => {
    const code = codeOnly(NEW_SESSION_PAGE);
    expect(code).not.toMatch(/from\("session_blocks"\)/);
  });

  it("the loader delegates the DECISION to the shared selector, never re-implements it", () => {
    // A negative control caught this: the loader originally inlined
    // `candidates.find(hasChartedContent)`, so mutating pickNewestChartedSession
    // changed nothing the browser could see and the E2E control passed
    // vacuously. The rule must live in exactly one place.
    const code = codeOnly(LOADER);
    expect(code).toMatch(/pickNewestChartedSession\(candidates, bySession\)/);
    expect(code).not.toMatch(/\.find\(\s*\(s\)\s*=>\s*hasChartedContent/);
    expect(code).not.toMatch(/electrolysis_entries\.length\s*>\s*0/);
    expect(code).not.toMatch(/laser_entries\.length\s*>\s*0/);
  });

  it("the shared selector requires CONTENT, not merely a session row", () => {
    const code = codeOnly(SELECTOR);
    expect(code).toMatch(/hasChartedContent/);
    expect(code).toMatch(/electrolysis_entries/);
    expect(code).toMatch(/laser_entries/);
    expect(SELECTOR).toMatch(/record_status === "void"/);
  });
});

describe("read-only and RLS-scoped", () => {
  it("no service-role client anywhere in the feature", () => {
    for (const src of [CARD, LOADER, MEMORY, SELECTOR]) {
      expect(src).not.toMatch(/createAdminClient/);
      expect(src).not.toMatch(/admin-server/);
      expect(src).not.toMatch(/SERVICE_ROLE/);
    }
  });

  it("the loader uses the authenticated user client", () => {
    expect(LOADER).toMatch(
      /import \{ createClient \} from "@\/lib\/supabase\/server"/,
    );
  });

  it("the memory feature performs NO writes", () => {
    for (const src of [CARD, LOADER, MEMORY, SELECTOR]) {
      const code = codeOnly(src);
      expect(code).not.toMatch(/\.insert\(/);
      expect(code).not.toMatch(/\.update\(/);
      expect(code).not.toMatch(/\.delete\(/);
      expect(code).not.toMatch(/\.upsert\(/);
      expect(code).not.toMatch(/\.rpc\(/);
    }
  });

  it("the card is a presentation component, no form, no action, no state", () => {
    expect(CARD).not.toMatch(/"use client"/);
    expect(CARD).not.toMatch(/<form/);
    expect(CARD).not.toMatch(/useState|useTransition|action=/);
  });

  it("the loader logs CLASSIFICATION ONLY on failure, never the raw DB message", () => {
    const code = codeOnly(LOADER);
    // The raw PostgREST/Postgres message echoes the failing statement, and this
    // statement embeds candidate session ids and every clinical column name.
    expect(code).not.toMatch(/error\.message/);
    expect(code).not.toMatch(/message:/);
    // What IS allowed: event, SQLSTATE, studio id, candidate count, timestamp.
    const logBlock = code.slice(
      code.indexOf("last_charted_treatment_blocks_read_failed"),
    ).slice(0, 500);
    expect(logBlock).toMatch(/code:/);
    // Session 1D split the loader's "select from a known candidate window" half
    // into its own function, so the block read now names the parameter directly
    // rather than through the input object. Either spelling satisfies the
    // contract; what matters is that it is the STUDIO id and nothing narrower.
    expect(logBlock).toMatch(/studio_id: (input\.)?studioId/);
    expect(logBlock).toMatch(/candidate_count: candidates\.length/);
    // And what is not.
    for (const banned of [
      "client_id",
      "clientId",
      "session_id",
      "sessionId",
      "body",
      "excerpt",
      "probe",
      "area",
      "BLOCK_COLUMNS",
      "hairs",
    ]) {
      expect(logBlock, `log must not carry ${banned}`).not.toContain(banned);
    }
  });

  it("the loader is the ONLY console site in the feature, and every site logs one object", () => {
    for (const src of [CARD, MEMORY, SELECTOR]) {
      expect(codeOnly(src)).not.toMatch(/console\./);
    }
    // Session 1D added the appointment-prep candidate read, which is a second
    // query and therefore a second failure to classify. Both sites, and ONLY
    // these two, may log, and both are held to the redaction contract above.
    const code = codeOnly(LOADER);
    // FOUR sites now: the per-client loader's candidate + block reads, and the
    // batched companion's. The count is not the contract, the REDACTION is,
    // and it is asserted for every one of them below.
    expect((code.match(/console\./g) ?? []).length).toBe(4);
    // Every one of them is console.error(JSON.stringify({...})), never a bare
    // string, never the raw PostgREST message.
    expect((code.match(/console\.error\(\s*JSON\.stringify\(\{/g) ?? []).length).toBe(
      4,
    );
    // The redaction contract is asserted for EVERY log site, not just the one
    // Session 1D happened to add, that is what actually protects the pipeline
    // when a new read (and so a new failure to classify) appears.
    // Bounded to the LOG OBJECT itself. A fixed-width slice runs past the
    // closing brace into ordinary code and flags identifiers that were never
    // logged, which is a false positive, not a redaction failure.
    const logSites = [...code.matchAll(/console\.error\(\s*JSON\.stringify\(\{/g)].map(
      (m) => {
        const rest = code.slice(m.index!);
        const end = rest.indexOf("}),");
        return rest.slice(0, end === -1 ? 500 : end);
      },
    );
    expect(logSites).toHaveLength(4);
    for (const site of logSites) {
      expect(site).toMatch(/code:/);
      // Either the companion's `input.studioId` or selectFromCandidates' bare
      // `studioId` param, what matters is that the studio is named and that
      // it is an identifier, never an interpolated payload.
      expect(site).toMatch(/studio_id: (input\.)?studioId,/);
      for (const banned of ["client_id", "clientId", "session_id", "sessionId"]) {
        expect(site, `log site must not carry ${banned}`).not.toMatch(
          new RegExp(`${banned}\\b`),
        );
      }
    }
    const prepLog = code
      .slice(code.indexOf("appointment_prep_sessions_read_failed"))
      .slice(0, 500);
    expect(prepLog).toMatch(/code:/);
    expect(prepLog).toMatch(/studio_id: input\.studioId/);
    for (const banned of [
      "client_id",
      "clientId",
      "session_id",
      "sessionId",
      "appointment_id",
      "appointmentId",
      "body",
      "excerpt",
      "probe",
      "notes",
      "comments",
    ]) {
      expect(prepLog, `prep log must not carry ${banned}`).not.toContain(banned);
    }
  });

  it("the blocks read is batched and studio-scoped, no N+1, no unbounded IN", () => {
    expect(LOADER).toMatch(/\.eq\("studio_id", input\.studioId\)/);
    expect(LOADER).toMatch(/\.in\(\s*"session_id",/);
    expect(LOADER).toMatch(/\.is\("deleted_at", null\)/);
    // The candidate window is bounded before the IN(...) is built.
    expect(SELECTOR).toMatch(/DEFAULT_CHARTED_SESSION_LIMIT = 25/);
  });

  it("the card never renders a whole clinical note body", () => {
    expect(CARD).toMatch(/note\.excerpt/);
    expect(codeOnly(CARD)).not.toMatch(/note\.body/);
    expect(MEMORY).toMatch(/export function noteExcerpt/);
  });
});

describe("no forked display vocabulary", () => {
  it("the memory view model composes the existing shared helpers", () => {
    for (const mod of [
      "@/lib/sessions/block-areas",
      "@/lib/sessions/format-seconds",
      "@/lib/sessions/reading-field-order",
      "@/lib/sessions/clinical-response",
      "@/lib/sessions/reaction-unified",
      "@/lib/sessions/treatment-setup-snapshot",
    ]) {
      expect(MEMORY).toContain(mod);
    }
  });

  it("it does not re-implement the unified reaction classifier", () => {
    const code = codeOnly(MEMORY);
    expect(code).toMatch(/unifiedReactionLabels\(/);
    expect(code).not.toMatch(/REACTION_TYPES|isReactionChipLabel|normalizeChips/);
  });

  it("thermolysis duration goes through the 3dp formatter, never a local rounder", () => {
    const code = codeOnly(MEMORY);
    expect(code).toMatch(/formatSeconds\(num\(canonical\?\.thermolysis_duration_seconds\)\)/);
    expect(code).not.toMatch(/toFixed\(2\)\s*\}?`?\s*;?\s*\/\/?\s*thermolysis/i);
    expect(code).not.toMatch(/Math\.round\([^)]*\* 100\) \/ 100/);
  });

  it("the retired galvanic intensity input is named nowhere in the feature", () => {
    for (const src of [CARD, LOADER, MEMORY, SELECTOR]) {
      expect(codeOnly(src)).not.toMatch(/galvanic_intensity_percent/);
    }
  });
});

describe("multi-area treatment-time attribution", () => {
  it("the bucket key is canonicalized so tap order cannot fragment a combination", () => {
    // display_order is the practitioner's tap order, so the combined key must
    // depend on the SET of areas, not the order they were entered in.
    const code = codeOnly(AREA_BUCKET);
    expect(code).toMatch(/const canonical = \[\.\.\.names\]\.sort\(/);
    expect(code).toMatch(/return canonical\.join\(AREA_BUCKET_SEPARATOR\)/);
  });

  it("the breakdown resolves its bucket through the shared, pure area resolver", () => {
    expect(TREATMENT_TIME).toMatch(
      /import \{ buildAreaMinutesBreakdown \} from "\.\/area-bucket"/,
    );
    expect(TREATMENT_TIME).toMatch(/return buildAreaMinutesBreakdown\(/);
    expect(AREA_BUCKET).toMatch(/const area = resolveAreaBucketLabel\(block\)/);
  });

  it("it no longer buckets on the legacy primary_area alone", () => {
    const code = codeOnly(TREATMENT_TIME);
    expect(code).not.toMatch(/const structured = block\.primary_area\?\.trim\(\)/);
  });

  it("it loads the structured areas in the SAME embed, no extra round-trip", () => {
    expect(TREATMENT_TIME).toMatch(
      /structured_areas:session_block_areas\(id, area, display_order, created_at\)/,
    );
    // One sessions read, still.
    expect(
      (TREATMENT_TIME.match(/\.from\("sessions"\)/g) ?? []).length,
    ).toBeLessThanOrEqual(3);
  });

  it("the block's minutes are credited exactly once per block", () => {
    const code = codeOnly(AREA_BUCKET);
    const loop = code.slice(
      code.indexOf("export function buildAreaMinutesBreakdown"),
      code.indexOf("export function resolveAreaBucketLabel"),
    );
    // One set() per block iteration; no inner per-area loop, so a multi-area
    // block can never contribute its duration more than once.
    expect((loop.match(/minutesByArea\.set\(/g) ?? []).length).toBe(1);
    expect(loop).not.toMatch(/for \(const \w+ of [^)]*areas/);
    expect((loop.match(/resolveAreaBucketLabel\(/g) ?? []).length).toBe(1);
  });
});
