import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// SOURCE GUARDS — appointment preparation memory (Chloe Session 1D).
//
// The behavioural rules live in tests/lib/sessions/appointment-prep-memory.test.ts
// and the real-database proof in tests/db/appointment-prep-memory.db.test.ts.
// What neither of those can see is the WIRING: that the appointment page routes
// through the shared newest-charted-treatment authority instead of its own
// newest-ROW query, that the duplicate legacy path is gone rather than left
// running alongside it, that clinical text is rendered whole, and that none of
// this reached for a service-role client.
//
// Those are pinned here, against the source text.

const ROOT = path.resolve(__dirname, "../..");

// The body of a top-level function, bounded by the NEXT top-level declaration
// rather than by a character count — a fixed window overruns into neighbouring
// code and makes a "must not contain" assertion match something unrelated.
function functionBody(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`function ${name} not found`);
  const rest = src.slice(at + 1);
  const next = rest.search(/\nfunction |\nexport /);
  return next < 0 ? rest : rest.slice(0, next);
}
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const PAGE_PATH = "app/(app)/calendar/[id]/page.tsx";
const PAGE = read(PAGE_PATH);
const CARD = read("components/appointment-prep-memory-card.tsx");
const MODEL = read("lib/sessions/appointment-prep-memory.ts");
const LOADER = read("lib/sessions/last-treatment-loader.ts");
const SELECTOR = read("lib/sessions/charted-session.ts");

// Comments legitimately DESCRIBE the removed query, so every "this pattern is
// gone" assertion must run against code lines only.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\/|^\s*\{?\/\*|^\s*\*/.test(line))
    .join("\n");
}

const PAGE_CODE = codeOnly(PAGE);
const CARD_CODE = codeOnly(CARD);
const LOADER_CODE = codeOnly(LOADER);

