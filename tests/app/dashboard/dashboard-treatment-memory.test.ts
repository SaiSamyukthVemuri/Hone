import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compactSummary } from "@/lib/dashboard/today-treatment-summary";
import type { AppointmentPrepMemory } from "@/lib/sessions/appointment-prep-memory";

// ===========================================================================
// Dashboard V2 Part 2A — previous treatment on the Today row.
// ===========================================================================
//
// Two kinds of assertion, and the split is deliberate:
//
//   * `compactSummary` is pure and exported, so the "missing historical values
//     render truthfully" requirement is tested BEHAVIOURALLY — that is the one
//     that matters clinically and it must not be a source grep.
//   * The wiring (which component mounts where, with which props) is asserted
//     on SOURCE, because this repo runs vitest with `environment: "node"` and
//     ships no React render harness. Standing one up for this PR would be a far
//     larger change than the feature. The trade-off is stated rather than
//     hidden: these prove the JSX, not the painted pixels; the browser lane
//     proves the rest.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const MEMORY_UI = read("app/(app)/dashboard/dashboard-treatment-memory.tsx");
/**
 * Source with `//` lines and `{/* jsx *\/}` blocks removed. Prose that
 * legitimately NAMES a thing must not satisfy a guard looking for that thing
 * being rendered — the comment explaining why "For next visit" is not repeated
 * would otherwise fail the test asserting it is not repeated.
 */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const MEMORY_UI_CODE = codeOnly(MEMORY_UI);
const DASH = read("app/(app)/dashboard/page.tsx");
const CARD = read("components/appointment-prep-memory-card.tsx");
const MODEL = read("lib/sessions/appointment-prep-memory.ts");

