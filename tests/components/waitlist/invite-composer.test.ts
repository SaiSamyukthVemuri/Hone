import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

import {
  InviteComposer,
  InviteComposerStep,
  ReviewPanel,
} from "@/components/waitlist/invite-composer";
import {
  PENDING_B2_NOTICE,
  STEP_BACKING,
  emptyDraft,
  type DraftStepId,
  type InvitationDraft,
} from "@/lib/waitlist/admission-model";

// ===========================================================================
// WAIT-03 B4 — the composer never promises what the server cannot do
// ===========================================================================
//
// NON-AUTHORITATIVE FIXTURES, defined here and exported nowhere. B2 is not
// frozen; there is no server interface to render against.
//
// The load-bearing assertions are the ones about the REVIEW step. A filled-in
// field that reaches no command is the exact shape of a false promise, and the
// review screen is where a practitioner would act on it.

const render = (el: ReactElement) => renderToStaticMarkup(el);

function draftWith(over: Partial<InvitationDraft> = {}): InvitationDraft {
  return { ...emptyDraft(), entryIds: ["fixture-1"], ...over };
}

function buttonTag(html: string, testid: string): string {
  const tag = [...html.matchAll(/<button[^>]*>/g)]
    .map((m) => m[0])
    .find((t) => t.includes(`data-testid="${testid}"`));
  if (!tag) throw new Error(`no control rendered for "${testid}"`);
  return tag;
}

const STEPS: ReadonlyArray<DraftStepId> = [
  "select",
  "service",
  "horizon",
  "days",
  "expiry",
  "review",
];

describe("each step declares whether it reaches the database", () => {
  it("marks the four unbacked steps, and only those", () => {
    for (const step of STEPS) {
      if (step === "review") continue;
      const html = render(
        InviteComposerStep({ step, draft: draftWith() }) as ReactElement,
      );
      const pending = STEP_BACKING[step] === "pending-b2";
      expect(html.includes('data-testid="step-not-enforced"'), step).toBe(pending);
      expect(html.includes(PENDING_B2_NOTICE), step).toBe(pending);
      expect(html, step).toContain(`data-backing="${STEP_BACKING[step]}"`);
    }
  });

  it("NON-VACUITY — both kinds of step exist in the workflow", () => {
    // If every step were unbacked (or every step backed) the assertion above
    // would hold without discriminating anything.
    const backings = STEPS.filter((s) => s !== "review").map((s) => STEP_BACKING[s]);
    expect(new Set(backings).size).toBe(2);
  });

  it("the badge is words, not a colour", () => {
    const html = render(
      InviteComposerStep({ step: "service", draft: draftWith() }) as ReactElement,
    );
    expect(html).toContain("Not enforced yet");
  });
});

describe("review keeps effect and intent in separate voices", () => {
  it("what will happen is listed under its own heading", () => {
    const html = render(ReviewPanel({ draft: draftWith({ ttlHours: 48 }) }) as ReactElement);
    expect(html).toContain("What sending will do");
    expect(html).toContain('data-testid="review-enforced"');
    expect(html).toContain("1 person will be invited.");
    expect(html).toContain("expires after 48 hours");
  });

  it("unbacked intent is listed SEPARATELY and said to be unenforced", () => {
    const html = render(
      ReviewPanel({
        draft: draftWith({
          serviceId: "svc-1",
          horizonDays: 30,
          weekdays: [2, 4],
          dates: ["2026-09-10"],
        }),
      }) as ReactElement,
    );
    expect(html).toContain("Recorded, but not part of the invitation");
    expect(html).toContain('data-testid="review-not-enforced"');
    expect(html).toContain(PENDING_B2_NOTICE);
  });

  it("no unbacked item ever appears in the enforced list", () => {
    const html = render(
      ReviewPanel({
        draft: draftWith({ serviceId: "svc-1", horizonDays: 30, weekdays: [1] }),
      }) as ReactElement,
    );
    const enforced = html.slice(
      html.indexOf('data-testid="review-enforced"'),
      html.indexOf("Recorded, but not part of the invitation"),
    );
    expect(enforced.length).toBeGreaterThan(20);
    for (const leak of ["Service preference", "Booking window", "Preferred days"]) {
      expect(enforced, leak).not.toContain(leak);
    }
  });

  it("a draft with only backed fields shows NO not-enforced section", () => {
    // Non-vacuity for the split: the section is conditional, not always present.
    const html = render(ReviewPanel({ draft: draftWith() }) as ReactElement);
    expect(html).not.toContain("Recorded, but not part of the invitation");
    expect(html).not.toContain('data-testid="review-not-enforced"');
  });

  it("validation errors surface on review", () => {
    const html = render(
      ReviewPanel({ draft: { ...emptyDraft(), entryIds: [] } }) as ReactElement,
    );
    expect(html).toContain('data-testid="review-errors"');
    expect(html).toContain("Choose at least one person to invite.");
  });
});

