import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

const DASH = readFileSync(
  join(process.cwd(), "app/(app)/dashboard/page.tsx"),
  "utf8",
);

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

const TODAY = '<h2 className="text-lg font-medium">Today</h2>';
const TODO = '<h2 className="text-lg font-medium">To do</h2>';
const BIRTHDAYS = "<BirthdaysThisMonth";
const SNAPSHOT = "<PracticeSnapshot";

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
    const h2s = [...DASH.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)];
    expect(h2s.length).toBeGreaterThanOrEqual(3);
    expect(h2s[0][1]).toBe("Today");
  });

  it("the page's own top-level headings are exactly Today, To do, Birthdays this month", () => {
    // A new peer h2 competing with the three operational sections should fail
    // here and be a deliberate decision, not a drive-by addition.
    //
    // Scoped to headings declared IN THE PAGE. "Practice snapshot" is a fourth
    // top-level h2, declared inside practice-snapshot.tsx and asserted below —
    // it is demoted, not absent, and it must keep a heading of its own or its
    // cards nest under Birthdays in the accessibility tree.
    const h2s = [...DASH.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
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
    expect(snapshot).toMatch(/export function PracticeSnapshot[\s\S]{0,400}?<section/);
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
      // B5/0174: `practitioners` is now reachable by four FKs from
      // appointments, so the embed must name the ASSIGNMENT one or PostgREST
      // returns PGRST201 and the dashboard 500s.
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
    "<PilotLearningCard",
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
