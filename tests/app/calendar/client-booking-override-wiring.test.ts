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
