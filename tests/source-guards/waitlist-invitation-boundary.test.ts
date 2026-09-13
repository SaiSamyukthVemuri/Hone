import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// WAIT-03 B3 — the recipient surface's boundary.
//
// The behavioural suite proves the screen renders no booking control on a dead
// end. This proves the SOURCE cannot mutate at all, which is the stronger
// statement: B1.5c exists because possession of the invitation URL must not be
// authority, and a presentation layer that could reach a server action would
// hand that authority straight back.
//
// It also pins the "no second availability engine" rule, which is a shape a
// behavioural test cannot see: a component that computed its own slots would
// pass every render assertion in this repository.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments explain the rules; they must never satisfy them. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const SCREEN = codeOnly(read("app/features/waitlist-invitation/InvitationScreen.tsx"));
const STATE = codeOnly(read("lib/waitlist/invitation-offer.ts"));
const ACTIONS = codeOnly(read("app/invitation/[token]/actions.ts"));

describe("the recipient surface cannot mutate", () => {
  it("declares no server action", () => {
    expect(SCREEN, "a server action was declared in the view").not.toContain("use server");
    expect(STATE).not.toContain("use server");
  });

  it("imports no action module", () => {
    for (const src of [SCREEN, STATE]) {
      expect(src).not.toMatch(/from\s+["'][^"']*actions["']/);
      expect(src).not.toMatch(/from\s+["'][^"']*\/actions[^"']*["']/);
    }
  });

  it("performs no network call of its own", () => {
    for (const src of [SCREEN, STATE]) {
      expect(src).not.toContain("fetch(");
      expect(src).not.toContain("XMLHttpRequest");
      expect(src).not.toContain("navigator.sendBeacon");
    }
  });

  it("never reaches a database client", () => {
    for (const src of [SCREEN, STATE]) {
      expect(src).not.toContain("supabase");
      expect(src).not.toContain("createClient");
    }
  });

  it("book and decline are CALLBACKS the container supplies", () => {
    // The only way this surface can cause an effect is one the eventual
    // B2-owned container hands it.
    expect(SCREEN).toContain("onBook: () => void");
    expect(SCREEN).toContain("onDecline: () => void");
  });
});

describe("there is no second availability engine", () => {
  it("slots arrive as data and are never computed", () => {
    for (const forbidden of [
      "day_of_week",
      "practitioner_availability",
      "studio_wide",
      "generateSlots",
      "buildSlots",
      "availability_exceptions",
    ]) {
      expect(SCREEN, `computed availability: ${forbidden}`).not.toContain(forbidden);
      expect(STATE, `computed availability: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("date arithmetic comes from the shared tz helpers, not a local copy", () => {
    expect(STATE).toContain('from "@/lib/booking/tz"');
    expect(STATE).toContain("localDateString");
    // NOTHING here builds a Date. The window walk uses tz.addDays and the
    // weekday comes from B2's contract, so there is no local date construction
    // left to drift.
    // Dates are constructed only to PARSE -- a slot instant for B2's evaluator,
    // and a YMD for its day label. What must not exist is window arithmetic:
    // no adding days, no comparing against the scope bounds by hand.
    expect(STATE).not.toContain("addDays");
    expect(STATE).not.toContain("setUTCDate");
    expect(STATE).not.toContain("getTime() +");
  });
});

// B2 IS NOW THE AUTHORITY, AND B3 CONSUMES IT.
//
// The pure slice injected a weekday contract because B2 was unfrozen. It is
// frozen now, so these assertions pin the stronger property: B3 reaches the
// window verdict through B2's OWN evaluator, and restates neither the
// numbering nor the null/empty rule. The pure slice had that rule INVERTED --
// it read an empty list as "every day" where B1 fails closed -- which is
// exactly the divergence a second implementation produces.
describe("the window rule is B2's, reached through B2's evaluator", () => {
  it("calls evaluateInvitationScope rather than re-deriving the rule", () => {
    expect(STATE).toContain('from "@/lib/booking/waitlist-invitation-scope"');
    expect(STATE).toContain("evaluateInvitationScope({");
  });

  it("carries no window comparison of its own", () => {
    // A local date/weekday comparison would be the second engine.
    expect(STATE).not.toContain("startDate <");
    expect(STATE).not.toContain("> scope.endDate");
    expect(STATE).not.toMatch(/allowedWeekdays\s*\.includes/);
  });

  it("computes no weekday from a date", () => {
    for (const forbidden of ["getUTCDay", "getDay(", "day_of_week", "dayOfWeek"]) {
      expect(STATE, `B3 computed a weekday: ${forbidden}`).not.toContain(forbidden);
      expect(SCREEN, `B3 computed a weekday: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("projects through the studio timezone, not naive UTC", () => {
    // A weekday read in UTC would refuse a Monday-evening slot east of UTC.
    expect(STATE).toContain("localDayOfWeek");
    expect(STATE).toContain("studioTimezone");
  });

  it("the SCREEN never sees a weekday index or a scope at all", () => {
    expect(SCREEN).toContain("windowDescription");
    expect(SCREEN).not.toContain("allowedWeekdays");
    expect(SCREEN).not.toContain("evaluateInvitationScope");
  });
});

describe("possession is not authority", () => {
  it("the slot list is gated on proven proof", () => {
    // The whole reason B1.5c exists. A forwarded link shows the offer's shape
    // and nothing bookable.
    expect(STATE).toContain('ctx.proof.kind !== "proven"');
    const gate = STATE.indexOf('ctx.proof.kind !== "proven"');
    const build = STATE.indexOf("filterSlotsToScope(scope", gate);
    expect(gate, "slots are built before proof is checked").toBeLessThan(build);
  });

  it("the raw contact never reaches the screen", () => {
    expect(SCREEN).not.toContain("deliveryContact");
    expect(SCREEN).toContain("maskedContact");
  });
});

// REVIEW P2, STRUCTURALLY. The bug was not a missing branch -- it was a
// catch-all `else` that let `ProofStage` grow while the view stood still. These
// pin the shape that makes the next such addition impossible.
describe("the proof view is exhaustive over ProofStage", () => {
  const render = SCREEN.slice(SCREEN.indexOf("function renderProofStage"));

  it("branches with a switch, not a chain of ternaries", () => {
    expect(render).toContain("switch (stage.kind)");
    // The old shape: `x ? … : y ? … : <start over>`. A catch-all tail is what
    // let `verifying` land on "Email me a code".
    expect(render).not.toContain("awaitingCode ?");
  });

  it("has a never-typed default, so a new stage fails the build", () => {
    expect(render).toContain("default:");
    expect(render).toContain("assertNeverStage(stage)");
    expect(SCREEN).toContain("function assertNeverStage(stage: never)");
  });

  it("names every stage the view can receive, and only those", () => {
    // Derived from the union itself, so a stage added to the type without a
    // case here fails this assertion as well as `tsc`.
    const union = STATE.slice(
      STATE.indexOf("export type ProofStage"),
      STATE.indexOf("export type UnprovenProofStage"),
    );
    const declared = [...union.matchAll(/kind:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    // ANTI-VACUITY: if the slice or the regex ever matched nothing, the loop
    // below would pass while asserting nothing at all.
    expect(declared.length, "the stage list came back empty").toBeGreaterThanOrEqual(6);
    expect(declared).toContain("verifying");

    for (const kind of declared) {
      if (kind === "proven") {
        // Excluded from the view's union by type, so it must NOT have a case:
        // an unreachable no-op is what let `proven` be passable in the first
        // place.
        expect(render, "`proven` is handled here instead of excluded by type")
          .not.toContain('case "proven"');
        continue;
      }
      expect(render, `ProofStage "${kind}" has no case`).toContain(`case "${kind}"`);
    }
  });

  it("the proof view's stage type EXCLUDES proven", () => {
    expect(STATE).toContain('export type UnprovenProofStage = Exclude<ProofStage, { kind: "proven" }>');
    expect(STATE).toContain("stage: UnprovenProofStage;");
    expect(SCREEN).toContain("stage: UnprovenProofStage,");
  });

  it("verifying offers no way to restart the exchange", () => {
    const branch = render.slice(render.indexOf('case "verifying"'), render.indexOf('case "sent"'));
    expect(branch.length).toBeGreaterThan(80);
    expect(branch).not.toContain("onRequestCode");
    expect(branch).not.toContain("<button");
    expect(branch).toContain('aria-busy="true"');
    expect(branch).toContain("submittedCode");
  });
});

// The same union-growth failure, one level up. The screen dispatched with seven
// independent ternaries, so a new InvitationViewState member would have
// rendered an empty page while `tsc` passed.
describe("the top-level view dispatch is exhaustive too", () => {
  it("switches on state.kind with a never-typed default", () => {
    expect(SCREEN).toContain("switch (state.kind)");
    expect(SCREEN).toContain("assertNeverState(state)");
    expect(SCREEN).toContain("function assertNeverState(state: never)");
  });

  it("has no ternary chain left to fall through", () => {
    expect(SCREEN).not.toMatch(/state\.kind === "[a-z_]+" \? /);
  });

  it("names every InvitationViewState member", () => {
    const union = STATE.slice(
      STATE.indexOf("export type InvitationViewState"),
      STATE.indexOf("export function slotWithinScope"),
    );
    const declared = [...union.matchAll(/kind:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(declared.length, "the state list came back empty").toBeGreaterThanOrEqual(6);
    for (const kind of declared) {
      expect(SCREEN, `InvitationViewState "${kind}" has no case`).toContain(`case "${kind}"`);
    }
  });
});

describe("terminal copy is exhaustive over the reason union", () => {
  it("is keyed by the union, not by string, and has no fallback", () => {
    expect(SCREEN).toContain("Record<InvitationClosedReason, { title: string; body: string }>");
    // The fallback silently told a future reason that the invitation expired.
    expect(SCREEN).not.toContain("?? CLOSED_COPY.expired");
  });

  it("carries an entry for every declared reason", () => {
    const union = STATE.slice(
      STATE.indexOf("export type InvitationClosedReason"),
      STATE.indexOf("export type InvitationViewState"),
    );
    const declared = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(declared.length, "the reason list came back empty").toBeGreaterThanOrEqual(4);
    for (const reason of declared) {
      expect(SCREEN, `no closed copy for "${reason}"`).toContain(`${reason}: {`);
    }
  });
});

describe("the submitted code cannot push the page sideways", () => {
  it("wraps a 64-character token rather than overflowing", () => {
    const branch = SCREEN.slice(SCREEN.indexOf('case "verifying"'), SCREEN.indexOf('case "sent"'));
    expect(branch).toContain("break-all");
    expect(branch).toContain("[overflow-wrap:anywhere]");
  });
});

// NARROW THE TYPE, NOT THE MAPPER. Three rounds running, a producer was fixed
// while the exported type stayed wide enough to express the broken state.
describe("proof-failure recovery is an explicit closed list", () => {
  it("is enumerated, never derived by Exclude", () => {
    // `Exclude` got the DEFAULT wrong: a new terminal outcome would have been
    // recoverable by omission and rendered above live Confirm and Resend.
    expect(STATE).toContain("export type RecoverableProofFailure =");
    expect(STATE, "recovery is still derived by subtraction").not.toContain(
      "RecoverableProofFailure = Exclude<",
    );
    const decl = STATE.slice(
      STATE.indexOf("export type RecoverableProofFailure ="),
      STATE.indexOf(";", STATE.indexOf("export type RecoverableProofFailure =")),
    );
    for (const terminal of ["verified", "unavailable", "invalid_token", "not_live"]) {
      expect(decl, `${terminal} is recoverable`).not.toContain(`"${terminal}"`);
    }
    expect(decl).toContain('"wrong_challenge"');
  });

  it("the complete-proof mapper is exhaustive with a never guard", () => {
    const fn = STATE.slice(
      STATE.indexOf("export function proofStageFromComplete"),
      STATE.indexOf("function assertNeverCompleteOutcome"),
    );
    expect(fn.length).toBeGreaterThan(200);
    expect(fn, "a catch-all still classifies unknown outcomes").not.toMatch(
      /default:\s*\n\s*return \{ kind: "failed"/,
    );
    expect(fn).toContain("assertNeverCompleteOutcome(outcome)");
    expect(STATE).toContain("function assertNeverCompleteOutcome(outcome: never)");
  });

  it("the copy map is keyed by that list and carries no terminal entries", () => {
    expect(SCREEN).toContain("Record<RecoverableProofFailure, string>");
    const map = SCREEN.slice(
      SCREEN.indexOf("const PROOF_FAILURE_COPY"),
      SCREEN.indexOf("};", SCREEN.indexOf("const PROOF_FAILURE_COPY")),
    );
    expect(map.length).toBeGreaterThan(100);
    expect(map).not.toContain("invalid_token:");
    expect(map).not.toContain("not_live:");
  });
});

describe("the begin-proof mapping is exhaustive", () => {
  const fn = STATE.slice(
    STATE.indexOf("export function proofStageFromBegin"),
    STATE.indexOf("export function proofStageFromComplete"),
  );

  it("enumerates the terminal outcomes rather than defaulting", () => {
    expect(fn.length).toBeGreaterThan(100);
    for (const kind of ["invalid_token", "not_live", "invalid_input"]) {
      expect(fn, `${kind} is not enumerated`).toContain(`case "${kind}"`);
    }
  });

  it("has a never guard, so a new authority outcome must decide its own retryability", () => {
    expect(fn).toContain("assertNeverBeginOutcome(outcome)");
    expect(STATE).toContain("function assertNeverBeginOutcome(outcome: never)");
  });
});

describe("a booking in flight cannot have its slot changed", () => {
  it("slot controls are disabled by the same pending flag as book", () => {
    const grid = SCREEN.slice(SCREEN.indexOf("day.slots.map"), SCREEN.indexOf("</section>", SCREEN.indexOf("day.slots.map")));
    expect(grid.length).toBeGreaterThan(100);
    expect(grid, "slots stayed clickable during a booking").toContain("disabled={pending}");
  });
});

// THE CLIENT BOUNDARY. The offer state carried B2's whole `ResolvedInvitation`
// into a `"use client"` component that never read it.
describe("no invitation authority can cross to the client", () => {
  it("the offer state has no invitation property to assign into", () => {
    // A NARROWER TYPE WAS NOT A BOUNDARY. TypeScript's structural
    // assignability lets a caller pass a whole `ResolvedInvitation` into a
    // narrower slot -- excess-property checking applies only to object
    // literals -- and React serialises the runtime object with every key. The
    // property is gone instead.
    const offer = STATE.slice(STATE.indexOf('kind: "offer";'), STATE.indexOf('kind: "closed";'));
    expect(offer.length).toBeGreaterThan(100);
    expect(offer, "an invitation field is assignable again").not.toMatch(/^\s*invitation:/m);
  });

  it("the projection type is gone with it", () => {
    // Leaving an unused shape invites a caller to reuse something that never
    // enforced anything.
    expect(STATE, "SafeInvitationRef survives as a reusable non-boundary").not.toContain(
      "SafeInvitationRef",
    );
  });

  it("the screen reads no authority field", () => {
    for (const forbidden of ["recipientContactHash", "entryId", "studioId", "invitation"]) {
      expect(SCREEN, `screen reads ${forbidden}`).not.toContain(`state.${forbidden}`);
    }
  });
});

describe("offer emptiness is structural, not a flag beside the collection", () => {
  it("the offer state carries no `empty` and no second slot list", () => {
    const offer = STATE.slice(STATE.indexOf('kind: "offer";'), STATE.indexOf('kind: "closed";'));
    expect(offer.length).toBeGreaterThan(100);
    expect(offer, "a contradictable flag survives").not.toMatch(/^\s*empty: boolean;/m);
    expect(offer, "a second collection survives").not.toMatch(/^\s*slots: readonly OfferedSlot\[\];/m);
    expect(offer).toContain("days: readonly OfferedDay[];");
  });

  it("the view derives emptiness from what it renders", () => {
    expect(SCREEN).toContain("const empty = days.length === 0;");
  });

  it("a day with no slots is UNREPRESENTABLE, so days.length is trustworthy", () => {
    // Collapsing the old `empty` flag into `days.length` only relocated the
    // contradiction: `days: [{ slots: [] }]` typechecked and rendered "Choose a
    // time" with nothing under it and no retry path.
    expect(STATE).toContain("export type NonEmptySlots = readonly [OfferedSlot, ...OfferedSlot[]]");
    const day = STATE.slice(STATE.indexOf("export type OfferedDay"), STATE.indexOf("};", STATE.indexOf("export type OfferedDay")));
    expect(day.length).toBeGreaterThan(40);
    expect(day).toContain("slots: NonEmptySlots;");
    expect(day, "a day can still be empty").not.toContain("slots: readonly OfferedSlot[]");
  });
});

describe("the recipient learns nothing about anyone else", () => {
  it("no queue, position or other-prospect vocabulary in the source", () => {
    for (const forbidden of [
      "queuePosition",
      "position_in_queue",
      "aheadOfYou",
      "otherProspects",
      "waitlistCount",
      "entryCount",
    ]) {
      expect(SCREEN, `leaked: ${forbidden}`).not.toContain(forbidden);
      expect(STATE, `leaked: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("a bad token and a malformed offer are indistinguishable to the recipient", () => {
    // Telling them apart would confirm to a bearer that a token exists.
    const slice = STATE.slice(STATE.indexOf('case "invalid_token"'));
    expect(slice).toContain('case "unscoped"');
    const between = slice.slice(0, slice.indexOf("return"));
    expect(between, "the two verdicts diverge before returning").not.toContain("if");
  });
});

describe("the offered window is narrowed on the way to the screen", () => {
  it("the view state filters slots rather than trusting them", () => {
    expect(STATE).toContain("filterSlotsToScope(scope, ctx.presentation.studioTimezone, ctx.slots)");
  });

  it("an unreadable instant fails closed rather than being admitted", () => {
    const fn = STATE.slice(
      STATE.indexOf("export function slotWithinScope"),
      STATE.indexOf("export function filterSlotsToScope"),
    );
    expect(fn.length).toBeGreaterThan(100);
    expect(fn).toContain("Number.isNaN(startsAt.getTime())");
    expect(fn).toContain("return false;");
  });
});


// ===========================================================================
// 0185's REVOKE IS NOT ROUTED AROUND
// ===========================================================================
//
// 0185 revoked EVERY table privilege on new_client_waitlist_entries from
// service_role by name, so the server's most privileged client cannot dump
// contact details. This surface used to read that table anyway; the read
// returned 42501 and the recipient booking stopped before the engine, silently,
// on every environment. The identity now comes from 0192's capability-gated
// command instead.
//
// These are SOURCE assertions because the failure they guard is a shape: a
// reintroduced table read would be caught by no render assertion, and in
// production it fails as a null rather than as an error.
describe("recipient identity crosses 0185's revoke by command, not by table read", () => {
  it("performs NO direct read of the waitlist entries table", () => {
    // Comments explain this history and name the table; `codeOnly` strips them,
    // so a comment can never satisfy — or break — this check.
    expect(
      ACTIONS,
      "the recipient surface must not read new_client_waitlist_entries directly",
    ).not.toContain("new_client_waitlist_entries");
  });

  it("reads identity through the 0192 command", () => {
    expect(ACTIONS).toContain("resolve_waitlist_invitation_recipient_identity");
  });

  it("presents BOTH secrets — a token-only call would be a bearer path to identity", () => {
    expect(ACTIONS).toContain("p_raw_token");
    expect(ACTIONS).toContain("p_raw_capability");
  });

  it("asks for no table privilege anywhere on the recipient surface", () => {
    // The forbidden repair. Granting service_role SELECT would reverse an
    // explicit privacy decision and make the command above decorative.
    expect(ACTIONS).not.toMatch(/grant\s+(select|all)/i);
  });

  it("NON-VACUITY — the pin can tell the command apart from the table read", () => {
    // Both strings are checked against the same extracted source, so a guard
    // that silently read an empty file would fail here.
    expect(ACTIONS.length).toBeGreaterThan(1000);
    expect(ACTIONS).toContain("invitedIdentity");
  });
});
