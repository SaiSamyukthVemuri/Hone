import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #238: Chloe pilot feedback cleanup. Five concrete fixes from her
// live mobile retest, all UX-only: search-input iOS zoom, stable
// client section selector, an obvious end of charting, friendlier
// procedure-record filter copy, and a worklist-first dashboard.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const SEARCH = read("app/(app)/GlobalSearch.tsx");
const TABBAR = read("components/profile-tab-bar.tsx");
const SESSION_PAGE = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
);
const RECORDS = read("app/(app)/records/page.tsx");
const DASH = read("app/(app)/dashboard/page.tsx");

describe("1. mobile search input does not trigger iOS zoom", () => {
  it("the mobile sheet input is 16px (text-base), not text-sm", () => {
    const className = SEARCH.match(
      /ref=\{inputRef\}[\s\S]*?className="([^"]*)"/,
    )?.[1];
    expect(className).toBeTruthy();
    expect(className).toMatch(/text-base/);
    expect(className).not.toMatch(/text-sm/);
  });

  it("no viewport zoom-disabling hacks anywhere", () => {
    for (const rel of ["app/layout.tsx", "app/(app)/GlobalSearch.tsx"]) {
      const src = read(rel);
      expect(src).not.toMatch(/user-scalable|maximum-scale/i);
    }
  });

  it("desktop input unchanged (it never renders on phones)", () => {
    const desktop = SEARCH.slice(SEARCH.indexOf('variant === "desktop"'));
    expect(desktop).toMatch(/min-h-\[40px\] w-full rounded-md[^"]*text-sm/);
  });
});