describe("sending refuses, and says which refusal it is", () => {
  it("pre-B2 the send is disabled with the release reason", () => {
    const html = render(
      InviteComposer({ step: "review", draft: draftWith() }) as ReactElement,
    );
    expect(buttonTag(html, "composer-send")).toContain('disabled=""');
    expect(html).toContain("Sending is not available in this release yet.");
  });

  it("connected but invalid gives a DIFFERENT reason", () => {
    const html = render(
      InviteComposer({
        step: "review",
        draft: { ...emptyDraft(), entryIds: [] },
        connected: true,
      }) as ReactElement,
    );
    expect(buttonTag(html, "composer-send")).toContain('disabled=""');
    expect(html).toContain("Fix the highlighted steps before sending.");
    expect(html).not.toContain("not available in this release");
  });

  it("connected and valid enables the send", () => {
    const html = render(
      InviteComposer({ step: "review", draft: draftWith(), connected: true }) as ReactElement,
    );
    expect(buttonTag(html, "composer-send")).not.toContain('disabled=""');
    expect(html).not.toContain('data-testid="composer-send-reason"');
  });

  it("the send control appears only on review", () => {
    for (const step of STEPS) {
      const html = render(InviteComposer({ step, draft: draftWith() }) as ReactElement);
      expect(html.includes('data-testid="composer-send"'), step).toBe(step === "review");
    }
  });

  it("the reason is associated with the control", () => {
    const html = render(
      InviteComposer({ step: "review", draft: draftWith() }) as ReactElement,
    );
    expect(html).toContain('aria-describedby="composer-send-reason"');
    expect(html).toContain('id="composer-send-reason"');
  });
});

describe("mobile and tablet layout", () => {
  it("the step rail WRAPS rather than scrolling sideways", () => {
    // A horizontally scrolled rail hides steps with no affordance, and seeing
    // what has and has not been decided is this workflow's whole point.
    const html = render(
      InviteComposer({ step: "select", draft: draftWith() }) as ReactElement,
    );
    expect(html).toContain("flex-wrap");
    expect(html).not.toContain("overflow-x");
    expect(html).not.toContain("whitespace-nowrap");
  });

  it("marks the current step for assistive tech", () => {
    const html = render(
      InviteComposer({ step: "expiry", draft: draftWith() }) as ReactElement,
    );
    expect(html).toContain('aria-current="step"');
    expect([...html.matchAll(/aria-current="step"/g)]).toHaveLength(1);
  });

  it("every interactive control keeps the 44px floor", () => {
    const html = render(
      InviteComposer({ step: "expiry", draft: draftWith() }) as ReactElement,
    );
    const controls = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) {
      expect(c).toContain("min-h-[44px]");
      expect(c).toContain("inline-flex");
    }
  });

  it("no md:/lg: step — a tablet in portrait is still a thumb", () => {
    for (const step of STEPS) {
      const html = render(InviteComposer({ step, draft: draftWith() }) as ReactElement);
      expect(html, step).not.toMatch(/\bmd:/);
      expect(html, step).not.toMatch(/\blg:/);
    }
  });

  it("toggles carry aria-pressed, not colour alone", () => {
    const html = render(
      InviteComposer({ step: "days", draft: draftWith({ weekdays: [3] }) }) as ReactElement,
    );
    expect(buttonTag(html, "weekday-3")).toContain('aria-pressed="true"');
    expect(buttonTag(html, "weekday-0")).toContain('aria-pressed="false"');
  });

  it("expiry presets are full width on a phone and intrinsic from sm:", () => {
    const html = render(
      InviteComposer({ step: "expiry", draft: draftWith() }) as ReactElement,
    );
    expect(html).toContain("w-full");
    expect(html).toContain("sm:w-auto");
  });
});
