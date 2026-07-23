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
  it("the Finish up section closes the charting page", () => {
    expect(SESSION_PAGE).toMatch(/Finish up/);
    expect(SESSION_PAGE).toMatch(
      /Everything above is already saved as you go/,
    );
    expect(SESSION_PAGE).toMatch(/There is no separate session save\./);
    expect(SESSION_PAGE).toMatch(/Done charting/);
    expect(SESSION_PAGE).toMatch(/Review appointment &amp; billing/);
  });

  it("finish actions navigate to existing routes; no new session write/submit path", () => {
    const finish = SESSION_PAGE.slice(
      SESSION_PAGE.indexOf("Finish up"),
      SESSION_PAGE.indexOf("<DeleteSessionForm"),
    );
    // Charting PR 1: "Done charting" is now the non-blocking aftercare guard,
    // which navigates to the sessions tab (doneHref) — still no session write.
    expect(finish).toMatch(/<DoneChartingButton/);
    expect(finish).toMatch(/doneHref=\{`\/clients\/\$\{id\}\?tab=sessions`\}/);
    expect(finish).toMatch(/href=\{`\/calendar\/\$\{paymentApptId\}`\}/);
    // no NEW session-save form/submit in the finish section (the aftercare mark
    // reuses the existing toggle action, not a new write path).
    expect(finish).not.toMatch(/<form|type="submit"|createSession|updateSession|addElectrolysis/);
  });

  it("finish links are touch sized and render above Delete", () => {
    const finish = SESSION_PAGE.indexOf("Finish up");
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
    const attention = DASH.indexOf("<NeedsAttention");
    const booking = DASH.indexOf("<BookingSetupCard");
    const birthdays = DASH.indexOf("<BirthdaysThisMonth");
    expect(today).toBeGreaterThan(-1);
    for (const later of [snapshot, attention, booking, birthdays]) {
      expect(later).toBeGreaterThan(today);
    }
  });

  it("completed setup collapses to a quiet footer link; incomplete keeps the card", () => {
    expect(DASH).toMatch(
      /const setupComplete =\s*\n?\s*gettingStarted\.autoTotal > 0 &&\s*\n?\s*gettingStarted\.autoDone === gettingStarted\.autoTotal/,
    );
    // Onboarding v2 (migration 0140) supersedes these when its per-studio flag
    // is on, so the legacy link/footer are gated behind !onboardingV2On. On the
    // default OFF path they render exactly as before.
    expect(DASH).toMatch(/\{!onboardingV2On && !setupComplete && \(/);
    expect(DASH).toMatch(/\{!onboardingV2On && setupComplete && \(/);
    expect(DASH).toMatch(/Setup complete\./);
    // Both states keep the route reachable.
    expect(DASH.match(/href="\/getting-started"/g)?.length).toBe(2);
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

  it("PR #236 Today actions and the snapshot are untouched", () => {
    expect(DASH).toMatch(/resolveNextAction\(\{/);
    expect(DASH).toMatch(/\{nextAction\.label\}/);
    expect(DASH).toMatch(/<PracticeSnapshot metrics=\{practiceMetrics\} attention=\{clientsNeedingAttention\} livemode=\{inferStripeLivemode\(\)\} \/>/);
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
    expect(spec).toMatch(/Done charting/);
    const core = read("e2e/core-memory-loop.spec.ts");
    expect(core).toMatch(/Procedure records|procedure record for one client/);
  });
});
