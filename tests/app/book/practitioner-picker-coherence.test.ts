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

describe("G1: the actionable refusal is REACHABLE for a new client", () => {
  // CODEX P2 at 0fd7cdc2. 0225's practitioner gate runs before the
  // resolve-or-create, so its refusals carry a NULL client_id by design. The
  // action's missing-client guard treats a null client as "the command did not
  // resolve one" and returns the generic error -- so the practitioner-specific
  // message mapped further down was DEAD CODE for the primary new-client case,
  // where there is no resolvedClientId to fall back on.
  //
  // The property is ORDER, so that is what this asserts: the pre-insert
  // refusals must be answered BEFORE the guard that requires a client id.
  // A position assertion is brittle about everything except the one thing that
  // matters here, which is why the failure message says what to do.
  it("answers pre-insert practitioner refusals before the missing-client guard", () => {
    const refusal = ACTIONS.indexOf("public_booking_practitioner_refused_pre_insert");
    const guard = ACTIONS.indexOf("public_booking_client_not_resolved");
    expect(refusal, "expected the pre-insert refusal branch").toBeGreaterThan(-1);
    expect(guard, "expected the missing-client guard").toBeGreaterThan(-1);
    expect(
      refusal < guard,
      "the pre-insert practitioner refusals must be handled BEFORE the " +
        "missing-client guard, or the actionable message is unreachable for a " +
        "new email (null client_id is correct for those refusals)",
    ).toBe(true);
  });

  it("still maps the refusal in the later group, for the existing-client path", () => {
    // Not redundant: on the existing-client path resolvedClientId is non-null,
    // the missing-client guard never fires, and the later mapping is the one
    // that serves that branch. Deleting it would silently downgrade that path
    // to the generic error.
    const later = ACTIONS.indexOf('commandResult === "practitioner_assignment_disabled"');
    expect(later, "the later mapping must remain for the existing-client path").toBeGreaterThan(-1);
  });
});

describe("G1: the GRID refuses a practitioner the COMMIT would refuse", () => {
  // CODEX P2 at 69d20c26, and the third instance in this lane of fixing one
  // side of the page/command pair and leaving the other. The slots action used
  // to validate the submitted practitioner and, on failure, return STUDIO-WIDE
  // slots while the picker still named the chosen practitioner. Once the commit
  // path refused (the earlier P1), the grid and the commit disagreed outright:
  // times offered, then "that practitioner is no longer available".
  //
  // The studio-wide path must therefore be reachable ONLY when the request
  // omitted a practitioner.
  it("refuses instead of falling back to studio-wide slots", () => {
    const body = actionSource("fetchPublicSlotsAction");
    expect(body, "expected the slots action").not.toBe("");
    // Both refusal paths: assignment disabled, and an id that cannot validate.
    const refusals = body.match(/PRACTITIONER_CHOICE_UNAVAILABLE_ERROR/g) ?? [];
    expect(
      refusals.length,
      "the slots action must refuse BOTH a disabled switch and an " +
        "unvalidatable id, rather than serving a studio-wide grid the commit " +
        "path will then refuse",
    ).toBeGreaterThanOrEqual(2);
  });

  it("says the SAME thing the commit path says", () => {
    // One constant, two surfaces. If the grid and the commit ever carry
    // different copy for the same refusal, the visitor is told two stories.
    const slots = actionSource("fetchPublicSlotsAction");
    const commit = actionSource("publicBookAppointmentAction");
    expect(slots).toContain("PRACTITIONER_CHOICE_UNAVAILABLE_ERROR");
    expect(commit).toContain("PRACTITIONER_CHOICE_UNAVAILABLE_ERROR");
  });
});