function memory(over: Partial<AppointmentPrepMemory> = {}): AppointmentPrepMemory {
  return {
    sessionId: "s-1",
    startedAt: "2026-01-10T10:00:00Z",
    modality: "electrolysis",
    areaHeadline: "Chin",
    totalMinutes: 30,
    totalHairs: 120,
    areas: [],
    notes: {
      general: [],
      forNextVisit: null,
      cautions: [],
      additional: [],
      responses: [],
      hasAny: false,
    },
    blocklessNote: null,
    supersededByEmptySession: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("compact summary — missing history is absent, never a fake zero", () => {
  it("names the visit: date, modality, areas, minutes", () => {
    const s = compactSummary(memory());
    expect(s).toMatch(/2026/);
    expect(s).toContain("electrolysis");
    expect(s).toContain("Chin");
    expect(s).toContain("30 min");
  });

  it("omits minutes entirely when they were never recorded", () => {
    // The clinical point: a legacy visit with no recorded minutes did NOT take
    // zero minutes, and must never read as "0 min".
    const s = compactSummary(memory({ totalMinutes: null }));
    expect(s).not.toMatch(/min/);
    expect(s).not.toMatch(/\b0\b/);
  });

  it("DISTINGUISHES a recorded zero from an absent value", () => {
    // The two-way self-test. `0` is a real measurement and must survive;
    // omitting it would be the opposite lie.
    expect(compactSummary(memory({ totalMinutes: 0 }))).toContain("0 min");
    expect(compactSummary(memory({ totalMinutes: null }))).not.toContain("min");
  });

  it("omits an unrecorded area headline rather than inventing one", () => {
    const s = compactSummary(memory({ areaHeadline: null }));
    expect(s).not.toContain("Chin");
    expect(s).not.toMatch(/undefined|null|Not recorded/);
  });

  it("survives an unparseable date truthfully", () => {
    expect(compactSummary(memory({ startedAt: "not-a-date" }))).toContain(
      "Date not recorded",
    );
  });

  it("never emits empty separators when several fields are absent", () => {
    const s = compactSummary(
      memory({ areaHeadline: null, totalMinutes: null, modality: "" }),
    );
    expect(s).not.toMatch(/·\s*·/);
    expect(s.trim()).not.toMatch(/·\s*$/);
  });
});

describe("the disclosure is accessible and calm by default", () => {
  it("is a real button carrying aria-expanded and aria-controls", () => {
    expect(MEMORY_UI).toMatch(/type="button"/);
    expect(MEMORY_UI).toMatch(/aria-expanded=\{open\}/);
    expect(MEMORY_UI).toMatch(/aria-controls=\{regionId\}/);
    // The controlled region must actually carry that id.
    expect(MEMORY_UI).toMatch(/id=\{regionId\}/);
  });

  it("starts CLOSED, so Today is calm by default", () => {
    expect(MEMORY_UI).toMatch(/useState\(false\)/);
    // The heavy card is mounted only when open — a calm Today does not pay to
    // render every client's full chart.
    expect(MEMORY_UI).toMatch(/\{open && \(/);
  });

  it("the toggle names the client, so repeated rows are distinguishable", () => {
    // Twenty rows of "View full last treatment" are indistinguishable to a
    // screen reader navigating by control.
    expect(MEMORY_UI).toMatch(/View full last treatment for \$\{clientName\}/);
    expect(MEMORY_UI).toMatch(/Hide full last treatment for \$\{clientName\}/);
  });

  it("the collapsed region is hidden from the accessibility tree, not just visually", () => {
    expect(MEMORY_UI).toMatch(/hidden=\{!open\}/);
  });
});

describe("expanding reuses the #517 card — it does not reimplement it", () => {
  it("mounts AppointmentPrepMemoryCard, embedded", () => {
    expect(MEMORY_UI).toMatch(
      /import \{ AppointmentPrepMemoryCard \} from "@\/components\/appointment-prep-memory-card"/,
    );
    expect(MEMORY_UI).toMatch(
      /<AppointmentPrepMemoryCard\s+clientId=\{clientId\}\s+memory=\{result\.memory\}\s+embedded\s+showFullChartLink=\{false\}\s*\/>/,
    );
  });

  it("declares no treatment model of its own", () => {
    // The whole point: one model. This file may name the type and nothing else.
    expect(MEMORY_UI).not.toMatch(/function build[A-Z]/);
    expect(MEMORY_UI).not.toMatch(/\.from\(|supabase/);
    expect(MEMORY_UI).not.toMatch(/interface .*Memory|type AppointmentPrepMemory =/);
  });

  it("the embedded variant lowers the heading rank instead of forking the card", () => {
    // "Last treatment" is an h2 on the appointment page, where it IS a section.
    // Inside a Today row it is a detail of that row.
    expect(CARD).toMatch(/embedded \? \(\s*<h4/);
    expect(CARD).toMatch(/<h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">/);
    // ...and drops its own border so a nested card does not double every edge.
    expect(CARD).toMatch(/embedded\s*\?\s*"flex flex-col gap-4"/);
  });
});

describe("every #517 field family is reachable from Today", () => {
  // The chain is: Today mounts the card (asserted above) -> the card renders the
  // family -> the model carries it. Both ends are pinned so a family cannot be
  // dropped from either without failing here.
  it.each([
    ["treatment areas", /data-testid="prep-areas"/, /areaHeadline/],
    ["per-area labels + laterality", /data-testid="prep-area-label"/, /areaParts/],
    ["modality", /memory\.modality/, /modality: string/],
    ["machine settings", /data-testid="prep-setup-area"/, /energyLevel/],
    ["probe and lot", /probeLine/, /"probeLine"/],
    ["observations / outcomes", /data-testid="prep-outcome-area"/, /outcomeRecorded/],
    ["skin response + tolerance", /responseLine/, /"toleranceLine"/],
    ["additional notes", /notes\.additional/, /additional: AreaNarrativeItem\[\]/],
    ["complete session notes", /notes\.general/, /general: NarrativeItem\[\]/],
    ["caution", /notes\.cautions/, /cautions: AreaNarrativeItem\[\]/],
    ["next-visit note", /notes\.forNextVisit/, /forNextVisit: NarrativeItem \| null/],
  ])("%s is rendered by the card and modelled", (_family, inCard, inModel) => {
    expect(CARD, `card must render ${_family}`).toMatch(inCard);
    expect(MODEL, `model must carry ${_family}`).toMatch(inModel);
  });

  it("the card also states when a family was NOT recorded", () => {
    // Truthfulness at the family level, not just the value level.
    expect(CARD).toMatch(/setupRecorded/);
    expect(CARD).toMatch(/outcomeRecorded/);
    expect(CARD).toMatch(/data-testid="prep-notes-empty"/);
    // A charted visit with no settings blocks (laser, pre-0019 electrolysis)
    // says what the record IS rather than "Area not recorded".
    expect(CARD).toMatch(/data-testid="prep-no-blocks"/);
    expect(MODEL).toMatch(/blocklessNote/);
  });
});

// ===========================================================================
// CHLOE D1 — expanding the disclosure must not navigate. Ever.
// ===========================================================================
// REPORTED DEFECT: "View full last treatment" expands briefly and then takes
// her to the full-session page.
//
// ROOT CAUSE, two overlapping faults with one shape — the disclosure was
// rendered INSIDE the Today row's body <Link href="/calendar/{id}">:
//
//   1. the toggle <button>'s click bubbled to that ancestor link, so one press
//      both opened the region and pushed a route;
//   2. once open, the embedded card rendered an <a> ("Open full chart →")
//      inside an <a>, which is invalid HTML with undefined activation.
//
// FIX, in two halves, both pinned here:
//   * the disclosure is a SIBLING of the row link, not a descendant;
//   * the embedded card is denied the full-chart CTA via an explicit
//     capability, while the standalone appointment-prep card keeps it.
//
// These are SOURCE assertions (this repo runs vitest in `environment: "node"`
// with no React harness — see the header note). The behavioural proof that the
// URL does not change lives in e2e/dashboard-treatment-memory-inline.spec.ts,
// which clicks the real control in a real browser and waits.
describe("D1: the disclosure never navigates away from the Dashboard", () => {
  /** The whole source span of the Today row's body <Link>, opening tag included. */
  function rowBodyLink(): string {
    const open = DASH.indexOf("<Link\n          href={`/calendar/${appt.id}`}");
    expect(open, "the row-body calendar link must exist").toBeGreaterThan(-1);
    const close = DASH.indexOf("</Link>", open);
    expect(close).toBeGreaterThan(open);
    return DASH.slice(open, close + "</Link>".length);
  }

  /**
   * The link's CHILDREN only — everything after its own opening tag closes.
   * The nested-interactive guards must read this, not the whole span: the span
   * starts with `<Link`, which trivially satisfies a "contains a link" grep and
   * would make the guard vacuous.
   */
  function rowBodyLinkChildren(): string {
    const span = rowBodyLink();
    const endOfOpenTag = span.indexOf(">\n");
    expect(endOfOpenTag, "the opening tag must terminate").toBeGreaterThan(-1);
    return span.slice(endOfOpenTag + 1);
  }

  it("the row body still opens the appointment — nothing was removed", () => {
    // The fix must not cost the row its navigation; only the disclosure leaves.
    expect(rowBodyLink()).toMatch(/href=\{`\/calendar\/\$\{appt\.id\}`\}/);
  });

  it("the disclosure is OUTSIDE that link, so a click cannot bubble into it", () => {
    const link = rowBodyLink();
    expect(
      link,
      "DashboardTreatmentMemory must not be a descendant of the row-body link",
    ).not.toContain("<DashboardTreatmentMemory");
    // Self-check: the span really is the row body and not an empty slice.
    // The preparation lines moved into <PreVisitPrepBlock>, which renders INSIDE
    // this link exactly where they were, so it is the anchor now.
    expect(link).toContain("<PreVisitPrepBlock");
    // ...and it is still rendered on the page, as a sibling.
    expect(DASH).toContain("<DashboardTreatmentMemory");
    expect(DASH.indexOf("<DashboardTreatmentMemory")).toBeGreaterThan(
      DASH.indexOf(rowBodyLink()) + rowBodyLink().length - 1,
    );
  });

  it("NO interactive element is left inside the row-body link", () => {
    // The general rule the bug broke, not just this one instance: a <button>,
    // a nested <a>, or a nested <Link> inside an anchor is invalid content and
    // its activation behaviour is undefined. Guards the whole row, so the next
    // control someone adds cannot recreate this.
    const children = rowBodyLinkChildren();
    // Self-check first: an empty or mis-sliced string would pass every guard.
    expect(children).toContain("<PreVisitPrepBlock");
    expect(children, "no nested link").not.toMatch(/<Link\b|<a\b/);
    expect(children, "no nested button").not.toMatch(/<button\b/);
    expect(children, "no click handler inside the link body").not.toMatch(
      /onClick/,
    );

    // ...AND no component that ENCAPSULATES a control. A negative control
    // caught this gap: re-nesting <DashboardTreatmentMemory> inside the link — the
    // exact defect — left every raw-tag guard above green, because the button
    // lives one file away. Raw-tag greps cannot see through a component
    // boundary, so the known-interactive children of this row are named.
    for (const component of [
      "DashboardTreatmentMemory", // owns the disclosure <button>
      "AppointmentCheckoutCell", // owns the checkout control
      "PilotFeedbackPrompt", // mailto anchors
      "DashboardTodoList", // rows of links
    ]) {
      expect(
        children,
        `<${component}> renders a control and must not sit inside the row link`,
      ).not.toContain(`<${component}`);
    }
  });

  it("the toggle does not fake a fix with stopPropagation", () => {
    // A stopPropagation() patch would silence the React synthetic bubble and
    // leave the invalid nesting — and native anchor activation — in place. The
    // structural fix is the real one, so the workaround must be absent.
    expect(MEMORY_UI_CODE).not.toMatch(/stopPropagation|preventDefault/);
  });

  it("the EMBEDDED card carries no full-chart navigation CTA", () => {
    expect(MEMORY_UI).toMatch(/showFullChartLink=\{false\}/);
    // Both of the card's "Open full chart →" affordances obey the capability —
    // the header one and the one in the blockless branch. Neither may be
    // unconditional, or the Dashboard disclosure gets a link out anyway.
    const cta = [...CARD.matchAll(/Open full chart →/g)];
    expect(cta.length, "the card has exactly two full-chart affordances").toBe(2);
    for (const m of cta) {
      const preceding = CARD.slice(Math.max(0, m.index! - 400), m.index!);
      expect(
        preceding,
        "every full-chart link must be gated on showFullChartLink",
      ).toMatch(/\{showFullChartLink && \(/);
    }
  });

  it("the STANDALONE appointment-prep surface KEEPS its full-chart link", () => {
    // The other half of the contract: this is a capability, not a deletion.
    // The default is on, and the calendar appointment page does not turn it off.
    expect(CARD).toMatch(/showFullChartLink = true/);
    const apptPage = read("app/(app)/calendar/[id]/page.tsx");
    expect(apptPage).toMatch(/<AppointmentPrepMemoryCard/);
    expect(apptPage).not.toMatch(/showFullChartLink/);
  });

  it("the capability is EXPLICIT, not inferred from the layout flag", () => {
    // `embedded` is chrome + heading rank. Deriving navigation policy from a
    // styling flag is how the two silently re-couple.
    expect(CARD).toMatch(/showFullChartLink\?: boolean/);
    expect(CARD).not.toMatch(/showFullChartLink\s*=\s*!embedded/);
  });

  it("the clinical card was NOT forked to achieve any of this", () => {
    // One presentation component, one truth about what a treatment looked like.
    expect(DASH).not.toMatch(/DashboardPrepMemoryCard|PrepMemoryCardEmbedded/);
    expect(MEMORY_UI).toMatch(
      /import \{ AppointmentPrepMemoryCard \} from "@\/components\/appointment-prep-memory-card"/,
    );
    expect(
      existsSync(join(process.cwd(), "components/appointment-prep-memory-card.tsx")),
    ).toBe(true);
  });
});

describe("the Today row wires it correctly", () => {
  it("renders the memory only for a client who HAS history", () => {
    // A first visit stays one calm relationship line. (The gate moved out of
    // the row-body link with the component — see the D1 block above — so it now
    // reads `workflow?.hasHistory`, which is the same condition: hasHistory can
    // only be true when workflow exists.)
    // The gate was `workflow?.hasHistory`, which is null OFF TODAY by
    // construction — so this region vanished on exactly the days a
    // practitioner opens in order to PREPARE. It now asks the prep loader's
    // own three-state answer, which is self-sufficient and never borrows the
    // Before-Today history model.
    expect(DASH).not.toMatch(/\{workflow\?\.hasHistory && \(/);
    expect(DASH).toMatch(
      /\{\(prepSummary\.hasTreatment \|\| prepSummary\.unavailable\) && \(/,
    );
    expect(DASH).toMatch(/<DashboardTreatmentMemory/);
  });

  it("passes the memory keyed by APPOINTMENT, not by client", () => {
    // Two same-client appointments must each get their own boundary.
    expect(DASH).toMatch(/prepSummaryByAppointment\.get\(appt\.id\)/);
    expect(DASH).toMatch(/prepSummary=\{/);
  });

  it("builds one request per appointment, carrying that appointment's bounds", () => {
    expect(DASH).toMatch(/before: a\.starts_at/);
    expect(DASH).toMatch(/excludeAppointmentId: a\.id/);
    // The APPOINTMENT is the request identity. Without it, two bookings for one
    // client collide in the loader's result map and both rows show the same
    // memory — a real bug this shape prevents.
    expect(DASH).toMatch(/requestKey: a\.id/);
  });

  it("looks the load up by APPOINTMENT id, never by client id", () => {
    // The other half of the same bug: even with distinct requests, reading the
    // result back by `appt.client_id` hands both of a client's appointments
    // whichever entry was written last.
    expect(DASH).toMatch(/prepLoads\.get\(appt\.id\)/);
    expect(DASH, "a client-keyed lookup would collide").not.toMatch(
      /prepLoads\.get\(appt\.client_id\)/,
    );
  });

  it("loads the whole day in ONE batched call — no loop, no per-row await", () => {
    expect(
      (DASH.match(/loadLastChartedTreatmentsForClients\(/g) ?? []).length,
      "exactly one batched call",
    ).toBe(1);
    // The per-client loader must not appear on this page at all.
    expect(DASH).not.toMatch(/loadLastChartedTreatmentForClient\b/);
    // The fold that turns loads into per-appointment memories is pure.
    const fold = DASH.slice(
      DASH.indexOf("const prepSummaryByAppointment"),
      DASH.indexOf("// PR #214: recorded-history attention list"),
    );
    expect(fold.length).toBeGreaterThan(0);
    expect(fold, "no await inside the per-appointment fold").not.toMatch(/\bawait\b/);
    expect(fold, "no query inside the per-appointment fold").not.toMatch(/supabase|\.from\(/);
  });

  it("uses the SHARED mapper rather than a second hand-written input", () => {
    expect(DASH).toMatch(/prepMemoryInputFromTreatment\(load\.treatment\)/);
    // ...the same mapper the calendar appointment page uses.
    expect(read("app/(app)/calendar/[id]/page.tsx")).toMatch(
      /prepMemoryInputFromTreatment\(selected\)/,
    );
  });

  it("a failed or truncated read renders as 'could not load', never as 'new client'", () => {
    expect(MEMORY_UI).toMatch(/data-testid="dashboard-memory-unavailable"/);
    expect(MEMORY_UI).toMatch(/Previous treatment could not be loaded/);
    // The unavailable branch is checked BEFORE the no-treatment branch, so a
    // failed read can never fall through into silence. The values now come
    // from the compact projection rather than the full model, which no longer
    // crosses to the browser before the practitioner opens the row.
    expect(MEMORY_UI.indexOf("if (summary.unavailable)")).toBeLessThan(
      MEMORY_UI.indexOf("if (!summary.hasTreatment) return null"),
    );
    // …and the same distinction survives the on-demand load. `none` no longer
    // gets its own copy here — this disclosure only exists on a row that already
    // showed a treatment, so a re-read returning nothing is an unreproduced read,
    // not proof the client has no history. The server action keeps all three
    // states (pinned in prep-memory-action-authority.test.ts); it is the WORDING
    // on this surface that must not overclaim.
    expect(MEMORY_UI).toMatch(/result\.status === "loaded"/);
    expect(MEMORY_UI).not.toMatch(/No previous treatment to show/);
  });

  it("does not repeat the plan note that the row already shows as 'Remember'", () => {
    // sessions.next_session_note feeds BOTH the row's Remember line and the
    // model's forNextVisit. Printing one note twice under two labels is a bug
    // this row has already had once.
    expect(MEMORY_UI_CODE).not.toMatch(/For next visit/);
    // …and there is now exactly ONE renderer of that note, on every day.
    //
    // It used to be two: Today printed it from the Before-Today model inside the
    // row body, and every other day printed it from the prep loader as a
    // sibling, under a `!workflow` guard. Two renderers meant two authorities,
    // and they disagreed — the Today one had no appointment bound, so the same
    // appointment could show different text the day before versus on the day.
    const DASH_CODE = DASH.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    expect(DASH_CODE).not.toMatch(/prepSummary\.remember/);
    expect(DASH_CODE).toMatch(/<PreVisitPrepBlock prep=\{prep\}/);
    const BLOCK = read("app/(app)/dashboard/pre-visit-prep-block.tsx");
    expect(BLOCK.match(/Remember: /g) ?? []).toHaveLength(1);
  });

  it("writes nothing and touches no appointment mutation surface", () => {
    for (const src of [MEMORY_UI, read("lib/sessions/last-treatment-loader.ts")]) {
      expect(src).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
      expect(src).not.toMatch(/createAdminClient/);
    }
  });
});
