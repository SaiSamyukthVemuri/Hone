import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dayHeading } from "@/lib/dashboard/day-navigation";
import { join } from "node:path";
import { COMPOSED_DASHBOARD } from "./helpers/composed-dashboard";

// ===========================================================================
// Dashboard V2 Part 1 — the operational hierarchy.
// ===========================================================================
//
//     TODAY        what do I need to do now?
//     TO DO        what unfinished work requires an action?
//     BIRTHDAYS    useful relationship context
//     (secondary)  reporting and setup
//
// WHY THIS FILE EXISTS
// --------------------
// The order is the product decision. Before this PR the dashboard rendered
// Today, then the Practice Snapshot (reporting, including its own "Action
// needed" block), then Follow-up assistant, Supplies expiring, Needs attention,
// the booking card, and only then Birthdays — so reporting sat above actionable
// work and relationship context was tangled in the middle of it.
//
// Nothing enforced that order, and nothing would have noticed it drifting back:
// a section moves by editing one line of JSX, and every existing dashboard test
// asserts CONTENT, not POSITION. This file asserts position only.
//
// It reads the page SOURCE rather than rendering, because the dashboard page is
// an async server component with a dozen awaited loaders — the repo has no
// harness that renders it, and standing one up to assert ordering would be a
// far larger change than the ordering itself. Source-order assertions are the
// established idiom here (tests/app/chloe-pilot-feedback.test.ts does the same
// with indexOf). The trade-off is honest: this proves the JSX order, not the
// painted order. Nothing between these markers is conditionally reordered at
// runtime, so for this page they are the same thing.
//
// Deliberately NOT asserted: CSS classes, colours, spacing, or markup shape.
// Those must stay free to change without touching this file.

// PERF-01C: the secondary stack (To do, Birthdays, snapshot, setup cards) now
// renders from app/(app)/dashboard/secondary-stack.tsx behind a Suspense
// boundary, so the day's roster no longer waits on studio paperwork. These
// assertions are about what RENDERS and in what order, so they read the
// COMPOSED source (page with the child spliced in where it renders) rather
// than half the page. See tests/app/dashboard/helpers/composed-dashboard.ts.
const DASH = COMPOSED_DASHBOARD;

/**
 * DASH with `//` lines and `{/* jsx *\/}` blocks removed.
 *
 * Every "this copy must NOT appear" assertion below reads THIS, never DASH.
 * The page documents its own product decisions in comments, so the note
 * explaining why the Pilot learning card was deleted necessarily contains the
 * words "Pilot learning" — and a naive whole-file grep would be satisfied by
 * the explanation of the removal rather than by the removal. That failure mode
 * has bitten this repo before; strip first, then assert.
 */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const DASH_CODE = stripComments(DASH);

/** Index of a unique source marker, asserted to exist exactly once. */
function at(marker: string | RegExp): number {
  const src = DASH;
  if (typeof marker === "string") {
    const first = src.indexOf(marker);
    expect(first, `marker not found: ${marker}`).toBeGreaterThan(-1);
    expect(
      src.indexOf(marker, first + 1),
      `marker must be unique: ${marker}`,
    ).toBe(-1);
    return first;
  }
  const all = [...src.matchAll(new RegExp(marker.source, `${marker.flags}g`))];
  expect(all, `marker not found: ${marker}`).toHaveLength(1);
  return all[0].index!;
}

// The first section heading is now DYNAMIC — the roster follows the selected
// day, so the h2 renders "Today", "Tomorrow" or a date. Its position is what
// this file guards, so the marker is the expression that produces it. That the
// today branch still reads exactly "Today" is asserted below by evaluating the
// real function, not by trusting a literal that no longer exists in the JSX.
const TODAY = "{dayHeading(selectedDayLocal, todayLocal)}";
const TODO = '<h2 className="text-lg font-medium">To do</h2>';
const BIRTHDAYS = "<BirthdaysThisMonth";
const SNAPSHOT = "<PracticeSnapshot";