describe("G1: an in-flight studio-wide lookup cannot outlive the choice", () => {
  // CODEX P2 at daf59463. The picker stays enabled while onFindNext is pending,
  // so a visitor can start "Next available" under "Any available" and then pick
  // a practitioner before the answer returns. That answer is STUDIO-WIDE, and
  // it would still have run setDate(r.date) -- jumping to a date the chosen
  // practitioner may have no slots on, after the button that started it had
  // already disappeared.
  it("compares the latest selection, not the one captured at call time", () => {
    const form = FORM;
    // A ref is the only thing that reads "now" from inside the closure;
    // comparing the closed-over `practitionerId` would always match itself.
    expect(form).toMatch(/practitionerIdRef\s*=\s*useRef\(/);
    // The ref is written SYNCHRONOUSLY in the selection mutation. An earlier
    // revision mirrored it in a passive useEffect, which lagged the commit --
    // see the synchronous-write describe below.
    expect(form).toMatch(/practitionerIdRef\.current\s*=\s*next/);
    expect(
      form,
      "the in-flight response must be compared against the CURRENT selection",
    ).toMatch(/practitionerIdRef\.current\s*!==\s*requestedUnder/);
  });

  it("bails BEFORE any state write, not just before setDate", () => {
    // setNextSearched, setError and setNoneInHorizon are equally wrong to apply
    // from a lookup the visitor has moved past, so the guard must precede all
    // of them. Order is the property, as with the pre-insert refusals.
    const body = FORM.slice(FORM.indexOf("function onFindNext"));
    const bail = body.indexOf("practitionerIdRef.current !== requestedUnder");
    const firstWrite = body.indexOf("setNextSearched(true)");
    expect(bail, "expected the invalidation guard").toBeGreaterThan(-1);
    expect(firstWrite, "expected the first state write").toBeGreaterThan(-1);
    expect(
      bail < firstWrite,
      "the guard must precede every state write from the stale response",
    ).toBe(true);
  });
});

describe("G1: the invalidation ref is written synchronously, and cannot be bypassed", () => {
  // CODEX P2 at 41e0d6f3, about the fix for the P2 before it. The ref was
  // mirrored in a useEffect, which is PASSIVE: React can commit the new
  // selection while that effect is pending, so a lookup completing in the
  // window read the PREVIOUS value, passed the guard, and applied the stale
  // studio-wide response anyway. The guard was real; its input was late.
  const CODE = FORM.split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  it("writes the ref inside the selection mutation, not in an effect", () => {
    // ORDER inside the funnel is the property, not adjacency. An earlier
    // version of this assertion required `{` to be immediately followed by the
    // ref write, and reded the moment a no-op early-return was added above it
    // -- encoding the incidental shape of the code instead of the invariant.
    const fn = CODE.match(/const selectPractitioner = \(next: string\) => \{[\s\S]*?\n  \};/);
    expect(fn, "expected the selection funnel").not.toBeNull();
    const refWrite = fn![0].indexOf("practitionerIdRef.current = next");
    const stateSet = fn![0].indexOf("setPractitionerId(next)");
    expect(refWrite, "the funnel must write the ref").toBeGreaterThan(-1);
    expect(stateSet, "the funnel must set the state").toBeGreaterThan(-1);
    expect(
      refWrite < stateSet,
      "the ref must be written BEFORE the state, in the same synchronous turn",
    ).toBe(true);
    // The passive mirror must be gone: two writers for one value is how they
    // drift apart.
    expect(
      CODE,
      "the ref must not also be mirrored in a useEffect -- that is the lag " +
        "this finding was about",
    ).not.toMatch(/useEffect\(\(\) => \{\s*practitionerIdRef\.current/);
  });

  it("funnels EVERY practitioner mutation through it", () => {
    // Comments mention setPractitionerId by name when explaining the history,
    // so this counts CODE occurrences only -- a guard that reads its own prose
    // is a guard that cannot fail.
    const calls = CODE.match(/setPractitionerId\(/g) ?? [];
    expect(
      calls.length,
      "setPractitionerId may be called ONLY inside selectPractitioner; a " +
        "fourth mutation site that sets state directly would leave the ref " +
        "stale and silently re-open the race",
    ).toBe(1);
    // And the known sites all go through the funnel.
    // Three call sites today: the picker's onChange, the per-service reset and
    // the reconcile against returned options. Counted as a floor, not an exact
    // number, so adding a fourth that USES the funnel does not red this.
    expect((CODE.match(/selectPractitioner\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("G1: the jump history does not survive a scope change", () => {
  // CODEX P2 at 9f4f92ba, and the surface I had explicitly considered in my own
  // audit and talked myself out of. dateHistory holds dates reached by "Next
  // available", which answers STUDIO-WIDE. The forward control is hidden once a
  // practitioner is chosen, but "Back to previous result" renders from the
  // stack alone -- so it survived the scope change and could navigate to a
  // studio-wide result the chosen practitioner has no availability on.
  const CODE = FORM.split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  it("clears it inside the selection mutation, synchronously", () => {
    const fn = CODE.match(/const selectPractitioner = \(next: string\) => \{[\s\S]*?\n  \};/);
    expect(fn, "expected the selection funnel").not.toBeNull();
    expect(
      fn![0],
      "a scope change must clear the studio-wide jump history, or 'Back to " +
        "previous result' navigates to a date answering a different question",
    ).toContain("setDateHistory([])");
  });

  it("does NOT also clear it from the serviceId effect", () => {
    // Two writers for one piece of state is how the ref and the state drifted
    // in the previous finding, and the passive one would be the slower.
    const eff = CODE.match(/useEffect\(\(\) => \{\s*setDateHistory\(\[\]\);\s*\}, \[([^\]]*)\]\)/);
    expect(eff, "expected the serviceId history reset").not.toBeNull();
    expect(eff![1]).toContain("serviceId");
    expect(
      eff![1],
      "practitionerId belongs in the funnel, not in this passive effect",
    ).not.toContain("practitionerId");
  });
});

describe("G1: every refusal is answered at the boundary that actually fires", () => {
  // CODEX P2 4264946618, and the THIRD instance of one shape in this PR: a
  // message added to the later result mapping while an earlier guard returns
  // first, so the copy is dead exactly on the reachable path. It happened with
  // practitioner_assignment_disabled, then with the pre-insert refusals, and
  // then with no_practitioner_available.
  //
  // The pre-insert guard fires for a NEW CLIENT -- the reachable public surface
  // -- because 0225 answers these before the resolve-or-create and they
  // therefore carry a null client_id. So any code handled there must get its
  // final copy THERE, not later.
  it("gives no_practitioner_available the stale-slot copy at the EARLY boundary", () => {
    const block = ACTIONS.slice(
      ACTIONS.indexOf("public_booking_practitioner_refused_pre_insert"),
      ACTIONS.indexOf("public_booking_client_not_resolved"),
    );
    expect(block, "expected the pre-insert refusal block").not.toBe("");
    expect(
      block,
      "an ordinary stale-slot outcome must not reach the visitor as the " +
        "generic error just because the early guard returned first",
    ).toContain("PUBLIC_BOOKING_SLOT_TAKEN_ERROR");
  });

  it("keeps operator-visible states GENERIC, so copy does not describe the roster", () => {
    // invalid_practitioner / not_eligible are configuration states a visitor
    // cannot act on. Telling them apart in copy would leak which practitioners
    // a studio has and how booked they are; the distinction stays in the log.
    const block = ACTIONS.slice(
      ACTIONS.indexOf("public_booking_practitioner_refused_pre_insert"),
      ACTIONS.indexOf("public_booking_client_not_resolved"),
    );
    expect(block).toContain("PUBLIC_BOOKING_GENERIC_ERROR");
    expect(block, "the refused code is still recorded for the operator").toContain(
      "code: rawCommandResult",
    );
  });

  it("uses ONE constant for the stale-slot sentence, not two copies", () => {
    const code = ACTIONS.split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    const inline = code.match(/"That time has just been taken/g) ?? [];
    expect(
      inline.length,
      "the sentence must live in the constant only -- it is returned from two " +
        "boundaries and two copies of one sentence is how they drift",
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Codex P1 4265558721 — "Any available" must consider the UNION of eligible
// practitioners, in the grid AND in the submission re-verification.
//
// WHY THESE GUARDS EXIST AT ALL: the 22 assertions above all passed, unchanged,
// against the broken code AND against the fix. They pin the SCOPED and REFUSED
// paths; nothing in them looked at what "Any available" asks for. So the fix
// shipped unprotected until this block, and the regression it invites is the
// cheapest one in this whole lane -- delete one branch and the studio-wide
// answer silently returns.
// ---------------------------------------------------------------------------

/** Comment-stripped source of one action: these guards assert about CODE, and
 *  every comment in that code now DISCUSSES the studio-wide branch it removed. */
function actionCode(name: string): string {
  return actionSource(name)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

describe('G1 / P1: "Any available" resolves against eligible practitioners', () => {
  it("the grid takes a union branch when assignment is enabled", () => {
    const code = actionCode("fetchPublicSlotsAction");
    expect(code, "fetchPublicSlotsAction must exist").not.toBe("");
    expect(
      code.includes("practitioner_capacity_booking_enabled === true"),
      "the grid must branch on the assignment switch: with it OFF the legacy " +
        "studio-wide answer is still correct, with it ON that answer is wrong " +
        "in both directions",
    ).toBe(true);
    expect(
      code.includes("unionEligibleSlots"),
      "an enabled studio with no practitioner chosen must ask the union, not " +
        "the studio-wide question",
    ).toBe(true);
  });

  it("the re-verification asks the SAME union as the grid", () => {
    const code = actionCode("publicBookAppointmentAction");
    expect(code, "publicBookAppointmentAction must exist").not.toBe("");
    expect(
      code.includes("unionEligibleSlots"),
      "re-verifying studio-wide while the grid asked the union makes the " +
        "action a SECOND availability authority that refuses slots the page " +
        "offered and the command would have accepted -- the exact mismatch " +
        "this lane exists to remove",
    ).toBe(true);
  });

  it("the union is per-practitioner reads, never a widened conflict filter", () => {
    // THE TEMPTING WRONG SHAPE. `.in("resource_key", ids)` reads like "all of
    // them" and means the opposite: it collects EVERY listed practitioner's
    // conflicts, which is more conflicts than any single one has -- the
    // false-negative bug with extra steps.
    const union = ACTIONS.slice(
      ACTIONS.indexOf("async function unionEligibleSlots"),
    ).slice(0, 2000);
    expect(union, "unionEligibleSlots must exist").not.toBe("");
    expect(
      /\.in\(\s*["']resource_key["']/.test(union),
      "a widened resource_key filter is intersection-of-busy, not union-of-free",
    ).toBe(false);
    expect(
      union.includes("Promise.all"),
      "the per-practitioner reads are independent and must not be serialised",
    ).toBe(true);
    expect(
      union.includes("getAvailableSlots"),
      "the union must REUSE the proven per-practitioner authority rather than " +
        "reimplement availability",
    ).toBe(true);
  });

  it("the horizon scan unions through the BULK context, never per day", () => {
    // SUPERSEDED INTENT, DELIBERATELY REWRITTEN. This guard used to assert that
    // the horizon scan was NOT unioned at all, which was right while the fix
    // covered only the single-day grid -- and became a guard documenting the
    // OPPOSITE of the design once Codex P2 4265796486 was repaired. A guard
    // that still passes while describing the wrong invariant is worse than no
    // guard, so it now pins what actually has to hold.
    //
    // BOOK-NEXT-FAST-01 is unchanged and still the binding constraint: the
    // union happens inside `loadPublicSlotsByDate`, in memory, over
    // reservations that one bulk pass already loaded, with the eligible set
    // handed down as `practitionerIds`. What is forbidden is reaching for the
    // SINGLE-DAY engines here -- `getAvailableSlots` or `unionEligibleSlots` --
    // because either one puts a query inside the horizon loop, which is the
    // 4N-serial shape that law exists to prevent.
    const code = actionCode("fetchNextAvailableDateAction");
    expect(code, "fetchNextAvailableDateAction must exist").not.toBe("");
    expect(
      code.includes("practitionerIds"),
      "the jump must pass the eligible set to the bulk loader, or it asks a " +
        "studio-wide question the grid beneath it disagrees with",
    ).toBe(true);
    expect(
      code.includes("unionEligibleSlots") || code.includes("getAvailableSlots"),
      "the single-day engines must stay out of the horizon scan -- that is the " +
        "per-day query shape BOOK-NEXT-FAST-01 removed",
    ).toBe(false);
  });

  it("the jump is gated on the client type, like the grid and the commit", () => {
    const code = actionCode("fetchNextAvailableDateAction");
    expect(
      /params\.newClient === true\s*&&/.test(code),
      "an EXISTING client commits studio-wide, so their jump must be " +
        "studio-wide too; absent means legacy, as everywhere else",
    ).toBe(true);
  });

  it("the form tells BOTH server actions which command will commit", () => {
    // NOT A CHARACTER-DISTANCE GUARD. The first attempt matched
    // `fetchNextAvailableDateAction\([\s\S]{0,260}?newClient: isNewClient`,
    // and it failed on the comment I had just written above the argument --
    // the guard was measuring prose length, not behaviour, and widening the
    // number would only move the next break. Both call sites must pass the
    // flag, so COUNT them in comment-stripped code: the grid and the jump.
    const code = FORM.split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    const callSites = code.match(/fetch(PublicSlots|NextAvailableDate)Action\(/g) ?? [];
    const flagged = code.match(/newClient:\s*isNewClient/g) ?? [];
    expect(callSites.length, "expected the grid and the jump").toBe(2);
    expect(
      flagged.length,
      "every server action whose answer depends on which command commits must " +
        "be told -- a missing flag silently falls back to legacy for NEW clients",
    ).toBe(callSites.length);
  });

  it("an enabled studio with nobody eligible refuses instead of lying", () => {
    const code = actionCode("fetchPublicSlotsAction");
    expect(
      code.includes("public_slots_no_eligible_practitioner"),
      "an empty eligible set must refuse: an empty GRID reads as 'fully " +
        "booked' and a studio-wide grid offers times the command answers " +
        "no_practitioner_available",
    ).toBe(true);
  });

  // Codex P1 4265796478. The union is correct for the command a NEW client
  // commits through (0225 -> 0222, practitioner-aware) and WRONG for the one an
  // EXISTING client still commits through (the legacy studio-wide
  // `create_public_appointment`). The first version of the union fix ignored
  // that and so reintroduced the page/command mismatch one branch over: an
  // existing client was offered a slot only practitioner B was free for, passed
  // re-verification on the union, and had the legacy command refuse it.
  it("the union is gated on the client type, in BOTH places", () => {
    const grid = actionCode("fetchPublicSlotsAction");
    expect(
      /forNewClient\s*&&\s*studio\.practitioner_capacity_booking_enabled === true/.test(
        grid,
      ),
      "the GRID must union only for the client type whose command is " +
        "practitioner-aware",
    ).toBe(true);

    // PIN THE CONJUNCTION, NOT THE TOKEN. The first version of this guard
    // tested `/clientType === "new"/` against the whole action and passed
    // against a mutant that removed the gate from the re-verification --
    // because that phrase occurs FOUR other times in this action (the
    // admission gate, the consultation rule, the submitted-practitioner
    // branch). A token that appears elsewhere cannot witness a condition
    // here. The mutant run caught it; the three operands must be asserted
    // together, as one condition.
    const commit = actionCode("publicBookAppointmentAction");
    expect(
      /!chosenPractitionerId\s*&&\s*clientType === "new"\s*&&\s*studio\.practitioner_capacity_booking_enabled === true/.test(
        commit,
      ),
      "the RE-VERIFICATION must gate the union on the same discriminator the " +
        "commit uses, or it is more permissive than the command it hands to",
    ).toBe(true);
    expect(
      commit.includes("unionEligibleSlots"),
      "the re-verification must still ask the union on the new-client path",
    ).toBe(true);
  });

  it("absent means legacy — the union is opt-in, never inferred", () => {
    const grid = actionCode("fetchPublicSlotsAction");
    expect(
      grid.includes("params.newClient === true"),
      "an omitted flag must get the STUDIO-WIDE answer: that is pre-G1 " +
        "behaviour and the one the legacy command shares, so a caller that " +
        "does not opt in cannot be handed the more permissive grid",
    ).toBe(true);
  });

  it("a practitioner id outside the new-client path is refused, not scoped", () => {
    const grid = actionCode("fetchPublicSlotsAction");
    expect(
      grid.includes("public_slots_practitioner_not_new_client"),
      "the picker is new-client only, so a practitioner elsewhere is a call " +
        "the UI cannot make; scoping it would offer a scoped grid for a " +
        "booking the studio-wide command decides -- the same mismatch by " +
        "another route",
    ).toBe(true);
  });

  it("the form tells the action which command will commit", () => {
    expect(
      /newClient:\s*isNewClient/.test(FORM),
      "without this the grid falls back to legacy for NEW clients too, " +
        "silently undoing the union fix",
    ).toBe(true);
  });
});
