import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Wiring guards for the client-page outside-hours booking parity (PR: booking
// parity). The security behaviour is proven in
// book-outside-hours-owner-gate.test.ts; these pin the UI + isolation contract.

const root = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const BOOK = read("app/(app)/clients/[id]/BookAppointment.tsx");
const ACTIONS = read("app/(app)/calendar/actions.ts");

describe("client-page override reuses the shared action + is owner-only in the UI", () => {
  it("uses the SAME server action as the calendar (no second implementation)", () => {
    expect(BOOK).toMatch(/import \{ bookAppointmentForClientAction \} from "\.\.\/\.\.\/calendar\/actions"/);
    expect(BOOK).toMatch(/allow_outside_availability/);
  });

  it("the OUTSIDE-HOURS acknowledgement is gated on isOwner, and the flag with it", () => {
    // The owner gate moved from "may you type a time at all?" to "may you book
    // a time that is genuinely outside your hours?".
    //
    // Choosing a manual time INSIDE working hours is an ordinary booking and is
    // available to every active practitioner: gating it on isOwner meant a
    // member could not book 15:30 at all, and the calendar drawer never gated it
    // client-side either, so the two internal surfaces ran different laws.
    expect(BOOK).toMatch(/isOwner/);
    // The acknowledgement checkbox renders only for an owner.
    expect(BOOK).toMatch(/\{isOwner \? \(/);
    // Save requires the owner acknowledgement ONLY when the override is needed.
    expect(BOOK).toMatch(
      /\(!requiresOutsideOverride \|\| \(isOwner && outsideHoursConfirmed\)\)/,
    );
  });

  it("posts allow_outside_availability ONLY for an acknowledged reason", () => {
    // ONE posting site, guarded by ONE derived condition. The condition now has
    // two arms because the DB flag bypasses two different soft rules: working
    // hours, and the 0152 buffer. Both arms require an explicit acknowledgement
    // — neither can fire on its own — so the flag still never rides along with
    // an ordinary booking.
    expect(BOOK).toMatch(
      /const postsOutsideAvailability =\s*\n?\s*requiresOutsideOverride \|\| \(bufferOverrideOffered && bufferOverrideConfirmed\);/,
    );
    expect(BOOK).toMatch(
      /if \(postsOutsideAvailability\) \{\s*\n\s*fd\.set\("allow_outside_availability", "true"\);/,
    );
    expect(
      BOOK.match(/fd\.set\("allow_outside_availability", "true"\)/g)?.length,
    ).toBe(1);
    // The buffer arm is owner-gated in the UI and never pre-ticked.
    expect(BOOK).toMatch(/setBufferOverrideConfirmed\(false\)/);
    // The verdict comes from the SHARED decision function against the
    // server-resolved window, not from a second client-side notion of "inside
    // hours". Both internal surfaces call the same one, which is what stops
    // them drifting into different laws the way they had.
    expect(BOOK).toMatch(/decideManualTime\(\{/);
    expect(BOOK).toMatch(/manualDecision\.requiresOutsideOverride/);
    const DRAWER = read("app/(app)/calendar/QuickBookDrawer.tsx");
    expect(DRAWER).toMatch(/decideManualTime\(\{/);
  });

  it("converts the local manual time to a UTC instant with the shared tz helper", () => {
    expect(BOOK).toMatch(/utcInstantFromLocal\(date, manualTime, timezone\)/);
  });
});

describe("server gate is the simple binding policy (owner-only bypass, no client trust)", () => {
  it("gates purely on the flag + server-resolved owner role (no duration/source scoping)", () => {
    expect(ACTIONS).toMatch(
      /if \(allowOutsideAvailability && practitioner\.role !== "owner"\)/,
    );
    expect(ACTIONS).toMatch(/Only the studio owner can book outside/);
    // The old, exploitable duration-scoped gate must be gone.
    expect(ACTIONS).not.toMatch(/durationOverride == null &&\s*\n?\s*practitioner\.role !== "owner"/);
  });

  it("keeps the pre-existing scheduling guards intact (past-time, studio scope, overlap constraint)", () => {
    // Past-time guard.
    expect(ACTIONS).toMatch(/in the past/i);
    // Working-hours authority. This replaced the suggestion-membership check and
    // is the ONLY hours enforcement a capacity-OFF studio has, because migration
    // 0152 fences validate_appointment_availability's whole hours block behind
    // `if v_cap then`. Removing it would let the manual path book 03:00.
    expect(ACTIONS).toMatch(/classifyRequestedTime\(/);
    expect(ACTIONS).toMatch(/verdict === "outside_availability"/);
    expect(ACTIONS).toMatch(/verdict === "practitioner_closed"/);
    // Studio-scoped service + client lookups (tenant isolation).
    expect(ACTIONS).toMatch(/\.from\("services"\)[\s\S]{0,200}\.eq\("studio_id", studio\.id\)/);
    expect(ACTIONS).toMatch(/\.from\("clients"\)[\s\S]{0,200}\.eq\("studio_id", studio\.id\)/);
    // DB exclusion-constraint (overlap/buffer/blockout) surfaced by sqlstate.
    expect(ACTIONS).toMatch(/23P01|exclusion/i);
  });
});

// ---------------------------------------------------------------------------
// AN UNKNOWN WINDOW IS NOT AN OUTSIDE-HOURS TIME.
//
// decideManualTime fails closed on an unloaded window by returning
// requiresOutsideOverride = true. That is the right answer to "may this be
// treated as an ordinary booking?" and the WRONG answer to "is this time
// outside availability?" — and the surfaces render copy and post
// allow_outside_availability off the second question.
//
// Left conflated, an owner who types a time while the window is unknown (an
// in-flight refetch after changing date or practitioner, or a failed slot load)
// is shown "outside your normal availability", acknowledges it, and books. The
// server honours the flag — the override branch skips the working-hours check
// by design — so a time squarely inside working hours is written with
// booked_outside_availability = true, an outside_availability audit entry, an
// authorising owner, and the buffer trigger disabled for that row forever.
// That is this ticket's defect re-entering through the one state where nothing
// is known.
//
// vitest env is "node" (no DOM), so the wiring is pinned here; the decision
// itself is proved behaviourally in tests/lib/booking/availability-window.test.ts.
// ---------------------------------------------------------------------------
describe("an unknown availability window blocks the manual path on BOTH surfaces", () => {
  const SURFACES: [string, string][] = [
    ["client-profile Book form", "app/(app)/clients/[id]/BookAppointment.tsx"],
    ["calendar Quick Book drawer", "app/(app)/calendar/QuickBookDrawer.tsx"],
  ];

  for (const [label, rel] of SURFACES) {
    describe(label, () => {
      const SRC = read(rel);

      it("reads windowKnown from the SHARED decision, not a local null check", () => {
        // A local `availabilityWindow === null` in each component is two copies
        // of one rule, which is precisely how these surfaces drifted before.
        expect(SRC).toMatch(/const windowKnown = manualDecision\.windowKnown;/);
      });

      it("submit is DISABLED while the window is unknown", () => {
        expect(SRC).toMatch(/windowKnown &&/);
      });

      it("the submit handler refuses outright, not just via the disabled button", () => {
        // The button is a hint; this is the gate. Without it a stale render or
        // a programmatic call could still post the flag.
        expect(SRC).toMatch(/if \(!windowKnown\) return;/);
      });

      it("the outside-hours warning and acknowledgement do NOT render for an unknown window", () => {
        // The amber block must sit behind a windowKnown test, so an unknown
        // window can never borrow out-of-hours copy.
        expect(SRC).toMatch(
          /\{!windowKnown \? \([\s\S]*?\) : !manualTimeValid \? null : requiresOutsideOverride \? \(/,
        );
        expect(SRC).toMatch(/Checking your working hours/);
      });

      it("nor for an EMPTY time field", () => {
        // decideManualTime fails closed on an unparseable time too, so the same
        // conflation showed the amber -- and, for an owner, an acknowledgement
        // checkbox -- about a field that had not been filled in. Nothing may be
        // asserted until there is a parseable time to assert about.
        expect(SRC).toMatch(/: !manualTimeValid \? null :/);
        // ...and the calm "inside your working hours" line must be on the plain
        // else branch, not re-guarded, so the three states stay exhaustive and
        // mutually exclusive rather than overlapping.
        expect(SRC).not.toMatch(/\) : \(\s*\n\s*manualTimeValid && \(/);
      });

      it("a stale window is dropped BEFORE the refetch, never held across it", () => {
        // The window belongs to one (target, date). Holding the previous one
        // while a new one is in flight is what makes the stale-state race
        // reachable at all.
        expect(SRC).toMatch(/setAvailabilityWindow\(null\)/);
      });
    });
  }

  it("neither surface can post the flag without a known window", () => {
    // Belt and braces across both files at once: every posting site is inside
    // the requiresOutsideOverride branch, and every handler that reaches one
    // has already returned on an unknown window.
    for (const [, rel] of SURFACES) {
      const SRC = read(rel);
      const posts = SRC.match(
        /fd\.set\("allow_outside_availability", "true"\)/g,
      );
      expect(posts?.length).toBe(1);
      expect(SRC.indexOf("if (!windowKnown) return;")).toBeLessThan(
        SRC.indexOf('fd.set("allow_outside_availability", "true")'),
      );
    }
  });
});

describe("public booking cannot pass the override", () => {
  it("the public booking action does not read allow_outside_availability", () => {
    // Public booking lives in a separate file that must never honour the flag.
    const publicAction = read("app/book/[slug]/actions.ts");
    expect(publicAction).not.toMatch(/allow_outside_availability/);
  });
});

// ---------------------------------------------------------------------------
// P2-3 / P2-4 / P2-5 — the three findings whose fix lives in component wiring.
//
// vitest env is "node" (no DOM), so these are SOURCE PINS, not behavioural
// tests, and they are labelled as such. The behavioural halves live where they
// can actually run: the decision semantics in
// tests/lib/booking/availability-window.test.ts, and the slot-A/slot-B buffer
// leak in e2e/buffer-override-candidate-scope.spec.ts.
// ---------------------------------------------------------------------------

describe("P2-3 — a date change invalidates in-flight practitioner lookups", () => {
  it("handleDate routes through loadForService, which bumps the generation", () => {
    // Going straight to loadSlots left `eligibleReq` untouched, so an
    // eligible-practitioner lookup started for the PREVIOUS date could resolve
    // afterwards, call loadSlots with its captured old date, win the slotReq
    // race and install the wrong day's window while the form submitted the new
    // date. Routing through loadForService makes the superseded lookup return
    // early at its own guard.
    expect(BOOK).toMatch(
      /function handleDate\(v: string\) \{[\s\S]*?loadForService\(serviceId, v\);/,
    );
    expect(BOOK).not.toMatch(
      /function handleDate\(v: string\) \{[\s\S]*?loadSlots\(serviceId, v, target\);/,
    );
  });

  it("the generation guard it depends on is still present", () => {
    // The fix is only as good as the guard it leans on. The eligible-side guard
    // moved INTO resolveEligibleSelection (which checks it after the await, and
    // is behaviourally tested there); the slot-side guard is still inline.
    expect(BOOK).toMatch(/const req = \+\+eligibleReq\.current;/);
    expect(BOOK).toMatch(/generation: req,/);
    // The eligible guard now checks the generation AND that the list still
    // answers for the current service/capacity mode.
    expect(BOOK).toMatch(/g === eligibleReq\.current &&/);
    expect(BOOK).toMatch(/eligibleFetchIdentity\(eligibleRequest\) ===/);
    expect(BOOK).toMatch(/eligibleFetchIdentity\(liveEligibleRequest\(\)\)/);
    // The slot-side guard is fetchForIdentity: generation AND a DERIVED
    // identity, compared after the await. A counter alone cannot see a response
    // whose inputs simply moved on underneath it.
    expect(BOOK).toMatch(/isCurrentGeneration: \(g\) => g === slotReq\.current/);
    expect(BOOK).toMatch(/readCurrentRequest: liveSlotRequest/);
  });
});

describe("P2-4 — a buffer approval is scoped to ONE booking candidate", () => {
  const SURFACES: [string, string][] = [
    ["client-profile Book form", "app/(app)/clients/[id]/BookAppointment.tsx"],
    ["calendar Quick Book drawer", "app/(app)/calendar/QuickBookDrawer.tsx"],
  ];

  for (const [label, rel] of SURFACES) {
    describe(label, () => {
      const SRC = read(rel);

      it("stores the candidate the offer was issued FOR, not a bare boolean", () => {
        // A boolean is a standing permission; an identity is not. This is the
        // structural difference that makes "approve slot A, then pick slot B"
        // safe without every mutation site remembering to clear.
        expect(SRC).toMatch(/const \[bufferOverrideFor, setBufferOverrideFor\]/);
        expect(SRC).not.toMatch(/setBufferOverrideOffered\(true\)/);
      });

      it("the offer is DERIVED by comparing against the current candidate", () => {
        expect(SRC).toMatch(
          /const bufferOverrideOffered =\s*\n?\s*bufferOverrideFor !== null && bufferOverrideFor === candidateKey;/,
        );
      });

      it("the candidate identity covers client + service + practitioner + instant", () => {
        expect(SRC).toMatch(/const candidateKey = bookingCandidateKey\(\{/);
        expect(SRC).toMatch(/clientId:/);
        expect(SRC).toMatch(/serviceId:/);
        expect(SRC).toMatch(/practitionerId:/);
        expect(SRC).toMatch(/startsAtIso: candidateStartsAt/);
      });

      it("the refusal scopes the offer to the candidate that was refused", () => {
        // Scoped to the SERVER-refused candidate: the client page rebuilds the
        // key with the duration the refusal reported; the drawer's key already
        // prefers that duration, so passing candidateKey is equivalent there.
        expect(SRC).toMatch(
          /setBufferOverrideFor\(\s*\n?\s*(candidateKey|bookingCandidateKey\(\{)/,
        );
        expect(SRC).toMatch(/setBufferOverrideDuration\(/);
      });

      it("picking a different suggestion also actively clears the acknowledgement", () => {
        expect(SRC).toMatch(
          /setPickedSlot\(slot\);[\s\S]{0,200}clearBufferOverride\(\)/,
        );
      });
    });
  }

  it("the drawer's candidate also covers the (normalised) drag length", () => {
    const DRAWER2 = read("app/(app)/calendar/QuickBookDrawer.tsx");
    expect(DRAWER2).toMatch(/effectiveDurationOverride \?\?\s*\n?\s*selectedService\?\.default_duration_minutes/);
  });
});

describe("P2-5 — override copy states the FACTUAL reason", () => {
  const SURFACES: [string, string][] = [
    ["client-profile Book form", "app/(app)/clients/[id]/BookAppointment.tsx"],
    ["calendar Quick Book drawer", "app/(app)/calendar/QuickBookDrawer.tsx"],
  ];

  for (const [label, rel] of SURFACES) {
    it(`${label}: renders from overrideReason, and has a custom-duration branch`, () => {
      const SRC = read(rel);
      // Copy must follow the factual reason, never `requiresOutsideOverride`,
      // which is true for a custom length on a perfectly ordinary in-hours time.
      expect(SRC).toMatch(/const manualOverrideReason = manualDecision\.overrideReason;/);
      expect(SRC).toMatch(/manualOverrideReason === "custom_duration"/);
      expect(SRC).toMatch(/custom appointment length needs an exception/i);
      // The acknowledgement wording must not force a false statement either.
      expect(SRC).toMatch(/I confirm this custom length needs an exception/);
      // And the old verdict-driven copy must not linger.
      expect(SRC).not.toMatch(/manualVerdict === "practitioner_closed"/);
    });
  }
});

// ---------------------------------------------------------------------------
// SECOND-ROUND P2s — surface wiring. The semantics are proved behaviourally in
// tests/lib/booking/availability-window.test.ts and
// tests/lib/booking/eligible-selection.test.ts; these pin that the surfaces
// actually route through those, rather than re-deriving the rules locally.
// ---------------------------------------------------------------------------

describe("P2-A/C — both surfaces use the SHARED candidate identity", () => {
  const SURFACES: [string, string][] = [
    ["client-profile Book form", "app/(app)/clients/[id]/BookAppointment.tsx"],
    ["calendar Quick Book drawer", "app/(app)/calendar/QuickBookDrawer.tsx"],
  ];

  for (const [label, rel] of SURFACES) {
    it(`${label}: builds the key via bookingCandidateKey, with a client`, () => {
      const SRC = read(rel);
      expect(SRC).toMatch(/bookingCandidateKey\(\{/);
      expect(SRC).toMatch(/clientId:/);
      // The hand-rolled template-literal key must be gone from both surfaces:
      // two local spellings of "the same appointment" is how the client came to
      // be missing from one of them.
      expect(SRC).not.toMatch(/`\$\{serviceId\}\|/);
    });
  }

  it("Quick Book passes the SELECTED client, not a constant", () => {
    const DRAWER3 = read("app/(app)/calendar/QuickBookDrawer.tsx");
    expect(DRAWER3).toMatch(/clientId: selectedClient\?\.id \?\? null/);
  });

  it("Quick Book normalises the drag length before deciding AND before posting", () => {
    const DRAWER3 = read("app/(app)/calendar/QuickBookDrawer.tsx");
    expect(DRAWER3).toMatch(
      /const effectiveDurationOverride = normalizeDurationOverride\(/,
    );
    // The decision, the identity and the payload must all read the SAME value.
    expect(DRAWER3).toMatch(/customDurationMinutes: effectiveDurationOverride/);
    expect(DRAWER3).toMatch(/effectiveDurationOverride \?\?\s*\n?\s*selectedService\?\.default_duration_minutes/);
    // ...and it falls back to the SERVICE default, so a standard booking's
    // interval is still part of the buffer identity.
    expect(DRAWER3).toMatch(/selectedService\?\.default_duration_minutes/);
    expect(DRAWER3).toMatch(
      /effectiveDurationOverride != null\) \{\s*\n\s*fd\.set\("duration_minutes_override", String\(effectiveDurationOverride\)\)/,
    );
    // ...and the raw parsed value must no longer reach the payload.
    expect(DRAWER3).not.toMatch(
      /fd\.set\("duration_minutes_override", String\(parsedManualDuration\)\)/,
    );
  });
});

describe("P2-B — the client page resolves eligibility through the ordering helper", () => {
  it("uses resolveEligibleSelection and reads the target through a callback", () => {
    // Capturing `target` at call time is what let a date refresh revert a later
    // explicit choice. The callback is read after the await.
    expect(BOOK).toMatch(/resolveEligibleSelection\(\{/);
    expect(BOOK).toMatch(/readCurrentTarget: \(\) => targetRef\.current/);
    expect(BOOK).toMatch(/g === eligibleReq\.current &&/);
  });

  it("the local default-target helper is gone (one implementation, not two)", () => {
    expect(BOOK).not.toMatch(/function resolveDefaultTarget\(/);
  });

  it("every target write goes through the ref-syncing setter", () => {
    // A bare setTargetState would desynchronise the ref the async resolve reads.
    expect(BOOK).toMatch(/function setTarget\(v: string\) \{\s*\n\s*targetRef\.current = v;/);
    expect(BOOK.match(/setTargetState\(/g)?.length).toBe(1);
  });
});

describe("P2-D — an unreadable window is refused, never described", () => {
  it("the action refuses availability_unknown with a distinct, non-factual message", () => {
    expect(ACTIONS).toMatch(/verdict === "availability_unknown"/);
    expect(ACTIONS).toMatch(/could not check your working hours/i);
    // It must not be reported as a fact about the practitioner's day.
    const unknownBranch = ACTIONS.slice(
      ACTIONS.indexOf('verdict === "availability_unknown"'),
      ACTIONS.indexOf('verdict === "practitioner_closed"'),
    );
    expect(unknownBranch).not.toMatch(/isn't working/i);
    expect(unknownBranch).not.toMatch(/outside the practitioner/i);
  });
});

// ---------------------------------------------------------------------------
// THIRD-ROUND P2s — surface wiring. Semantics proved behaviourally in
// tests/lib/booking/availability-window.test.ts; these pin that the component
// routes through them and invalidates SYNCHRONOUSLY.
// ---------------------------------------------------------------------------

describe("LAW 1 / P2-A — identity changes invalidate the selection before any await", () => {
  it("there is ONE synchronous invalidation, and loadForService calls it", () => {
    // loadForService previously cleared only the window, so a slot picked on
    // the previous date stayed selected for the whole eligibility round trip.
    expect(BOOK).toMatch(/function invalidateSelection\(\) \{[\s\S]{0,220}setPickedSlot\(null\);/);
    expect(BOOK).toMatch(/function invalidateSelection\(\) \{[\s\S]{0,220}setAvailabilityWindow\(null\);/);
    expect(BOOK).toMatch(/function invalidateSelection\(\) \{[\s\S]{0,220}clearBufferOverride\(\);/);
    // Called BEFORE the transition that awaits.
    const call = BOOK.indexOf("invalidateSelection();");
    const await_ = BOOK.indexOf("startLoadingPractitioners(async () => {");
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(await_);
  });

  it("Confirm binds a suggestion to the CURRENT form date", () => {
    // The bare `!!pickedSlot` could not tell a stale instant from a current one.
    expect(BOOK).toMatch(/selectedSlotMatchesDate\(\{/);
    expect(BOOK).toMatch(/formDate: date,/);
    expect(BOOK).not.toMatch(/: !!pickedSlot\);/);
  });
});

describe("LAW 2 / P2-B — the browser surface keeps a failed blockout read unknown", () => {
  it("readFailed maps to unknown, blocked maps to closed, and they are distinct", () => {
    const ACTIONS2 = read("app/(app)/clients/[id]/booking-actions.ts");
    expect(ACTIONS2).toMatch(
      /blockout\.readFailed\s*\n?\s*\? \{ kind: "unknown" \}\s*\n?\s*: blockout\.blocked\s*\n?\s*\? \{ kind: "closed" \}/,
    );
    // The collapsed form must not come back.
    expect(ACTIONS2).not.toMatch(/blockout\.blocked \|\| blockout\.readFailed/);
  });
});

describe("LAW 2 / P2-C — the capacity-OFF branch cannot throw past the contract", () => {
  it("the safe loaders are translated at the resolver boundary", () => {
    const AW = read("lib/booking/availability-window.ts");
    expect(AW).toMatch(/try \{[\s\S]{0,400}getStudioWideOverrideDaySafe/);
    expect(AW).toMatch(/\} catch \(e\) \{[\s\S]{0,400}return \{ kind: "unknown" \};/);
    // Bounded, PHI-free marker so a genuine bug is still visible.
    expect(AW).toMatch(/availability_window_read_failed:/);
  });
});

// ---------------------------------------------------------------------------
// SLOT/WINDOW COHERENCE — the surface-side half.
//
// The server now reconciles the response (no slots for an unknown or closed
// window; open-window slots re-validated against that window). These pin that
// neither surface can submit a suggestion against a window it does not know,
// so a contradictory payload from any future caller still cannot be booked.
// The behavioural proof of the server invariant is in
// tests/app/clients/slot-window-coherence.test.ts.
// ---------------------------------------------------------------------------

describe("no suggestion may be submitted against an unknown window", () => {
  it("the client page gates its suggestion branch on windowKnown", () => {
    expect(BOOK).toMatch(/windowKnown &&\s*\n\s*selectedSlotMatchesDate\(\{/);
  });

  it("the drawer gates its suggestion branch on windowKnown", () => {
    const DRAWER4 = read("app/(app)/calendar/QuickBookDrawer.tsx");
    expect(DRAWER4).toMatch(/\(windowKnown && !!pickedSlot\)/);
    // The bare form must not come back.
    expect(DRAWER4).not.toMatch(/: !!pickedSlot\s*\n\s*\);/);
  });

  it("the fetch action reconciles slots against the companion window", () => {
    const ACTIONS3 = read("app/(app)/clients/[id]/booking-actions.ts");
    expect(ACTIONS3).toMatch(/const coherentSlots =/);
    expect(ACTIONS3).toMatch(/window\.kind === "open"/);
    // Judged by the SHARED classifier -- no second hours algorithm.
    expect(ACTIONS3).toMatch(/classifyAgainstWindow\(/);
    expect(ACTIONS3).toMatch(/=== "inside_availability"/);
    expect(ACTIONS3).toMatch(/return \{ ok: true, slots: coherentSlots, window \};/);
    // The unreconciled return must be gone.
    expect(ACTIONS3).not.toMatch(/return \{ ok: true, slots, window \};/);
  });
});

// ---------------------------------------------------------------------------
// ASYNC-STATE LAW — a slot/window result may commit only to the exact current
// booking candidate identity it was requested for.
//
// Three consecutive repairs of this component each relied on a generation
// counter and each left one more piece of state stale. The counter remains as
// cancellation machinery; the IDENTITY is the semantic authority. Behavioural
// proof (deferred-promise interleavings) lives in
// tests/lib/booking/slot-request.test.ts.
// ---------------------------------------------------------------------------

describe("slot/window results commit only to the current candidate", () => {
  it("invalidateSelection bumps the slot generation synchronously", () => {
    // Clearing stored state was not enough: an in-flight loadSlots kept a
    // generation that was still "current", passed its own guard, and
    // reinstalled the previous candidate's window.
    expect(BOOK).toMatch(
      /function invalidateSelection\(\) \{\s*\n\s*slotReq\.current \+= 1;/,
    );
    // ...and it clears every piece of prior-candidate state with it.
    const block = BOOK.slice(
      BOOK.indexOf("function invalidateSelection()"),
      BOOK.indexOf("function invalidateSelection()") + 400,
    );
    for (const cleared of [
      "setPickedSlot(null)",
      "setSlots([])",
      "setAvailabilityWindow(null)",
      "setWindowFor(null)",
      "clearBufferOverride()",
    ]) {
      expect(block).toContain(cleared);
    }
  });

  it("loadSlots invalidates synchronously BEFORE issuing the request", () => {
    const inval = BOOK.indexOf("invalidateSelection();");
    const issue = BOOK.indexOf("const request: SlotCandidateIdentity");
    expect(inval).toBeGreaterThan(-1);
    expect(inval).toBeLessThan(issue);
  });

  it("the result is committed through the identity-checked helper", () => {
    expect(BOOK).toMatch(/fetchForIdentity<SlotCandidateIdentity, SlotResult>\(\{/);
    expect(BOOK).toMatch(/identityOf: slotCandidateIdentity/);
    expect(BOOK).toMatch(/isCurrentGeneration: \(g\) => g === slotReq\.current/);
    expect(BOOK).toMatch(/readCurrentRequest: liveSlotRequest/);
    expect(BOOK).toMatch(/if \(decision\.kind === "discard"\) return;/);
    // The generation-only guard must not survive alongside it.
    expect(BOOK).not.toMatch(/if \(req !== slotReq\.current\) return;/);
  });

  it("the live request is read from refs, never captured state", () => {
    expect(BOOK).toMatch(/function liveSlotRequest\(\): SlotCandidateIdentity/);
    expect(BOOK).toMatch(/serviceId: serviceRef\.current/);
    expect(BOOK).toMatch(/date: dateRef\.current/);
    expect(BOOK).toMatch(/targetRef\.current/);
    // The ARGUMENT is recorded, not adjacent state -- that divergence is what
    // let a capacity flip leave a stale window looking current.
    expect(BOOK).toMatch(/capacityMode: practitionerCapacityEnabled/);
  });

  it("the manual verdict uses the window ONLY if it describes this candidate", () => {
    // A window resolved for another candidate is handed over as null, which the
    // shared decision already treats as "not loaded" -- so loading can never
    // present itself as "outside hours".
    expect(BOOK).toMatch(/windowFor === slotCandidateIdentity\(liveSlotRequest\(\)\)/);
    expect(BOOK).toMatch(/window: windowIsCurrent \? availabilityWindow : null,/);
    // The window is stamped with the identity of the request it came from.
    expect(BOOK).toMatch(/setWindowFor\(slotCandidateIdentity\(request\)\);/);
  });
});

// ---------------------------------------------------------------------------
// IDENTITY COMPLETENESS + LIVENESS + SERVER-AUTHORITATIVE BUFFER DURATION.
// Semantics proved in tests/lib/booking/slot-request.test.ts and
// tests/app/calendar/manual-time-inside-availability.test.ts.
// ---------------------------------------------------------------------------

describe("the semantic identity carries capacity mode AND timezone", () => {
  const SURFACES: [string, string][] = [
    ["client-profile Book form", "app/(app)/clients/[id]/BookAppointment.tsx"],
    ["calendar Quick Book drawer", "app/(app)/calendar/QuickBookDrawer.tsx"],
  ];
  for (const [label, rel] of SURFACES) {
    it(`${label}: both prop-borne dimensions are in the identity`, () => {
      const SRC = read(rel);
      expect(SRC).toMatch(/capacityMode: practitionerCapacityEnabled/);
      expect(SRC).toMatch(/timezone(: studioTimezone)?,/);
    });
  }
});

describe("a changed identity REFETCHES — invalidation without replacement is a bug", () => {
  it("the client page reloads when capacity mode or timezone changes", () => {
    // Neither is owned by a handler; without this the form stayed unusable
    // until the practitioner changed a field or reopened it.
    expect(BOOK).toMatch(/const propIdentityRef = useRef<string \| null>\(null\);/);
    expect(BOOK).toMatch(/\$\{practitionerCapacityEnabled\}\|\$\{timezone\}/);
    expect(BOOK).toMatch(/if \(serviceId && date\) loadForService\(serviceId, date\);/);
    expect(BOOK).toMatch(/\}, \[practitionerCapacityEnabled, timezone, open\]\);/);
  });

  it("the drawer's slot effect depends on both", () => {
    const D = read("app/(app)/calendar/QuickBookDrawer.tsx");
    expect(D).toMatch(/practitionerCapacityEnabled,\s*\n\s*studioTimezone,\s*\n\s*\]\);/);
  });
});

describe("the buffer approval is bound to the SERVER-refused interval", () => {
  const SURFACES: [string, string][] = [
    ["client-profile Book form", "app/(app)/clients/[id]/BookAppointment.tsx"],
    ["calendar Quick Book drawer", "app/(app)/calendar/QuickBookDrawer.tsx"],
  ];
  for (const [label, rel] of SURFACES) {
    it(`${label}: stores the server duration and echoes it as a precondition`, () => {
      const SRC = read(rel);
      expect(SRC).toMatch(/setBufferOverrideDuration\(r\.authoritativeDurationMinutes \?\? null\)/);
      // The key prefers the server's number over the prop snapshot.
      expect(SRC).toMatch(/effectiveDurationMinutes:\s*\n?\s*bufferOverrideDuration \?\?/);
      expect(SRC).toMatch(
        /fd\.set\("expected_duration_minutes", String\(bufferOverrideDuration\)\)/,
      );
      // ...and it is cleared with the rest of the approval.
      expect(SRC).toMatch(/setBufferOverrideDuration\(null\)/);
    });
  }

  it("the server treats the echoed duration as a PRECONDITION, not permission", () => {
    // It can only make the server refuse. Role, service, duration and target
    // authority are all still derived server-side.
    expect(ACTIONS).toMatch(/expected_duration_minutes/);
    expect(ACTIONS).toMatch(/expected !== service\.default_duration_minutes/);
    expect(ACTIONS).toMatch(/code: "stale_candidate"/);
    expect(ACTIONS).toMatch(/service length changed/i);
    // The owner gate is untouched and still unconditional.
    expect(ACTIONS).toMatch(
      /if \(allowOutsideAvailability && practitioner\.role !== "owner"\)/,
    );
  });
});
