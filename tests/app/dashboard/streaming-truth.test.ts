import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { SecondaryStackSkeleton } from "@/app/(app)/dashboard/secondary-stack";

// ===========================================================================
// PERF-01C — the Dashboard's secondary stack streams; the roster does not wait
// ===========================================================================
//
// WHAT THIS PROVES, AND WHY EACH CONTROL EXISTS
//
// The day's roster used to be withheld until six studio-paperwork reads had
// settled — expiring supplies, a setup fraction, practice metrics — none of
// which any roster surface reads. This suite pins the boundary that releases
// it, and, more importantly, pins what the boundary is NOT allowed to say
// while those reads are still running.
//
// THE TRUTH PROBLEM STREAMING INTRODUCES. Every card in the streamed stack
// states something about the studio: a To-do list, a birthday list,
// appointment counts, service value, "4 of 4 steps complete". An empty To-do
// list means "nothing needs doing". A zero means zero. Rendering any of them
// before the read establishes them is a false claim, not a placeholder — so
// the fallback is asserted to contain no word and no digit at all.
//
// It also may not borrow the clinical "couldn't load" copy: that asserts a
// read FAILED, which is false while it is still in flight. Loaded, absent and
// unavailable were three states; pending is a fourth, and it is mute.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const PAGE = read("app/(app)/dashboard/page.tsx");
const STACK = read("app/(app)/dashboard/secondary-stack.tsx");

/**
 * Source with `//` lines and `{/* jsx *\/}` blocks removed.
 *
 * Every "must NOT appear" assertion reads this, never the raw file. Both files
 * document their own product decisions in prose, so the comment explaining why
 * a fallback may not say "nothing needs doing" necessarily contains that
 * phrase — and a naive grep would be satisfied by the explanation instead of
 * by the behaviour. That failure mode has bitten this repo before.
 */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const PAGE_CODE = codeOnly(PAGE);
const STACK_CODE = codeOnly(STACK);

const SKELETON_HTML = renderToStaticMarkup(
  createElement(SecondaryStackSkeleton),
);

// ---------------------------------------------------------------------------
// 1. Essential practitioner content does not wait on the streamed slice
// ---------------------------------------------------------------------------

describe("1 — the roster does not wait for the secondary stack", () => {
  it("the page awaits none of the six secondary reads", () => {
    for (const promise of [
      "attentionSourcesPromise",
      "practiceMetricsPromise",
      "clientsNeedingAttentionPromise",
      "followUpAssistantPromise",
      "expiringSuppliesPromise",
      "gettingStartedSignalsPromise",
    ]) {
      expect(
        PAGE_CODE,
        `${promise} is still awaited in the page — the roster waits on it`,
      ).not.toMatch(new RegExp(`await\\s+${promise}\\b`));
    }
  });

  it("the secondary stack sits behind exactly one Suspense boundary", () => {
    expect(PAGE_CODE).toContain("fallback={<SecondaryStackSkeleton />}");
    expect(PAGE_CODE).toContain("<SecondaryStack");
    // ONE boundary. Spinner soup is a design failure, not a style preference.
    expect(PAGE_CODE.match(/<Suspense\b/g)?.length ?? 0).toBe(1);
  });

  it("the boundary is KEYED on day and period — an unkeyed one re-blocks navigation", () => {
    // NOT a style preference. Day and period navigation are query-only, so Next
    // drives them as a React transition, and a transition that renders a
    // suspending tree keeps the CURRENT screen up instead of showing a
    // fallback. With an unkeyed boundary the whole day navigation waited on the
    // studio paperwork again — the roster went straight back behind the reads
    // this boundary exists to take it out from behind, and
    // e2e/perceived-speed.spec.ts timed out waiting for the day to arrive.
    //
    // Keying on the values that change what the stack renders makes React treat
    // each day/period as a new boundary, so the fallback shows and the roster
    // commits at once.
    expect(PAGE_CODE).toMatch(
      /<Suspense\s+key=\{`\$\{selectedDayLocal\}:\$\{period\}`\}/,
    );
  });

  it("the roster's OWN reads are still awaited by the page, not streamed", () => {
    // The clinical strip is deliberately NOT in this slice. If a later change
    // slips it into the boundary, this goes red.
    for (const rosterRead of [
      "paymentStatesPromise",
      "beforeTodayPreviewsPromise",
      "prepLoadsPromise",
    ]) {
      expect(
        PAGE_CODE,
        `${rosterRead} must still be awaited in the page`,
      ).toMatch(new RegExp(`await\\s+${rosterRead}\\b`));
    }
    expect(STACK_CODE).not.toContain("beforeTodayPreviews");
    expect(STACK_CODE).not.toContain("prepLoads");
    expect(STACK_CODE).not.toContain("paymentStates");
  });
});