/**
 * The page's own top-level heading TEXTS, as a viewer sees them TODAY.
 *
 * Class-agnostic, and it resolves the roster's dynamic heading by calling the
 * real `dayHeading` with actual-today on both sides. So this still proves the
 * user-visible words — a change that made the roster say "Schedule" instead of
 * "Today" fails here, exactly as it did when the heading was a literal.
 */
function pageHeadings(): string[] {
  return [...DASH.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => {
    const text = m[1].trim();
    if (text !== TODAY) return text;
    const d = "2026-08-20";
    return dayHeading(d, d);
  });
}

describe("dashboard hierarchy — Today, then To do, then Birthdays", () => {
  it("Today comes before To do", () => {
    expect(at(TODAY)).toBeLessThan(at(TODO));
  });

  it("To do comes before Birthdays", () => {
    expect(at(TODO)).toBeLessThan(at(BIRTHDAYS));
  });

  it("the full operational order holds end to end", () => {
    const order = [at(TODAY), at(TODO), at(BIRTHDAYS)];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("Today is the FIRST section heading on the page", () => {
    // Guards the one rule that must never bend, including on mobile: whatever
    // else moves, Today stays on top. h1 "Dashboard" is the page title, not a
    // section.
    // Class-AGNOSTIC: a new h2 with different styling must not be invisible
    // here, and a purely cosmetic class change must not turn this red.
    const h2s = pageHeadings();
    expect(h2s.length).toBeGreaterThanOrEqual(3);
    expect(h2s[0]).toBe("Today");
  });

  it("the page's own top-level headings are exactly Today, To do, Birthdays this month", () => {
    // A new peer h2 competing with the three operational sections should fail
    // here and be a deliberate decision, not a drive-by addition.
    //
    // Scoped to headings declared IN THE PAGE. "Practice snapshot" is a fourth
    // top-level h2, declared inside practice-snapshot.tsx and asserted below —
    // it is demoted, not absent, and it must keep a heading of its own or its
    // cards nest under Birthdays in the accessibility tree.
    const h2s = pageHeadings();
    expect(h2s).toEqual(["Today", "To do", "Birthdays this month"]);
  });

  it("the demoted Practice Snapshot still has a heading of its OWN", () => {
    // Its only h2 used to be "Action needed", which moved to To do. Without a
    // replacement, a screen-reader user navigating by heading would find
    // "Service value" and "Payments" as children of "Birthdays this month" —
    // the preceding h2 — because heading level, not DOM nesting, defines the
    // a11y outline.
    const snapshot = readFileSync(
      join(process.cwd(), "app/(app)/dashboard/practice-snapshot.tsx"),
      "utf8",
    );
    expect(snapshot).toMatch(/<h2 className="text-lg font-medium">Practice snapshot<\/h2>/);
    // ...and it is a landmark section, not a bare div.
    // Widened from 400: the component gained documented `selectedDay` /
    // `todayLocal` props so its period links carry the selected day. The rule
    // being guarded is "a section, not a bare div", not a character budget.
    expect(snapshot).toMatch(/export function PracticeSnapshot[\s\S]{0,900}?<section/);
  });
});

describe("dashboard hierarchy — reporting and setup are DEMOTED, not deleted", () => {
  it("the Practice Snapshot sits below Birthdays", () => {
    // It is reporting, not an action. The owner-only Financials route that will
    // eventually own service value / payment posture does not exist yet, so the
    // snapshot is demoted rather than removed — deleting the only surface that
    // shows them before their replacement exists would destroy functionality.
    expect(at(BIRTHDAYS)).toBeLessThan(at(SNAPSHOT));
  });

  it("the Getting started card sits below the operational sections", () => {
    // Setup is not daily work. It used to render directly under Today.
    // Still the INCOMPLETE branch only — see the CHLOE D3 block below.
    expect(at(BIRTHDAYS)).toBeLessThan(at("{!onboardingV2On && !setupComplete && ("));
  });

  it("the booking setup card sits below Birthdays", () => {
    expect(at(BIRTHDAYS)).toBeLessThan(at("<BookingSetupCard"));
  });

  it("the onboarding v2 surface still sits ABOVE Today", () => {
    // Unchanged by this PR and deliberately so: it is an opt-in, owner-only
    // guided wizard that is supposed to be above the fold.
    expect(at("{onboarding && (")).toBeLessThan(at(TODAY));
  });
});

// ===========================================================================
// CHLOE (this PR) — finished setup and pilot-only tooling leave the Dashboard.
// ===========================================================================
// The three deletions below are the product decision, exactly like the ordering
// above: nothing enforced them, and a drive-by edit could put any of them back
// without a single test noticing. Each is asserted as a POSITIVE absence, and
// each is paired with the surface that must SURVIVE it — a cleanup that also
// deletes the incomplete-setup path, or the /getting-started route, or the
// shared feedback helper, is a regression, not a cleanup.
describe("dashboard cleanup — completed setup and pilot tooling do not render", () => {
  it("D2: the booking setup card is gated on readiness NOT being ready", () => {
    // Chloe saw "Booking page ready / Your public booking page is live" plus a
    // column of ticks, permanently. Complete readiness must render nothing.
    expect(DASH).toMatch(
      /\{isOwner && bookingReadiness && bookingReadiness\.status !== "ready" && \(/,
    );
    // The card itself refuses too, so the contract does not depend on a caller
    // remembering the guard.
    const cardRaw = readFileSync(
      join(process.cwd(), "app/(app)/dashboard/BookingSetupCard.tsx"),
      "utf8",
    );
    expect(cardRaw).toMatch(/if \(readiness\.status === "ready"\) return null;/);
    // The congratulation copy is GONE from the component, not merely unreached.
    // Comment-stripped for the same reason as DASH_CODE: the component's own
    // header note quotes the copy it retired.
    const card = stripComments(cardRaw);
    expect(card).not.toMatch(/Booking page ready/);
    expect(card).not.toMatch(/Your public booking page is live/);
    expect(card).not.toMatch(/<BookingLinkCard/);
    expect(DASH_CODE).not.toMatch(/Booking page ready/);
  });

  it("D2: derived readiness stays the ONLY authority — no new completion flag", () => {
    // "Do not create a new completion flag if current state already determines
    // readiness." The page must keep deriving from computeBookingReadiness and
    // must not invent a persisted booking-complete signal.
    expect(DASH).toMatch(/computeBookingReadiness\(/);
    expect(DASH).not.toMatch(/booking_setup_complete|bookingSetupComplete|booking_ready\b/);
    const readiness = readFileSync(
      join(process.cwd(), "lib/booking/readiness.ts"),
      "utf8",
    );
    // The authority itself is untouched by this PR.
    expect(readiness).toMatch(/const allRequiredOk = items\.every\(\(it\) => !it\.required \|\| it\.ok\);/);
  });

  it("D2: the incomplete state and the booking link's real homes all survive", () => {
    // The not-ready checklist keeps every per-item action...
    const card = readFileSync(
      join(process.cwd(), "app/(app)/dashboard/BookingSetupCard.tsx"),
      "utf8",
    );
    expect(card).toMatch(/>\s*Set up your booking page\s*</);
    expect(card).toMatch(/<Checklist items=\{readiness\.items\}/);
    expect(card).toMatch(/href=\{item\.href\}/);
    // ...and the booking LINK still lives on the pages that own it, so hiding
    // the ready card removed a banner, not a capability.
    for (const f of [
      "app/(app)/settings/booking/page.tsx",
      "app/(app)/settings/availability/AvailabilityClient.tsx",
    ]) {
      expect(readFileSync(join(process.cwd(), f), "utf8")).toMatch(
        /<BookingLinkCard/,
      );
    }
  });

  it("D3: a COMPLETED setup renders no Getting Started card or footer", () => {
    // The retired footer said "Setup complete." and then offered the setup
    // checklist — the exact contradiction Chloe reported.
    expect(DASH_CODE).not.toMatch(/\{!onboardingV2On && setupComplete && \(/);
    expect(DASH_CODE).not.toMatch(/Setup complete\./);
    expect(DASH_CODE).not.toMatch(/Getting started checklist/);
    // Exactly ONE /getting-started link remains on the page: the incomplete
    // branch. (Two would mean the footer is back under another name.)
    expect(DASH_CODE.match(/href="\/getting-started"/g) ?? []).toHaveLength(1);
  });

  it("D3: incomplete onboarding STILL gets its assistance, both systems", () => {
    // New-studio onboarding must be undamaged. Legacy (flag-off) path:
    expect(DASH).toMatch(/\{!onboardingV2On && !setupComplete && \(/);
    expect(DASH).toMatch(/const setupComplete =/);
    // Onboarding v2 path: its pinned card already hides itself when complete,
    // which is why no page-level change was needed for it.
    expect(DASH).toContain("<OnboardingSurface");
    const surface = readFileSync(
      join(process.cwd(), "app/(app)/dashboard/onboarding/OnboardingSurface.tsx"),
      "utf8",
    );
    expect(surface).toMatch(/\{!model\.isComplete && \(\s*<OnboardingProgressCard/);
  });

  it("D3: the dedicated Getting Started route stays reachable and deliberate", () => {
    // "Getting Started itself remains available deliberately through the
    // Account menu / its existing route." Deleting the product is NOT the fix.
    expect(existsSync(join(process.cwd(), "app/(app)/getting-started/page.tsx"))).toBe(
      true,
    );
    for (const f of ["app/(app)/AccountMenu.tsx", "app/(app)/MobileMenu.tsx"]) {
      expect(
        readFileSync(join(process.cwd(), f), "utf8"),
        `${f} must keep the Getting Started entry`,
      ).toMatch(/href: "\/getting-started"/);
    }
  });

  it("D4: Pilot Learning does not render on the Dashboard, in any form", () => {
    for (const marker of [
      "PilotLearningCard",
      "pilot-learning",
      "Pilot learning",
      "Send it to Sam",
      "Know another electrologist",
      "Send feedback",
    ]) {
      expect(
        DASH_CODE,
        `${marker} must not appear on the dashboard`,
      ).not.toContain(marker);
    }
    // Dead component deleted, not left orphaned behind an unused import.
    expect(
      existsSync(join(process.cwd(), "app/(app)/dashboard/pilot-learning.tsx")),
    ).toBe(false);
  });

  it("D4: the SHARED feedback helper survives, but NO Dashboard footer does", () => {
    // DASH-TRUTH-04 finished the job the earlier cleanup started: the two quiet
    // <PilotFeedbackPrompt> footers under Today and To do are gone, so the daily
    // product no longer routes practitioner feedback to the founder. The SHARED
    // helper and component files are deliberately kept — this requirement is
    // Dashboard-specific, and deleting shared code is a wider decision than this
    // tranche was asked to make.
    expect(existsSync(join(process.cwd(), "lib/pilot/feedback-mailto.ts"))).toBe(true);
    const page = COMPOSED_DASHBOARD
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(page).not.toMatch(/<PilotFeedbackPrompt/);
  });

  it("no replacement card was introduced for anything removed", () => {
    // "Do not introduce new cards to replace deleted cards." The page's own
    // top-level headings are still exactly the three operational sections
    // (also asserted above); this pins that the cleanup ADDED no section.
    const h2s = pageHeadings();
    expect(h2s).toEqual(["Today", "To do", "Birthdays this month"]);
  });
});

describe("dashboard hierarchy — the To do section owns the actionable work", () => {
  /**
   * The SOURCE SPAN of the JSX element that encloses the To do heading, found
   * by walking tags and tracking depth.
   *
   * "Is the index between the To do heading and Birthdays?" is NOT good enough
   * and was the original mistake here: it is satisfied by a page where the
   * <section> has been dissolved and the four surfaces are bare peers again —
   * precisely the state this PR exists to fix. A mutation that moved the
   * closing </section> up to just after the heading passed every assertion in
   * this file. Containment has to be real.
   */
  function todoSection(): string {
    const h = at(TODO);
    const open = DASH.lastIndexOf("<section", h);
    expect(open, "the To do heading must be inside a <section>").toBeGreaterThan(-1);
    let depth = 0;
    const re = /<section\b|<\/section>/g;
    re.lastIndex = open;
    let m: RegExpExecArray | null;
    while ((m = re.exec(DASH)) !== null) {
      depth += m[0] === "</section>" ? -1 : 1;
      if (depth === 0) return DASH.slice(open, m.index + m[0].length);
    }
    throw new Error("unbalanced <section> around the To do heading");
  }

  // Dashboard V2 Part 2B: the four children became ONE list fed by ONE model.
  it("the ONE To-do list is CONTAINED by the To do section element", () => {
    expect(todoSection()).toContain("<DashboardTodoList");
  });

  it("there is exactly ONE To-do list, rendered once", () => {
    expect(DASH.match(/<DashboardTodoList/g) ?? []).toHaveLength(1);
  });

  it("the four independent visible sub-sections are GONE", () => {
    // This is the Part 2B contract. Their data still reaches the practitioner
    // — through the normalized model — but not as four peer surfaces.
    for (const marker of [
      "<ActionNeeded",
      "<FollowUpAssistantCard",
      "<SuppliesExpiringCard",
      "<NeedsAttention",
    ]) {
      expect(DASH, `${marker} must no longer be rendered`).not.toContain(marker);
    }
    // ...and the components themselves are deleted, not merely unreferenced.
    for (const f of [
      "app/(app)/dashboard/follow-up-assistant.tsx",
      "app/(app)/dashboard/supplies-expiring.tsx",
    ]) {
      expect(existsSync(join(process.cwd(), f)), `${f} should be deleted`).toBe(
        false,
      );
    }
  });

  it("the To do section still stops before Birthdays", () => {
    const sec = todoSection();
    // Non-trivial span: a dissolved section would be a few characters long.
    expect(sec.length).toBeGreaterThan(200);
    expect(sec).not.toContain("<BirthdaysThisMonth");
    expect(sec).not.toContain("<PracticeSnapshot");
  });

  it("the To do section is UNCONDITIONAL — no role or flag can empty it", () => {
    // A mutation wrapping the section in `{isOwner && ...}` removed the whole
    // To-do surface for every non-owner practitioner, and this file stayed
    // green. The heading must not sit behind a guard, and neither may the list.
    // (Owner-ONLY *rows* are filtered inside the model, where they belong.)
    const sec = todoSection();
    // The gate lives OUTSIDE the element — `{isOwner && <section ...>}` — so
    // looking only inside the section misses it entirely. That mutation was
    // still green after the first fix here. Inspect what immediately precedes
    // the opening tag.
    const open = DASH.lastIndexOf("<section", at(TODO));
    const beforeTag = DASH.slice(Math.max(0, open - 120), open);
    expect(
      beforeTag,
      "the To do section must not be wrapped in a conditional",
    ).not.toMatch(/\{[^{}]*&&\s*$/);
    // ...and nothing inside it gates the heading either.
    const beforeHeading = sec.slice(0, sec.indexOf("To do</h2>"));
    expect(beforeHeading, "the To do heading must not be conditionally rendered").not.toMatch(
      /\{\s*[A-Za-z0-9_.!]+\s*&&/,
    );
    for (const marker of ["<DashboardTodoList"]) {
      const line = sec.slice(sec.lastIndexOf("\n", sec.indexOf(marker)), sec.indexOf(marker));
      expect(line, `${marker} must not be gated`).not.toMatch(/&&/);
    }
  });

  it("To do owns the only heading in the group — the list adds NO sub-headings", () => {
    // Part 1 gave the four children h3s so they read as items of one group.
    // Part 2B removes the competing headings altogether: one list, one grammar.
    const list = readFileSync(
      join(process.cwd(), "app/(app)/dashboard/todo-list.tsx"),
      "utf8",
    );
    expect(list).not.toMatch(/<h[1-6]/);
    const sec = todoSection();
    expect(sec.match(/<h2/g) ?? []).toHaveLength(1);
    expect(sec).not.toMatch(/<h3/);
  });

  it("the duplicate attention surfaces are gone from the snapshot entirely", () => {
    const snapshot = readFileSync(
      join(process.cwd(), "app/(app)/dashboard/practice-snapshot.tsx"),
      "utf8",
    );
    // PracticeSnapshot never takes or renders `attention`...
    expect(snapshot).toMatch(/export function PracticeSnapshot\(\{\s*\n\s*metrics,\s*\n\s*livemode/);
    expect(DASH).not.toMatch(/<PracticeSnapshot[^/]*attention=/);
    // ...and ActionNeeded no longer exists at all — Part 2B retired it.
    expect(snapshot).not.toMatch(/export function ActionNeeded/);
    expect(snapshot).not.toMatch(/ClientsNeedingAttention/);
  });

  it("every row grammar question is answered by the ONE model", () => {
    // subject (who/what) · reason (why unresolved) · action (what next).
    const model = readFileSync(
      join(process.cwd(), "lib/dashboard/todo-model.ts"),
      "utf8",
    );
    for (const field of ["subject", "reason", "action"]) {
      expect(model, `the model must define ${field}`).toMatch(
        new RegExp(`${field}[?]?:`),
      );
    }
    const list = readFileSync(
      join(process.cwd(), "app/(app)/dashboard/todo-list.tsx"),
      "utf8",
    );
    for (const field of [
      "item.subject.label",
      "item.reason",
      "item.action.label",
      "item.action.href",
    ]) {
      expect(list, `the list must render ${field}`).toContain(field);
    }
  });
});

describe("dashboard hierarchy — no new data loading", () => {
  // §7: a rearrangement must not make the page issue more queries. These are
  // the loaders whose results the moved components consume.
  it.each([
    ["getClientsNeedingAttention", /getClientsNeedingAttention\(/g],
    ["getPracticeDashboardMetrics", /getPracticeDashboardMetrics\(/g],
    ["getMissingRecordsAssistant", /getMissingRecordsAssistant\(/g],
    ["getExpiringSterileItems", /getExpiringSterileItems\(/g],
    ["getClientBirthdaysForMonth", /getClientBirthdaysForMonth\(/g],
    // Part 2B: the normalizer is pure and must be invoked exactly once. More
    // than one call would mean the page rebuilt the same list twice.
    ["buildDashboardTodo", /buildDashboardTodo\(/g],
  ])("%s is called exactly once", (_name, re) => {
    expect(DASH.match(re) ?? []).toHaveLength(1);
  });

  it("today's appointments are still fetched in ONE batched select", () => {
    // The narrow inline SELECT joins client, service and practitioner in one
    // trip. An N+1 would show up as a query inside the appointment map.
    expect(DASH).toMatch(/\.from\("appointments"\)/);
    expect(DASH.match(/\.from\("appointments"\)/g) ?? []).toHaveLength(1);
    expect(DASH).toMatch(
      // PRE-0174 COMPATIBILITY: after 0174 `practitioners` is reachable by
      // four FKs from `appointments`, so the embed must name the ASSIGNMENT
      // one or PostgREST returns PGRST201 and the dashboard 500s. Valid on
      // 0173 too, which is what makes the app-first order safe.
      /client:clients\([^)]*\), service:services\([^)]*\), practitioner:practitioners!appointments_practitioner_same_studio_fk\(/,
    );
  });

  it("no loader is invoked from inside a map over appointments", () => {
    // Cheap structural N+1 guard: the appointment mapping must stay pure.
    const map = DASH.slice(
      DASH.indexOf("const todayWorkflowInputs"),
      DASH.indexOf("const todayWorkflow ="),
    );
    expect(map.length).toBeGreaterThan(0);
    expect(map).not.toMatch(/await /);
    expect(map).not.toMatch(/supabase\./);
  });
});

describe("dashboard hierarchy — nothing operational was removed", () => {
  it.each([
    "<OnboardingSurface",
    // Part 2B: the four To-do sub-sections collapsed into this single list.
    "<DashboardTodoList",
    "<BookingSetupCard",
    "<BirthdaysThisMonth",
    "<PracticeSnapshot",
    // "<PilotLearningCard" deliberately left this list — see the CHLOE D4
    // block below, which asserts its ABSENCE rather than merely dropping the
    // row. A removed guard proves nothing; a positive absence assertion does.
    "<PilotFeedbackPrompt",
    "<AppointmentCheckoutCell",
    "<DashboardGreeting",
  ])("%s is still rendered", (marker) => {
    // `toContain` alone proves a STRING exists, not that it renders: wrapping a
    // surface in `{false && ...}` or dead-coding it kept this green. Assert the
    // element is reached, i.e. not immediately preceded by a falsy literal gate.
    expect(DASH).toContain(marker);
    const i = DASH.indexOf(marker);
    const preceding = DASH.slice(Math.max(0, i - 200), i);
    expect(preceding, `${marker} must not be dead-coded`).not.toMatch(/\{\s*false\s*&&/);
    // Inside an UNCLOSED JSX comment: the last `{/*` before the marker has no
    // `*/` between it and the marker. (A naive /\{\/\*/ test would flag every
    // legitimate comment that merely precedes the element.)
    const lastOpen = preceding.lastIndexOf("{/*");
    if (lastOpen !== -1) {
      expect(
        preceding.slice(lastOpen).includes("*/"),
        `${marker} must not be inside a comment`,
      ).toBe(true);
    }
  });

  it("Birthdays is rendered unconditionally — relationship context is not owner-gated", () => {
    const i = at("<BirthdaysThisMonth");
    const line = DASH.slice(DASH.lastIndexOf("\n", i), i);
    expect(line, "Birthdays must not be behind a && guard").not.toMatch(/&&/);
  });

  it("Today still renders appointments, intake actions and treatment memory", () => {
    expect(DASH).toMatch(/todayWorkflowByAppointment|todayWorkflow/);
    expect(DASH).toMatch(/resolveTodayIntakeAction/);
    expect(DASH).toMatch(/getBeforeTodayPreviews/);
    expect(DASH).toMatch(/getLatestPinnedNoteByClient/);
  });

  it("the dashboard page never WRITES an appointment, by any route", () => {
    // Honest framing: this is a standing property of the page, NOT a diff
    // guard. It passed identically at the base commit — which is the point; it
    // must keep passing. The parallel appointment-DML boundary work (B3/B4) is
    // enforced by tests/security/appointment-direct-dml-guard.test.ts, which
    // censuses the whole tree with the TypeScript compiler API and is resistant
    // to the alias and detached-receiver evasions a regex here cannot see.
    //
    // Whole-chain scan rather than a bounded lookahead, so a write far below
    // the `.from()` — or through a detached receiver — is still caught.
    const chains = [...DASH.matchAll(/\.from\(\s*["']appointments["']\s*\)/g)];
    expect(chains.length, "one batched read, no more").toBe(1);
    for (const c of chains) {
      const rest = DASH.slice(c.index!, DASH.indexOf(";", c.index!));
      expect(rest, "the appointments query must be read-only").not.toMatch(
        /\.(insert|update|delete|upsert)\s*\(/,
      );
    }
    // A detached receiver (`const q = supabase.from("appointments")`) would
    // defeat the above; the page must not create one.
    expect(DASH).not.toMatch(/=\s*supabase\s*\n?\s*\.from\(\s*["']appointments["']/);
    // No admin/service-role client, no repair surface, no appointment RPC.
    expect(DASH).not.toMatch(/createAdminClient/);
    expect(DASH).not.toMatch(/appointment-repair/);
    expect(DASH).not.toMatch(/\.rpc\(\s*["'][^"']*appointment/i);
  });

  it("no async work is introduced inside the appointment RENDER map", () => {
    // The earlier version of this guard sliced only the pure input-building
    // block, so an async child component fetching per appointment inside the
    // JSX map — a textbook N+1 — left every loader count at 1 and went unseen.
    // The JSX map specifically — `{visibleAppointments.map((appt) => (`.
    // There are earlier PURE maps over the same array (client_id projections);
    // indexOf() found one of those and made this assertion meaningless.
    const start = DASH.indexOf("{visibleAppointments.map((appt) => (");
    expect(start).toBeGreaterThan(-1);
    const region = DASH.slice(start, DASH.indexOf("</ul>", start));
    expect(region.length).toBeGreaterThan(0);
    expect(region, "no await inside the render map").not.toMatch(/\bawait\b/);
    expect(region, "no query inside the render map").not.toMatch(/supabase\.|\.from\(/);
  });
});