describe("the appointment page uses the SHARED last-treatment authority", () => {
  it("asks the HISTORICAL AUTHORITY, and holds no candidate window", () => {
    // Re-pointed, not deleted: the property this protected — ONE definition of
    // "the last treatment", not a second one on this page — is intact and
    // stronger. The page now receives an ANSWER rather than a window, so it
    // cannot decide which visit is the previous one at all.
    expect(PAGE).toMatch(
      /import \{ loadVisitPreparation[^}]*\} from "@\/lib\/sessions\/history\/prepare-visit"/,
    );
    expect(PAGE_CODE).toMatch(/loadVisitPreparation\(\{/);
    for (const retired of [
      "loadLastChartedTreatmentForClient",
      "pickNewestChartedSession",
      "chartedSessionCandidates",
      "pickLastTreatment",
    ]) {
      expect(PAGE_CODE, `${retired} is reachable again`).not.toMatch(
        new RegExp(`\\b${retired}\\b`),
      );
    }
  });

  it("passes the appointment's own start as the strict upper bound", () => {
    // Not now() — that would let a session charted after the appointment began
    // win. Not omitted — that would let a future booking's session win.
    expect(PAGE_CODE).toMatch(/before: data\.starts_at/);
  });

  it("excludes THIS appointment's own linked session by appointment id", () => {
    expect(PAGE_CODE).toMatch(/excludeAppointmentId: id/);
  });

  it("does NOT build the view model itself — the authority hands it over built", () => {
    // The property is unchanged and its enforcement moved UP: there must be one
    // mapping from a visit to its clinical model, not a copy per surface.
    //
    // It now lives in lib/sessions/history/visit-summary.ts, behind an adapter
    // whose every evidence channel is a REQUIRED parameter. That matters
    // because `AppointmentPrepMemoryInput` marks four of them optional, so a
    // page building the model itself can omit a laser visit's narrative, a
    // legacy entry-only visit's passes and the superseded line WITHOUT a type
    // error. This page therefore may not call the builder at all.
    expect(PAGE_CODE).not.toMatch(/buildAppointmentPrepMemory\(/);
    expect(PAGE_CODE).not.toMatch(/prepMemoryInputFromTreatment\(/);
    expect(PAGE_CODE).toMatch(/prepMemory = visitPrep\.memory/);
  });

  it("renders the prep card", () => {
    expect(PAGE).toMatch(
      /import \{ AppointmentPrepMemoryCard \} from "@\/components\/appointment-prep-memory-card"/,
    );
    expect(PAGE_CODE).toMatch(/<AppointmentPrepMemoryCard/);
  });
});

describe("the duplicate legacy previous-treatment path is GONE, not parallel", () => {
  it("no newest-row previous-treatment query survives", () => {
    // The removed query is identified by its time bound and its column set —
    // NOT by `order started_at desc limit 1` alone, which the linked-session
    // read legitimately still uses (and must keep using: it asks a different
    // question, scoped by appointment_id).
    expect(PAGE_CODE).not.toMatch(/\.lt\("started_at"/);
    // Exactly ONE sessions query remains on the page: the linked-session read.
    expect((PAGE_CODE.match(/\.from\("sessions"\)/g) ?? []).length).toBe(1);
    const only = PAGE_CODE.slice(PAGE_CODE.indexOf('.from("sessions")'));
    expect(only).toMatch(/\.eq\("appointment_id", id\)/);
    // And it selects only the three columns the View-session affordance needs —
    // no clinical column, no note column.
    expect(only).toMatch(/\.select\("id, started_at, modality"\)/);
    expect(only.slice(0, 400)).not.toMatch(/session_notes|next_session_note/);
  });

  it("the legacy session_notes column is still surfaced — it has no writer left", () => {
    // sessions.session_notes has no surviving write path anywhere in the
    // product, so a refactor that quietly drops it destroys text that can never
    // be recreated.
    //
    // The passthrough now lives in the SHARED mapper rather than inline in this
    // page — which is strictly better, because it protects the dashboard's copy
    // of the same surface too. Pinned where it actually is.
    const MODEL = read("lib/sessions/appointment-prep-memory.ts");
    expect(MODEL).toMatch(
      /session_notes: selected\.session\.session_notes \?\? null/,
    );
    expect(MODEL).toMatch(
      /next_session_note: selected\.session\.next_session_note \?\? null/,
    );
    // The candidate read is what makes them available.
    expect(LOADER).toMatch(/session_notes, next_session_note/);
  });

  it("the page performs no session_blocks read of its own", () => {
    expect(PAGE_CODE).not.toMatch(/from\("session_blocks"\)/);
  });

  it("the page no longer attaches structured areas separately", () => {
    // They arrive inside the loader's batched block select.
    expect(PAGE_CODE).not.toMatch(/attachStructuredAreas/);
    expect(PAGE).not.toMatch(/import[\s\S]{0,80}attachStructuredAreas/);
  });

  it("the companion loader DELEGATES selection — it does not pick a row itself", () => {
    // Caught by negative control #2: the DB lane mirrors the loader's SQL
    // rather than calling it (the loader needs a Next request context), so
    // nothing in that lane notices if the loader stops asking the shared
    // selector and just takes candidates[0]. This pin is that missing oracle.
    expect(LOADER_CODE).toMatch(
      /const selected = pickNewestChartedSession\(candidates, bySession\);/,
    );
    expect(LOADER_CODE).not.toMatch(/candidates\[0\]\s*\?\?\s*null/);
    // Both entry points reach the block read + selection through ONE function,
    // so neither can drift from the other.
    expect(
      (LOADER_CODE.match(/selectFromCandidates\(input\.studioId, candidates\)/g) ?? [])
        .length,
    ).toBe(2);
    // TWO call sites now: the per-client path (via selectFromCandidates) and
    // the BATCHED companion the dashboard uses. Both go through the shared
    // selector — which is the property this test exists to protect. What must
    // never appear is a hand-rolled pick.
    expect(
      (LOADER_CODE.match(/pickNewestChartedSession\(/g) ?? []).length,
    ).toBe(2);
    expect(LOADER_CODE).not.toMatch(/candidates\[0\]\s*\?\?\s*null/);
    // And the companion applies the shared filters rather than its own.
    expect(LOADER_CODE).toMatch(
      /chartedSessionCandidates\(rows, \{[\s\S]{0,200}excludeAppointmentId: input\.excludeAppointmentId/,
    );
  });

  it("no calendar-specific charted-session classifier exists", () => {
    for (const banned of [
      "hasChartedContent",
      "pickNewestChartedSession",
      "chartedSessionCandidates",
      "pickLastTreatment",
      "buildLastSessionSummary",
    ]) {
      expect(
        PAGE_CODE,
        `${PAGE_PATH} must not restate the charted-session rule (${banned})`,
      ).not.toContain(banned);
    }
  });

  it("no stale comment still claims newest-row behaviour", () => {
    expect(PAGE).not.toMatch(/Most recent non-deleted session that began before/);
    expect(PAGE).toMatch(
      /Appointment preparation uses the same newest-charted-treatment authority/,
    );
  });

  it("the removed LastSessionCard is not left behind as dead code", () => {
    expect(PAGE_CODE).not.toMatch(/function LastSessionCard/);
    expect(PAGE_CODE).not.toMatch(/<LastSessionCard/);
  });
});

describe("the linked-session query is separate and unchanged", () => {
  it("still reads sessions by this appointment id", () => {
    expect(PAGE_CODE).toMatch(/\.eq\("appointment_id", id\)/);
    expect(PAGE_CODE).toMatch(/linkedSession = \(linkedSessionRes\.data \?\? null\)/);
  });

  it("the View session affordance still points at the LINKED session", () => {
    expect(PAGE_CODE).toMatch(
      /\/clients\/\$\{clientId\}\/sessions\/\$\{linkedSession\.id\}/,
    );
  });

  it("ChartSessionCard still receives the linked session", () => {
    expect(PAGE_CODE).toMatch(/linkedSession=\{linkedSession\}/);
  });
});

describe("full narrative is rendered WHOLE", () => {
  it("no line clamping anywhere on the card", () => {
    expect(CARD_CODE).not.toMatch(/line-clamp/);
  });

  it("no substring truncation of clinical text anywhere in the feature", () => {
    for (const [name, src] of [
      ["card", CARD],
      ["model", MODEL],
    ] as const) {
      const code = codeOnly(src);
      // Scoped to TEXT, not to any slice: the model legitimately slices an
      // ARRAY of passes when comparing readings. What must never happen is a
      // stored clinical string being cut.
      expect(code, `${name} must not slice clinical text`).not.toMatch(
        /\b\w*(text|note|notes|comment|comments|body|excerpt|label)\b\s*\.\s*(slice|substring|substr)\(/i,
      );
      expect(code, `${name} must not substring clinical text`).not.toMatch(
        /\.substr\(/,
      );
      // And no character-count cap of the kind clinical-summary applies at 140.
      expect(code, `${name} must not cap clinical text by length`).not.toMatch(
        /\.length\s*[<>]=?\s*\d{2,}/,
      );
      expect(code, `${name} must not excerpt`).not.toMatch(/noteExcerpt|excerptChars/);
      expect(code, `${name} must not append an ellipsis`).not.toContain("…");
    }
  });

  it("free text is rendered with whitespace-pre-wrap and break-words", () => {
    // Every <p> that prints a stored note carries both: pre-wrap keeps the
    // practitioner's paragraph breaks, break-words keeps a long unbroken run
    // from scrolling the page sideways at 390px.
    const preWrap = CARD.match(/whitespace-pre-wrap/g) ?? [];
    expect(preWrap.length).toBeGreaterThanOrEqual(3);
    for (const m of CARD.match(/whitespace-pre-wrap[^"]*/g) ?? []) {
      expect(m, `"${m}" must also break-words`).toContain("break-words");
    }
  });

  it("no fixed-width or horizontal-scroll container is introduced", () => {
    expect(CARD_CODE).not.toMatch(/overflow-x/);
    expect(CARD_CODE).not.toMatch(/whitespace-nowrap/);
    expect(CARD_CODE).not.toMatch(/\bw-\[/);
  });

  it("the notes section is never suppressed — the empty state is explicit", () => {
    expect(MODEL).toMatch(/NO_LAST_SESSION_NOTES_COPY/);
    expect(CARD).toMatch(/NO_LAST_SESSION_NOTES_COPY/);
    expect(CARD).toMatch(/data-testid="prep-notes-empty"/);
  });
});

describe("read-only, RLS-scoped, no service role", () => {
  it("no service-role client anywhere in the feature", () => {
    for (const [name, src] of [
      ["page", PAGE],
      ["card", CARD],
      ["model", MODEL],
      ["loader", LOADER],
      ["selector", SELECTOR],
    ] as const) {
      // The page already carried ONE pre-existing service-role dependency for
      // manual-fee eligibility (lib/billing/manual-fee-eligibility.ts). This
      // change adds none, and imports none directly.
      expect(src, `${name} must not construct an admin client`).not.toMatch(
        /createAdminClient/,
      );
      expect(src, `${name} must not import admin-server`).not.toMatch(/admin-server/);
      expect(src, `${name} must not name the service-role key`).not.toMatch(
        /SERVICE_ROLE/,
      );
    }
  });

  it("the companion loader uses the authenticated user client and is studio-scoped", () => {
    expect(LOADER).toMatch(
      /import \{ createClient \} from "@\/lib\/supabase\/server"/,
    );
    expect(LOADER).toMatch(/\.eq\("studio_id", input\.studioId\)/);
    expect(LOADER).toMatch(/\.eq\("client_id", input\.clientId\)/);
  });

  it("the candidate read is BOUNDED — no unbounded client history", () => {
    expect(LOADER).toMatch(/DEFAULT_CHARTED_SESSION_LIMIT/);
    expect(codeOnly(LOADER)).toMatch(/\.limit\(limit\)/);
  });

  it("the candidate read pushes the time bound down, so the window is not wasted", () => {
    expect(codeOnly(LOADER)).toMatch(
      /if \(input\.before\) query = query\.lt\("started_at", input\.before\)/,
    );
  });

  it("the blocks read stays batched — no N+1 per session, block, area or CLIENT", () => {
    expect(LOADER).toMatch(/\.in\(\s*"session_id",/);
    // TWO entry points now — the per-client loader and the batched companion
    // the dashboard uses — so the count is two, not one. Counting alone was
    // never the real guarantee anyway; what follows is.
    expect((LOADER_CODE.match(/from\("session_blocks"\)/g) ?? []).length).toBe(2);
    expect((LOADER_CODE.match(/from\("sessions"\)/g) ?? []).length).toBe(2);
    // EVERY block read is keyed by an `.in(...)` list, never by a single id —
    // that is what makes each one a batch rather than a per-row round-trip.
    for (const seg of LOADER_CODE.split('from("session_blocks")').slice(1)) {
      const head = seg.slice(0, 500);
      expect(head, "every block read must be batched").toMatch(/\.in\(\s*\n?\s*"session_id",/);
      expect(head, "never a single-session block read").not.toMatch(/\.eq\("session_id"/);
    }
    // The batched companion reads MANY clients in one statement.
    expect(LOADER_CODE).toMatch(/\.in\("client_id", clientIds\)/);
    // No read of any kind inside a loop.
    for (const m of LOADER_CODE.matchAll(/for \(const [^)]+\) \{/g)) {
      const body = LOADER_CODE.slice(m.index!, LOADER_CODE.indexOf("\n  }", m.index!));
      expect(body, "no query inside a loop").not.toMatch(/await supabase|\.from\(/);
    }
    // Structured areas ride along INSIDE the block select — never a separate
    // per-block round-trip.
    expect(LOADER_CODE).not.toMatch(/from\("session_block_areas"\)/);
    expect(LOADER).toMatch(/structured_areas:session_block_areas\(/);
  });

  it("the feature performs no writes", () => {
    for (const src of [CARD, MODEL, LOADER, SELECTOR]) {
      const code = codeOnly(src);
      expect(code).not.toMatch(/\.insert\(/);
      expect(code).not.toMatch(/\.update\(/);
      expect(code).not.toMatch(/\.delete\(/);
      expect(code).not.toMatch(/\.upsert\(/);
      expect(code).not.toMatch(/\.rpc\(/);
    }
  });

  it("the card is presentation only — no client state, no form, no action", () => {
    expect(CARD).not.toMatch(/"use client"/);
    expect(CARD).not.toMatch(/<form/);
    expect(CARD).not.toMatch(/useState|useTransition|action=/);
    expect(CARD).not.toMatch(/console\./);
  });

  it("the pure model does no I/O and logs nothing", () => {
    // Code lines only: a comment may legitimately mention the server-only
    // loader while explaining why a type lives here instead.
    const code = codeOnly(MODEL);
    expect(code).not.toMatch(/console\./);
    expect(code).not.toMatch(/^import .*server-only|createClient|fetch\(/m);
    // Positive anchor — prove we are reading the real module, not an empty
    // string, so the three negatives above cannot pass vacuously.
    expect(code).toMatch(/export function buildAppointmentPrepMemory/);
  });

  it("no raw database message can reach a log from the new read", () => {
    const code = codeOnly(LOADER);
    expect(code).not.toMatch(/error\.message/);
    expect(code).not.toMatch(/message:/);
  });

  it("the page no longer throws a raw DB message for the previous treatment", () => {
    // The old path did: `Failed to load last session: ${error.message}`.
    expect(PAGE_CODE).not.toMatch(/Failed to load last session/);
  });
});

describe("the retired galvanic input is never read", () => {
  it("no surface in this feature reads it", () => {
    // Comments are allowed to say WHY it is absent; code is not allowed to
    // select, map or render it.
    for (const [name, code] of [
      ["page", PAGE_CODE],
      ["card", CARD_CODE],
      ["model", codeOnly(MODEL)],
      ["loader", LOADER_CODE],
    ] as const) {
      expect(code, `${name} must not read the retired input`).not.toMatch(
        /galvanic_intensity_percent|galvanicIntensity/,
      );
    }
  });
});

describe("appointment lifecycle, payment and Google Calendar are untouched", () => {
  it("every appointment lifecycle affordance is still present", () => {
    for (const marker of [
      "AppointmentLifecycleActions",
      "PractitionerCancelForm",
      "MoveAppointmentButton",
      "AppointmentCheckoutCell",
      "ManualFeeChargeCard",
      "getAppointmentPaymentStates",
      "getManualFeeChargeEligibility",
      "PostcareSendButton",
      "PostcareSection",
      "appointmentDisplayStatus",
    ]) {
      expect(PAGE, `${marker} must survive this change`).toContain(marker);
    }
  });

  it("the chart-session forward-link contract is unchanged", () => {
    expect(PAGE_CODE).toMatch(
      /\/clients\/\$\{clientId\}\/sessions\/new\?appointment_id=\$\{encodeURIComponent\(appointmentId\)\}/,
    );
  });

  it("no Google Calendar code is referenced by this feature", () => {
    for (const src of [CARD, MODEL, LOADER]) {
      expect(src).not.toMatch(/google|calendar_event|outbox/i);
    }
  });
});

describe("Sessions 1A / 1B / 1C vocabulary is reused, never forked", () => {
  it("the model imports the shared builders instead of restating them", () => {
    expect(MODEL).toMatch(
      /import \{[\s\S]*buildPointOfCareMemory[\s\S]*\} from "@\/lib\/sessions\/point-of-care-memory"/,
    );
    expect(MODEL).toMatch(
      /import \{ formatAreaLabel, resolveBlockAreas \} from "@\/lib\/sessions\/block-areas"/,
    );
  });

  it("no display vocabulary is re-derived in the model", () => {
    for (const banned of [
      "Thermolysis",
      "Numbing used",
      "Lot #",
      "readingFieldOrder",
      "toleranceLabel",
      "unifiedReactionLabels",
      "apilusModalityLabel",
    ]) {
      expect(
        MODEL,
        `${banned} belongs to a shared helper — do not fork it here`,
      ).not.toContain(banned);
    }
  });

  it("blockless copy comes from the ONE shared vocabulary", () => {
    expect(MODEL).not.toMatch(/charted as laser passes/);
    expect(CARD).not.toMatch(/charted as laser passes/);
  });

  it("the entry narrative is the WHOLE stored column, not the chip-hydration remainder", () => {
    // REGRESSION GUARD (adversarial review, P1). resolveDisplayChips promotes
    // canonical tokens out of `comments` into a chip list, but only when
    // observation_chips is EMPTY — which is exactly when this card's response
    // line (built from that same raw column) is empty too. Taking the remainder
    // therefore deleted text that nothing else here renders, and the card then
    // printed "No notes recorded at the last session." over it.
    const MEMORY = read("lib/sessions/point-of-care-memory.ts");
    expect(codeOnly(MEMORY)).not.toMatch(/resolveDisplayChips/);
    expect(MEMORY).toMatch(/const note = trimmedOrNull\(e\.comments\);/);
  });
});

describe("the plan source is decoupled from the treatment source", () => {
  it("the loader scans EVERY candidate for the newest next-visit note", () => {
    // REGRESSION GUARD (adversarial review, P1). A plan can be written on a
    // session that never got charted, and that note is the one most likely to
    // change what happens today. Three other pre-visit surfaces already
    // decouple this (PR #203); reading only the selected treatment's own note
    // made the appointment page the one that silences it.
    expect(LOADER_CODE).toMatch(/function newestPlanOf/);
    expect(LOADER_CODE).toMatch(/const text = c\.next_session_note\?\.trim\(\);/);
    expect(LOADER_CODE).toMatch(/plan: newestPlanOf\(candidates\)/);
    // Charted-ness is deliberately NOT required — the scan runs over the raw
    // candidate window, not over the selected treatment.
    expect(LOADER_CODE).not.toMatch(
      /newestPlanOf\((selected|\[selected\])\)/,
    );
  });

  it("the page hands that plan to the model, and the card names its origin", () => {
    // SETTLED: the card slot is the treatment's OWN plan; cross-visit
    // narrative renders on the attributed external surface instead.
    expect(PAGE_CODE).toMatch(/ownPlan: memory\?\.notes\.forNextVisit\?\.text/);
    expect(CARD_CODE).not.toMatch(/forNextVisitFromLaterVisit/);
  });
});

describe("a failed read is not a clinical claim of 'no history'", () => {
  it("the loader reports unavailability distinctly from absence", () => {
    expect(LOADER_CODE).toMatch(/unavailable: true/);
    expect(LOADER_CODE).toMatch(/treatment, unavailable: false/);
  });

  it("the page renders a DIFFERENT surface for a failed read", () => {
    expect(PAGE_CODE).toMatch(/if \(unavailable && !memory\) \{/);
    expect(PAGE_CODE).toMatch(/data-testid="appointment-prep-unavailable"/);
    expect(PAGE_CODE).toMatch(/Previous treatment could not be loaded/);
    // And the "no history" sentence is still reserved for a successful read.
    expect(PAGE_CODE).toMatch(/No previous treatment charted for this client/);
  });
});

describe("narrative survives without a charted treatment (final-review P2 #2)", () => {
  it("the loader resolves narrative BEFORE and independently of the block read", () => {
    // The defect: newestPlanOf sat after `if (!selected) return null`, so a
    // consultation-only visit's plan was structurally unreachable.
    // Scoped to the COMPANION body: `selectFromCandidates` is also called by
    // the shared loader earlier in the file, and indexOf would find that one.
    const companion = LOADER_CODE.slice(
      LOADER_CODE.indexOf("export async function loadLastChartedTreatmentForClient"),
    );
    const planIdx = companion.indexOf("plan: newestPlanOf(candidates)");
    const selectIdx = companion.indexOf("await selectFromCandidates(input.studioId, candidates)");
    expect(planIdx).toBeGreaterThan(-1);
    expect(selectIdx).toBeGreaterThan(-1);
    expect(planIdx).toBeLessThan(selectIdx);
    expect(LOADER_CODE).toMatch(/legacySessionNotes: newestLegacyNotesOf\(candidates\)/);
  });

  it("narrative is NOT nested inside LastChartedTreatment", () => {
    // Nesting is what made it impossible to return when no treatment exists.
    //
    // POSITIVE ANCHORS FIRST. slice() with a missing anchor returns "", and
    // `expect("").not.toMatch(...)` passes — so without these the guard would
    // go green the moment the type were renamed.
    const start = LOADER_CODE.indexOf("export type LastChartedTreatment");
    const end = LOADER_CODE.indexOf("export type { PrepNarrativeItem }");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const t = LOADER_CODE.slice(start, end);
    expect(t.length).toBeGreaterThan(40);
    expect(t).toMatch(/supersededByEmptySession/); // proves we sliced the type
    expect(t).not.toMatch(/newestPlan|narrative/);
  });

  it("every load outcome carries narrative, and only a candidate-read failure has none", () => {
    expect(LOADER_CODE).toMatch(/case "selected":[\s\S]{0,120}unavailable: false, narrative/);
    expect(LOADER_CODE).toMatch(/case "none":[\s\S]{0,200}unavailable: false, narrative/);
    expect(LOADER_CODE).toMatch(/case "unavailable":[\s\S]{0,200}unavailable: true, narrative/);
  });

  it("newestPlanOf remains the ONE plan authority", () => {
    expect((LOADER_CODE.match(/next_session_note\?\.trim\(\)/g) ?? []).length).toBe(1);
    expect((LOADER_CODE.match(/function newestPlanOf/g) ?? []).length).toBe(1);
  });

  it("a block-read failure is a distinct outcome, never inferred from null", () => {
    expect(LOADER_CODE).toMatch(/status: "unavailable"/);
    expect(LOADER_CODE).toMatch(/status: "none"/);
    // The old bug: hardcoding unavailable:false after selection.
    expect(LOADER_CODE).not.toMatch(/return \{ treatment, unavailable: false \}/);
  });

  it("the shared loader keeps its fail-soft contract for other surfaces", () => {
    expect(LOADER_CODE).toMatch(
      /outcome\.status === "selected" \? outcome\.treatment : null/,
    );
  });

  it("the page renders narrative in the unavailable, no-treatment AND card states", () => {
    expect((PAGE_CODE.match(/<PriorNarrative /g) ?? []).length).toBe(3);
    expect(PAGE_CODE).toMatch(/data-testid="prep-prior-narrative"/);
  });

  it("ownership is decided by the pure helper, not by JSX position", () => {
    // The old guard compared render ORDER and a render COUNT. Both are
    // satisfiable by the duplication they claimed to exclude — moving a render
    // above the card keeps the count at 2 and the ordering true. Position is
    // not the property that matters; OWNERSHIP is, and it is decided in one
    // pure function whose behaviour is pinned in
    // tests/lib/sessions/appointment-prep-memory.test.ts (F1-F6).
    expect(PAGE_CODE).toMatch(/buildPrepProvenanceModel\(\{/);
    // The page must never decide ownership or chronology itself.
    expect(PAGE_CODE).not.toMatch(/sessionId !==/);
    expect(PAGE_CODE).not.toMatch(/new Date\([^)]*startedAt/);
    // Every render site consumes the model's output.
    const sites = PAGE_CODE.match(/<PriorNarrative [^>]*>/g) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const site of sites) {
      expect(site, `${site} must render model output`).toMatch(/items=\{external\}/);
    }
  });

  it("the card branch renders narrative the card does NOT own", () => {
    // The P2 this closes: a newer uncharted visit's legacy notes were loaded
    // and rendered nowhere whenever an older charted treatment existed.
    const cardIdx = PAGE_CODE.indexOf("<AppointmentPrepMemoryCard");
    expect(cardIdx).toBeGreaterThan(-1);
    const after = PAGE_CODE.slice(cardIdx);
    expect(after).toMatch(/data-testid="appointment-prep-external-narrative"/);
    expect(after).toMatch(/<PriorNarrative items=\{external\} \/>/);
  });

  it("chronology is stated in BOTH directions, never one", () => {
    // The blocker: only the "after" clause existed, so an OLDER plan rendered
    // undated and that silence read as "written at the treatment above".
    expect(PAGE_CODE).toMatch(/after_selected_treatment/);
    expect(PAGE_CODE).toMatch(/before_selected_treatment/);
    expect(PAGE_CODE).toMatch(/, after the treatment above/);
    expect(PAGE_CODE).toMatch(/, before the treatment above/);
    // Never an inference the data cannot support — scoped to the narrative
    // renderer, since "completed" is also an appointment STATUS elsewhere.
    const block = functionBody(PAGE_CODE, "PriorNarrative");
    expect(block).toMatch(/item\.chronology/); // proves we sliced the renderer
    expect(block).not.toMatch(/still applies|supersedes|resolved|completed/i);
  });

  it("every fallback item is dated — provenance, never a session id", () => {
    expect(PAGE_CODE).toMatch(/data-testid="prep-prior-date"/);
    expect(PAGE_CODE).toMatch(/<FormattedDateTime iso=\{item\.startedAt\}/);
    // A raw session id must never reach the UI.
    expect(PAGE_CODE).not.toMatch(/\{item\.sessionId\}/);
  });

  it("a note-only row is never called a treatment", () => {
    expect(PAGE_CODE).toMatch(/No previous treatment charted for this client/);
    expect(CARD_CODE).not.toMatch(/PriorNarrative/);
    expect(PAGE_CODE).toMatch(/From another visit/);
  });

  it("fallback narrative is full text — pre-wrap, break-words, no clamp", () => {
    const block = functionBody(PAGE_CODE, "PriorNarrative");
    expect(block).toMatch(/item\.text/); // proves we sliced the renderer
    expect((block.match(/whitespace-pre-wrap break-words/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(block).not.toMatch(/line-clamp|\.slice\(|substring/);
  });
});