describe("2. client sections: stable select on phones", () => {
  it("the select carries all six sections and reflects the active one", () => {
    expect(TABBAR).toMatch(/value=\{active\}/);
    expect(TABBAR).toMatch(/onChange=\{\(e\) => pick\(e\.target\.value as ProfileTab\)\}/);
    expect(TABBAR).toMatch(/\{TABS\.map\(\(tab\) => \(\s*\n?\s*<option/);
    for (const label of [
      "Overview",
      "Sessions",
      "Treatment Plans",
      "Messages",
      "Health & Forms",
      "Personal Notes",
    ]) {
      expect(TABBAR).toMatch(new RegExp(`label: "${label.replace("&", "&")}"`));
    }
  });

  it("select is 16px-safe and touch sized; tab row hidden on phones", () => {
    const select = TABBAR.slice(
      TABBAR.indexOf("<select"),
      TABBAR.indexOf("</select>"),
    );
    expect(select).toMatch(/text-base/);
    expect(select).toMatch(/min-h-\[44px\]/);
    expect(TABBAR).toMatch(/md:hidden/);
    expect(TABBAR).toMatch(/hidden gap-x-5[^"]*md:flex/);
  });

  it("same pick() navigation for both controls; no business logic", () => {
    expect(TABBAR.match(/function pick\(/g)?.length).toBe(1);
    expect(TABBAR).not.toMatch(/supabase|createClient|fetch\(/);
  });
});

describe("3. charting: obvious finish, no new write path", () => {
  it("the Finish appointment section closes the charting page", () => {
    // The loose "Finish up" links block is replaced by the Finish appointment
    // workflow: same purpose (an obvious way OUT of charting, no new write
    // path), now with the completion + postcare controls she used to have to
    // hunt for on the calendar page.
    expect(SESSION_PAGE).toMatch(/Finish appointment/);
    expect(SESSION_PAGE).toMatch(
      /Review the visit, complete the appointment, and send postcare before/,
    );
    // The four visit-closing states are all named on this one surface.
    for (const step of [
      "Treatment chart",
      "Risks &amp; aftercare explained",
      "Appointment completed",
      "Postcare email",
    ]) {
      expect(SESSION_PAGE).toContain(step);
    }
    expect(SESSION_PAGE).toMatch(/Done, back to client/);
  });

  it("finish actions navigate to existing routes; no new session write/submit path", () => {
    // Scoped to the Finish section ONLY. The session-payment block now sits
    // directly below it (chart → finish → pay), and that block legitimately
    // contains forms, they are the payment card's, not a new session write.
    const finish = SESSION_PAGE.slice(
      SESSION_PAGE.indexOf('data-testid="finish-appointment"'),
      SESSION_PAGE.indexOf('id="session-payment"'),
    );
    // Charting PR 1: "Done charting" is now the non-blocking aftercare guard,
    // which navigates to the sessions tab (doneHref), still no session write.
    expect(finish).toMatch(/<DoneChartingButton/);
    expect(finish).toMatch(/doneHref=\{`\/clients\/\$\{id\}\?tab=sessions`\}/);
    expect(finish).toMatch(/label="Done, back to client"/);
    // The "Review appointment & billing" hop is GONE: the completion and
    // postcare controls it pointed at are now in this very section.
    expect(finish).not.toMatch(/Review appointment/);
    // no NEW session-save form/submit in the finish section (the aftercare mark
    // reuses the existing toggle action, not a new write path).
    expect(finish).not.toMatch(/<form|type="submit"|createSession|updateSession|addElectrolysis/);
  });

  it("finish links are touch sized and render above Delete", () => {
    const finish = SESSION_PAGE.indexOf('data-testid="finish-appointment"');
    const del = SESSION_PAGE.indexOf("<DeleteSessionForm");
    expect(finish).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(finish);
    expect(SESSION_PAGE).toMatch(/min-h-\[44px\] items-center justify-center/);
  });
});

describe("4. procedure records filter copy", () => {
  it("friendlier labels and helper", () => {
    expect(RECORDS).toMatch(/label: "Procedure records"/);
    expect(RECORDS).toMatch(/>Procedure records<\/h2>/);
    expect(RECORDS).toMatch(/Choose a client/);
    expect(RECORDS).toMatch(
      /Use this when you need a procedure record for one client/,
    );
    expect(RECORDS).toMatch(/this client&apos;s\s*\n?\s*procedure record/);
  });

  it("filter and print behavior untouched", () => {
    expect(RECORDS).toMatch(/normalizeProcedureRecordFilter/);
    expect(RECORDS).toMatch(/name="clientId"/);
    expect(RECORDS).toMatch(/All clients \(most recent sessions\)/);
    expect(RECORDS).toMatch(/Apply filter/);
    expect(RECORDS).toMatch(/Clear filters/);
    expect(RECORDS).toMatch(
      /href=\{`\/records\/print\?section=\$\{section\}/,
    );
    // The printed document keeps its formal title (print page).
    expect(read("app/(app)/records/print/page.tsx")).toMatch(
      /Client Records? for Invasive\s*\n?\s*Procedures/i,
    );
  });
});

describe("5. dashboard: worklist first", () => {
  it("Today renders before the snapshot and every secondary card", () => {
    const today = DASH.indexOf('<h2 className="text-lg font-medium">Today</h2>');
    const snapshot = DASH.indexOf("<PracticeSnapshot");
    // Part 2B: the four To-do sub-sections became one list.
    const attention = DASH.indexOf("<DashboardTodoList");
    const booking = DASH.indexOf("<BookingSetupCard");
    const birthdays = DASH.indexOf("<BirthdaysThisMonth");
    expect(today).toBeGreaterThan(-1);
    for (const later of [snapshot, attention, booking, birthdays]) {
      expect(later).toBeGreaterThan(today);
    }
  });

  it("completed setup renders NOTHING; incomplete keeps the card", () => {
    // SUPERSEDED INTENTIONALLY (Chloe D3, this PR). PR #238 collapsed completed
    // setup into a quiet "Setup complete. Getting started checklist →" footer.
    // Chloe's newer report is that the Dashboard tells her setup is complete
    // AND still offers her the checklist, the footer IS that contradiction, so
    // the completed state now renders nothing at all. The derivation itself is
    // unchanged; only what a completed studio SEES changed.
    expect(DASH).toMatch(
      /const setupComplete =\s*\n?\s*gettingStarted\.autoTotal > 0 &&\s*\n?\s*gettingStarted\.autoDone === gettingStarted\.autoTotal/,
    );
    // Onboarding v2 (migration 0140) supersedes this when its per-studio flag
    // is on, so the legacy card stays gated behind !onboardingV2On. On the
    // default OFF path an INCOMPLETE studio still gets its card, unchanged.
    expect(DASH).toMatch(/\{!onboardingV2On && !setupComplete && \(/);
    // ...and a COMPLETE one gets no footer, no card, no congratulation.
    // Comment-stripped: the page explains WHY the footer went away, and that
    // explanation quotes the retired copy. A whole-file grep would be satisfied
    // by the explanation rather than by the removal.
    const code = DASH.split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code).not.toMatch(/\{!onboardingV2On && setupComplete && \(/);
    expect(code).not.toMatch(/Setup complete\./);
    // Exactly one route link survives, the incomplete card's. The route stays
    // reachable regardless: AccountMenu and MobileMenu both link it (pinned in
    // tests/app/dashboard/operational-hierarchy.test.ts).
    expect(code.match(/href="\/getting-started"/g)?.length).toBe(1);
    // The dashboard never renders the full checklist; that lives on
    // /getting-started.
    expect(DASH).not.toMatch(/gettingStarted\.sections/);
  });

  it("the legacy incomplete card sits below Today; the onboarding-v2 surface sits above it", () => {
    const today = DASH.indexOf('<h2 className="text-lg font-medium">Today</h2>');
    // Legacy (flag-off) getting-started card is unchanged: still below Today.
    const card = DASH.indexOf("{!onboardingV2On && !setupComplete && (");
    expect(card).toBeGreaterThan(today);
    // The onboarding-v2 pinned surface is above the fold (above Today).
    const v2 = DASH.indexOf("{onboarding && (");
    expect(v2).toBeGreaterThan(-1);
    expect(v2).toBeLessThan(today);
  });

  it("PR #236 Today actions are untouched, and the snapshot still renders the same metrics", () => {
    expect(DASH).toMatch(/resolveNextAction\(\{/);
    expect(DASH).toMatch(/\{nextAction\.label\}/);
    // Part 1 split "Action needed" out of the snapshot; Part 2B retired that
    // component entirely and folded its data into the ONE To-do model. The
    // snapshot keeps its metrics and its livemode gate; the SAME
    // `clientsNeedingAttention` value is still loaded once and still rendered,
    // now as treatment_memory rows in the unified list.
    expect(DASH).toMatch(
      /<PracticeSnapshot metrics=\{practiceMetrics\} livemode=\{inferStripeLivemode\(\)\} \/>/,
    );
    expect(DASH).not.toMatch(/<ActionNeeded/);
    expect(DASH).toMatch(/attention: clientsNeedingAttention/);
    expect(DASH).toMatch(/<DashboardTodoList todo=\{dashboardTodo\} \/>/);
    // Loaded exactly once: the split must not have introduced a second read.
    expect(DASH.match(/getClientsNeedingAttention\(/g) ?? []).toHaveLength(1);
  });
});

describe("safety", () => {
  it("no payment, schema, or business-rule surface was touched", () => {
    for (const src of [SEARCH, TABBAR, RECORDS]) {
      expect(src).not.toMatch(/stripe|paymentIntents|charge/i);
    }
    // The session page keeps exactly the same actions it had; the
    // finish section added none (asserted above).
    expect(SESSION_PAGE).toMatch(/markAftercareExplainedAction/);
    expect(SESSION_PAGE).toMatch(/updateNextSessionNoteAction/);
  });

  it("e2e coverage exists for the fixes", () => {
    const spec = read("e2e/mobile-ux.spec.ts");
    expect(spec).toMatch(/fontSize/);
    expect(spec).toMatch(/selectOption/);
    expect(spec).toMatch(/Done, back to client/);
    const core = read("e2e/core-memory-loop.spec.ts");
    expect(core).toMatch(/Procedure records|procedure record for one client/);
  });
});
