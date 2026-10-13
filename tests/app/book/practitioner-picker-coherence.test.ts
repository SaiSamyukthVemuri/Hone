import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// G1, from Codex's two P2 findings at 12033879. Both were one defect class:
// the picker's SURFACE and the question the SERVER answers disagreeing.
//
// THESE ARE SOURCE CONTRACTS, which are weaker than behavioural proof, and the
// reason is recorded rather than hidden: there is no render harness for
// PublicBookForm anywhere in the suite — every existing test of this file
// (referral-source-wiring, marketing-consent-compact, new-client-waitlist-ui,
// admission-presentation-order) greps its source. Adding a React harness for
// two guards is a bigger change than the fixes. The behavioural half lives in
// e2e/public-practitioner-picker.spec.ts, which proves scoped slots, parallel
// booking and same-practitioner refusal against real database rows.

const REPO_ROOT = path.resolve(__dirname, "../../..");
const FORM = readFileSync(
  path.join(REPO_ROOT, "app/book/[slug]/PublicBookForm.tsx"),
  "utf8",
);
const ACTIONS = readFileSync(
  path.join(REPO_ROOT, "app/book/[slug]/actions.ts"),
  "utf8",
);

// Slice one exported action's body by EXPORT BOUNDARIES, not by brace
// matching. A hand-written /export async function NAME[\s\S]*?\n\}/ is wrong
// here and silently so: these signatures put the parameter object's closing
// brace at column zero --
//
//   export async function fetchPublicPractitionerOptionsAction(params: {
//     slug: string;
//   }): Promise<
//
// -- so `\n\}` matches THAT line and the "body" is just the parameter list,
// which contains none of the logic under test. Two guards here passed review
// while asserting against a two-line slice. Boundaries are unambiguous.
function actionSource(name: string): string {
  const start = ACTIONS.indexOf(`export async function ${name}`);
  if (start < 0) return "";
  const next = ACTIONS.indexOf("\nexport ", start + 1);
  return ACTIONS.slice(start, next < 0 ? ACTIONS.length : next);
}

describe("G1: the sole-eligible gap is recorded, not silently fixed", () => {
  // Codex P2 at 12033879 is REAL and is NOT fixed in this lane. With exactly
  // one eligible practitioner the picker is hidden and practitionerId stays
  // empty, so submission sends NULL and create_public_appointment_v2 resolves
  // that down its legacy ACTIVE-OWNER path.
  //
  // The client-side fix was written and then REVERTED, because it breaks error
  // containment. Bisected: with `if (options.length === 1) setPractitionerId(...)`
  // present, public-booking-error-containment.spec.ts fails both cases; with
  // only that line reverted, both pass. The options read absorbs failure by
  // design, and assigning the sole option makes it the FIRST next-action POST
  // after the client-type choice -- which is exactly the POST that spec breaks,
  // so the injected failure is swallowed and the required boundary never
  // renders.
  //
  // These assertions pin the RETREAT so it cannot be undone by accident: the
  // absorbing read must stay absorbing, and the auto-assign must stay out of
  // this effect. The real fix belongs server-side at commit, and changes what
  // NULL means for a legacy studio -- a product decision.
  it("does not auto-assign inside the options effect", () => {
    // Comments may DISCUSS the reverted line; code may not contain it. Strip
    // line comments before asserting, or this guard passes on its own prose.
    const code = FORM.split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(
      code,
      "auto-assigning the sole option here makes this the first next-action " +
        "POST and swallows the failure public-booking-error-containment needs",
    ).not.toMatch(/options\.length === 1\s*\)\s*setPractitionerId\(/);
  });

  it("keeps the options read ABSORBING, which is why the retreat was needed", () => {
    expect(FORM).toMatch(/r\.ok \? r\.practitioners : \[\]/);
  });

  it("still hides the control when there is nothing to choose", () => {
    expect(FORM).toMatch(/pickerApplies && practitionerOptions\.length > 1/);
  });
});