// ---------------------------------------------------------------------------
// 2. The loading fallback makes no false absence or value claim
// ---------------------------------------------------------------------------

describe("2 — the fallback claims nothing", () => {
  it("renders no digit — UNKNOWN is not ZERO", () => {
    // A count, a currency figure, or "4 of 4 steps" would each assert a fact
    // no read has established yet.
    expect(SKELETON_HTML.replace(/<[^>]*>/g, "")).not.toMatch(/\d/);
    expect(SKELETON_HTML.replace(/<[^>]*>/g, "")).not.toContain("$");
  });

  it("renders no words at all", () => {
    const text = SKELETON_HTML.replace(/<[^>]*>/g, "").trim();
    expect(text, `fallback rendered visible text: ${text}`).toBe("");
  });

  it("makes none of the forbidden absence claims", () => {
    for (const claim of [
      "No appointments",
      "Not recorded",
      "No watch/plan",
      "No history",
      "no charted",
      "nothing",
      "Setup complete",
      "steps complete",
      "To do",
      "Birthdays",
    ]) {
      expect(
        SKELETON_HTML,
        `fallback claims: ${claim}`,
      ).not.toContain(claim);
    }
  });

  it("does NOT reuse the clinical unavailable copy — pending is not failed", () => {
    expect(STACK_CODE).not.toContain("CLINICAL_UNAVAILABLE_HEADLINE");
    expect(SKELETON_HTML).not.toMatch(/could ?n[o']t load/i);
  });

  it("is decorative to assistive tech, and announces once at the container", () => {
    // Skeleton bars are aria-hidden by construction; the region owns the
    // single "busy" statement, so a screen reader is not read a dozen
    // meaningless placeholders.
    expect(SKELETON_HTML).toContain('aria-busy="true"');
    expect(SKELETON_HTML.match(/aria-busy/g)?.length ?? 0).toBe(1);
    expect(SKELETON_HTML).toContain('aria-hidden="true"');
  });
});

// ---------------------------------------------------------------------------
// 3. Failure in streamed data does not falsify clinical truth
// ---------------------------------------------------------------------------

describe("3 — a failed secondary read cannot speak for the clinical record", () => {
  it("no clinical read moved into the streamed stack", () => {
    // The Before-today / prep-memory authorities carry the #648 fail-closed
    // contract. They stay in the page precisely so a supplies or metrics
    // failure can never reach them.
    for (const clinical of [
      "getBeforeTodayPreviews",
      "loadLastChartedTreatmentsForClients",
      "buildAppointmentPrepMemory",
      "toDashboardPrepSummary",
    ]) {
      expect(STACK_CODE, `${clinical} must not be in the streamed stack`)
        .not.toContain(clinical);
    }
  });

  it("the page still owns the two-authority truth guard", () => {
    // Both halves of the Today relationship claim stay on the blocking path,
    // so neither can be decided by a stack that has not arrived.
    expect(PAGE_CODE).toContain("prepSummary.hasTreatment");
    expect(PAGE_CODE).toContain("prepSummary.unavailable");
  });

  it("settleLater still guards the widened start-to-await window", () => {
    // Streaming lengthens the gap between starting a promise and awaiting it.
    // The no-op catch marks a rejection handled for that window WITHOUT
    // consuming it, so the await in the child still throws to the boundary.
    expect(PAGE_CODE).toContain("const settleLater =");
    expect(PAGE_CODE).toContain("promise.catch(() => undefined)");
  });
});

// ---------------------------------------------------------------------------
// 4. Final rendered data is identical when the reads succeed
// ---------------------------------------------------------------------------

describe("4 — nothing about what renders changed", () => {
  it("every moved card renders from the same component and props", () => {
    expect(STACK_CODE).toContain("<DashboardTodoList todo={dashboardTodo} />");
    expect(STACK_CODE).toContain("<BirthdaysThisMonth");
    expect(STACK_CODE).toContain("<PracticeSnapshot");
    expect(STACK_CODE).toContain("livemode={inferStripeLivemode()}");
    expect(STACK_CODE).toContain("<BookingSetupCard readiness={bookingReadiness} />");
    expect(STACK_CODE).toContain('href="/dashboard/capacity"');
    expect(STACK_CODE).toContain('href="/getting-started"');
  });

  it("the To-do model is built from the same four domains, unchanged", () => {
    expect(STACK_CODE).toContain("buildDashboardTodo({");
    for (const field of [
      "assistant: followUpAssistant",
      "attention: clientsNeedingAttention",
      "supplies: expiringSupplies",
      "metrics: practiceMetrics.actions",
      "intakesAwaitingReviewCount",
      "activeServicesCount",
      "paymentStatus",
    ]) {
      expect(STACK_CODE).toContain(field);
    }
  });

  it("readiness and setup-completion keep their existing derived authority", () => {
    expect(STACK_CODE).toContain("computeBookingReadiness({");
    expect(STACK_CODE).toContain('bookingReadiness.status !== "ready"');
    expect(STACK_CODE).toContain("gettingStarted.autoDone === gettingStarted.autoTotal");
    // No new flag, no new column, no new query.
    expect(STACK_CODE).not.toMatch(/\.from\(/);
    expect(STACK_CODE).not.toContain("createClient");
  });

  it("the page no longer duplicates any of it", () => {
    expect(PAGE_CODE).not.toContain("<DashboardTodoList");
    expect(PAGE_CODE).not.toContain("<BirthdaysThisMonth");
    expect(PAGE_CODE).not.toContain("<PracticeSnapshot");
    expect(PAGE_CODE).not.toContain("buildDashboardTodo");
  });
});

// ---------------------------------------------------------------------------
// 5. Mobile geometry stays valid (#653)
// ---------------------------------------------------------------------------

describe("5 — mobile geometry", () => {
  it("the streamed stack keeps the page's own vertical rhythm", () => {
    // The stack's wrapper and the fallback use the SAME spacing the page's
    // root column uses, so the settled stack occupies the space the skeleton
    // reserved and the roster above it never moves.
    expect(STACK_CODE).toContain('className="flex flex-col gap-10"');
    expect(SKELETON_HTML).toContain("flex flex-col gap-10");
  });

  it("the fallback reserves height rather than collapsing to nothing", () => {
    // A zero-height fallback would let the page jump when the stack arrives.
    expect(SKELETON_HTML).toMatch(/h-\d+/);
    expect(SKELETON_HTML.match(/h-\d+/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });

  it("nothing in the fallback is interactive", () => {
    // Nothing can shift under a thumb mid-tap if there is nothing to tap.
    for (const interactive of ["<a", "<button", "<input", "href=", "onClick"]) {
      expect(SKELETON_HTML).not.toContain(interactive);
    }
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS — the suite must be able to fail
// ---------------------------------------------------------------------------

describe("negative controls — this suite is not vacuous", () => {
  it("BOUNDARY IS REAL: the page renders the stack ONLY inside Suspense", () => {
    // Reverting the child to a parent await would remove this and control 1
    // would go red. Without this assertion the suite passes on a no-op.
    const stackAt = PAGE_CODE.indexOf("<SecondaryStack");
    const suspenseAt = PAGE_CODE.indexOf("<Suspense");
    const closeAt = PAGE_CODE.indexOf("</Suspense>");
    expect(suspenseAt).toBeGreaterThan(-1);
    expect(stackAt).toBeGreaterThan(suspenseAt);
    expect(stackAt).toBeLessThan(closeAt);
  });

  it("PARALLELISM KEPT: the six promises are still STARTED in the page, before the roster", () => {
    // This is the PERF-01B regression guard. Moving promise CREATION into the
    // child would delay every one of them until the parent finished rendering
    // — strictly worse than the serial code #655 replaced.
    const firstPromise = PAGE_CODE.indexOf("const attentionSourcesPromise =");
    const roster = PAGE_CODE.indexOf("const { data: apptRows");
    expect(firstPromise).toBeGreaterThan(-1);
    expect(roster).toBeGreaterThan(-1);
    expect(
      firstPromise,
      "the secondary promises must start BEFORE the roster query",
    ).toBeLessThan(roster);
    for (const starter of [
      "countIntakesAwaitingReview(",
      "getPracticeDashboardMetrics(",
      "getClientsNeedingAttention(",
      "getMissingRecordsAssistant(",
      "getExpiringSterileItems(",
      "getGettingStartedSignals(",
    ]) {
      expect(PAGE_CODE, `${starter} must be invoked in the PAGE`).toContain(starter);
      expect(
        STACK_CODE,
        `${starter} must NOT be invoked in the child — that would delay it`,
      ).not.toContain(starter);
    }
  });

  it("the child receives promises, not resolved values", () => {
    expect(STACK_CODE).toContain("attentionSources: Promise<");
    expect(STACK_CODE).toContain("await attentionSources");
  });
});
