import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
    const h2s = [...DASH.matchAll(/<h2 className="text-lg font-medium">([^<]+)<\/h2>/g)];
    expect(h2s.length).toBeGreaterThanOrEqual(3);
    expect(h2s[0][1]).toBe("Today");
  });

  it("the top-level section headings are exactly Today, To do, Birthdays this month", () => {
    // A new peer h2 competing with the three operational sections should fail
    // here and be a deliberate decision, not a drive-by addition.
    const h2s = [...DASH.matchAll(/<h2 className="text-lg font-medium">([^<]+)<\/h2>/g)].map(
      (m) => m[1],
    );
    expect(h2s).toEqual(["Today", "To do", "Birthdays this month"]);
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
  const todoStart = () => at(TODO);
  const todoEnd = () => at(BIRTHDAYS);

  const inTodo = (marker: string) => {
    const i = at(marker);
    return i > todoStart() && i < todoEnd();
  };

  it.each([
    ["Action needed", "<ActionNeeded"],
    ["Follow-up assistant", "<FollowUpAssistantCard"],
    ["Supplies expiring", "<SuppliesExpiringCard"],
    ["Needs attention", "<NeedsAttention"],
  ])("%s renders inside To do", (_label, marker) => {
    expect(inTodo(marker)).toBe(true);
  });

  it("To do owns the only h2 in the group — its children are h3", () => {
    // One heading level for the group, so the four surfaces read as items of
    // one list rather than four competing sections. Asserted on the SOURCE of
    // each child component, not on the page.
    for (const [file, heading] of [
      ["app/(app)/dashboard/practice-snapshot.tsx", "Action needed"],
      ["app/(app)/dashboard/follow-up-assistant.tsx", "Follow-up assistant"],
      ["app/(app)/dashboard/supplies-expiring.tsx", "Supplies expiring"],
    ] as const) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      expect(src, `${heading} must be an h3`).toMatch(
        new RegExp(`<h3[^>]*>${heading}</h3>`),
      );
      expect(src, `${heading} must not be an h2`).not.toMatch(
        new RegExp(`<h2[^>]*>${heading}</h2>`),
      );
    }
    // "Needs attention" is declared inline in the page.
    expect(DASH).toMatch(/<h3[^>]*>Needs attention<\/h3>/);
    expect(DASH).not.toMatch(/<h2[^>]*>Needs attention<\/h2>/);
  });

  it("the duplicate attention surface is gone: Action needed left the snapshot", () => {
    // The dashboard used to carry TWO attention surfaces describing the same
    // class of work — "Action needed" inside the reporting snapshot and
    // "Needs attention" as a peer section below it.
    const snapshot = readFileSync(
      join(process.cwd(), "app/(app)/dashboard/practice-snapshot.tsx"),
      "utf8",
    );
    // PracticeSnapshot no longer takes or renders `attention`.
    expect(snapshot).toMatch(/export function PracticeSnapshot\(\{\s*\n\s*metrics,\s*\n\s*livemode/);
    expect(DASH).not.toMatch(/<PracticeSnapshot[^/]*attention=/);
    // ...and ActionNeeded is a separate export that does.
    expect(snapshot).toMatch(/export function ActionNeeded\(\{/);
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
  ])("%s is called exactly once", (_name, re) => {
    expect(DASH.match(re) ?? []).toHaveLength(1);
  });

  it("today's appointments are still fetched in ONE batched select", () => {
    // The narrow inline SELECT joins client, service and practitioner in one
    // trip. An N+1 would show up as a query inside the appointment map.
    expect(DASH).toMatch(/\.from\("appointments"\)/);
    expect(DASH.match(/\.from\("appointments"\)/g) ?? []).toHaveLength(1);
    expect(DASH).toMatch(
      /client:clients\([^)]*\), service:services\([^)]*\), practitioner:practitioners\(/,
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
    "<ActionNeeded",
    "<FollowUpAssistantCard",
    "<SuppliesExpiringCard",
    "<NeedsAttention",
    "<BookingSetupCard",
    "<BirthdaysThisMonth",
    "<PracticeSnapshot",
    "<PilotLearningCard",
    "<PilotFeedbackPrompt",
    "<AppointmentCheckoutCell",
    "<DashboardGreeting",
  ])("%s is still rendered", (marker) => {
    expect(DASH).toContain(marker);
  });

  it("Today still renders appointments, intake actions and treatment memory", () => {
    expect(DASH).toMatch(/todayWorkflowByAppointment|todayWorkflow/);
    expect(DASH).toMatch(/resolveTodayIntakeAction/);
    expect(DASH).toMatch(/getBeforeTodayPreviews/);
    expect(DASH).toMatch(/getLatestPinnedNoteByClient/);
  });

  it("this PR touched no appointment mutation or security surface", () => {
    // Parallel-work boundary with appointment DML B3/B4. The dashboard reads
    // appointments; it must never write them.
    for (const forbidden of [
      /\.from\("appointments"\)[\s\S]{0,400}?\.(insert|update|delete|upsert)\(/,
      /appointment-repair/,
      /createAdminClient/,
    ]) {
      expect(DASH, String(forbidden)).not.toMatch(forbidden);
    }
  });
});