describe("G1: the studio-wide jump is not offered against a chosen practitioner", () => {
  // THE DEFECT: "Next available" calls fetchNextAvailableDateAction, which is
  // studio-wide BY CONSTRUCTION -- it hands the window to
  // loadPublicSlotsByDate, whose PublicRangeContext has no practitioner field
  // and whose reservation read filters on studio_id alone. With a practitioner
  // selected it answered a different question than the grid beneath it: it
  // could skip a date they are free on (every other practitioner's booking
  // counts as a conflict) and land on a date whose scoped grid is empty.
  it("withdraws the jump only where a choice was OFFERED AND MADE", () => {
    // THE INTERACTION THIS FILE ORIGINALLY MISSED, and that five browser tests
    // caught instead. The first gate was `!(pickerApplies && practitionerId)`,
    // which looks right in isolation and is wrong next to its sibling fix: a
    // SOLE eligible practitioner is auto-assigned, so practitionerId is
    // non-empty on an ordinary single-practitioner studio where the control was
    // never rendered. That hid "Next available" for essentially every studio —
    // including from public-booking-error-containment.spec.ts, which presses it
    // to drive a Server Action.
    //
    // The options-count term is therefore load-bearing, not defensive: without
    // it the gate fires where no choice was ever offered.
    const gate = FORM.match(
      /const nextAvailableApplies = !\([\s\S]{0,200}?\);/,
    );
    expect(gate, "expected the next-available gate").not.toBeNull();
    expect(gate![0]).toContain("pickerApplies");
    expect(gate![0]).toContain("practitionerId");
    // DEFENCE IN DEPTH, and the history is why it is here. While the sole
    // option was briefly auto-assigned, practitionerId became non-empty on an
    // ordinary single-practitioner studio and this gate hid "Next available"
    // from essentially every studio -- five browser tests caught it. The
    // auto-assign is now reverted, so today practitionerId can only be set by
    // an explicit choice from a rendered picker, which already implies more
    // than one option. The term is kept so that reinstating any form of
    // auto-assignment cannot silently withdraw the jump a second time.
    expect(
      gate![0],
      "the gate must require more than one option, so that any future " +
        "auto-assignment cannot silently withdraw the jump",
    ).toContain("practitionerOptions.length > 1");
  });

  it("gates EVERY next-available surface, not just the empty-grid one", () => {
    // There are two surfaces (empty grid and populated grid) sharing one
    // handler. Gating one and forgetting the other is the obvious way for this
    // fix to half-land.
    const gated = FORM.match(/!nextAvailableApplies \? null :/g) ?? [];
    const handlers = FORM.match(/onClick=\{onFindNext\}/g) ?? [];
    expect(handlers.length, "expected both jump buttons to still exist").toBe(2);
    expect(
      gated.length,
      "every onFindNext surface must sit behind the gate",
    ).toBe(handlers.length);
  });

  it("does NOT pass a practitioner to the studio-wide action", () => {
    // The tempting fix was to thread the selection through and scope per date.
    // next-available-bounded.test.ts forbids exactly that: no getAvailableSlots
    // in that action, loadPublicSlotsByDate required, and no await inside a
    // loop (BOOK-NEXT-FAST-01). Scoping the jump means making the BULK pass
    // practitioner-aware, which needs its own slice -- see the comment on
    // nextAvailableApplies. This pins the boundary so a later edit does not
    // quietly reintroduce the per-day scan.
    // Deliberately the PARAMETER list only: the claim is that the action takes
    // no practitioner at all.
    const sig = ACTIONS.match(
      /export async function fetchNextAvailableDateAction\(params: \{[^}]*\}/,
    );
    expect(sig, "expected the action's parameter object").not.toBeNull();
    expect(sig![0]).not.toContain("practitionerId");
  });
});

describe("G1: the public-assignment kill switch is enforced SERVER-SIDE", () => {
  // THE P1. `practitioner_capacity_booking_enabled` (0136) defaults FALSE and
  // `capacity=false + booking=true` is rejected by a CHECK (0136:52), so this
  // one flag is the strictest correct gate: booking implies capacity. Shipping
  // G1 without it would have activated practitioner selection on every open
  // new-client studio, including every LEGACY studio.
  //
  // The gate must live in the ACTIONS, not only in the form, or a client could
  // grant itself a surface the operator switched off. Three entry points touch
  // a practitioner and all three are pinned here.
  it("returns NO options while public assignment is disabled", () => {
    const body = actionSource("fetchPublicPractitionerOptionsAction");
    expect(body, "expected the options action").not.toBe("");
    expect(body).toContain("practitioner_capacity_booking_enabled");
    expect(
      body,
      "with assignment off the action must return an EMPTY option set, which " +
        "is what keeps the picker from rendering at all",
    ).toMatch(/practitioners:\s*\[\]/);
  });

  it("refuses to scope the GRID while public assignment is disabled", () => {
    // Scoping the grid to a practitioner the commit path would then ignore is
    // the page/command disagreement this lane exists to remove.
    const body = actionSource("fetchPublicSlotsAction");
    expect(body, "expected the slots action").not.toBe("");
    expect(body).toContain("practitioner_capacity_booking_enabled");
  });

  it("REFUSES a practitioner it cannot honour, instead of silently substituting", () => {
    // The second P1. This block used to fall back to "any available" when the
    // submitted id did not validate -- which reads as forgiving and is worse:
    // the visitor EXPLICITLY picked someone and the booking then succeeded
    // with the ACTIVE OWNER instead, silently. A deactivated or unpinned
    // practitioner, and a transient failure of the eligibility read, both land
    // there. An ABSENT id still means "any available"; that is untouched.
    const block = actionSource("publicBookAppointmentAction");
    expect(block, "expected the booking action").not.toBe("");
    expect(block).toContain("practitioner_capacity_booking_enabled");
    // BOTH failure paths must refuse: assignment disabled, and id not offered.
    const refusals = block.match(/PRACTITIONER_CHOICE_UNAVAILABLE_ERROR/g) ?? [];
    expect(
      refusals.length,
      "both the disabled-assignment path and the not-offered path must refuse",
    ).toBeGreaterThanOrEqual(2);
  });
});
