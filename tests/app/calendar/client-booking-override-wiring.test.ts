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

  it("posts allow_outside_availability ONLY when the time is genuinely outside hours", () => {
    expect(BOOK).toMatch(
      /if \(requiresOutsideOverride\) \{\s*\n\s*fd\.set\("allow_outside_availability", "true"\);/,
    );
    expect(
      BOOK.match(/fd\.set\("allow_outside_availability", "true"\)/g)?.length,
    ).toBe(1);
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

describe("public booking cannot pass the override", () => {
  it("the public booking action does not read allow_outside_availability", () => {
    // Public booking lives in a separate file that must never honour the flag.
    const publicAction = read("app/book/[slug]/actions.ts");
    expect(publicAction).not.toMatch(/allow_outside_availability/);
  });
});
