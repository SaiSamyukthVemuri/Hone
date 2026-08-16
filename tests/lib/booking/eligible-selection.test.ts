import { describe, expect, it } from "vitest";
import { resolveEligibleSelection } from "@/lib/booking/eligible-selection";

// P2-B — THE ASYNC ORDERING, driven deterministically with deferred promises.
//
// The prior repair for the obsolete-date race routed every date change through
// the eligibility path. That closed the old race and opened a new one: the
// request CAPTURED the target selected at call time, so an explicit
// practitioner choice made while it was in flight was silently reverted when it
// resolved.
//
// A date change may invalidate stale async work. It may NOT revoke a later
// explicit choice. These tests drive both halves of that rule by controlling
// exactly when the fetch completes.

type P = { id: string };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("CASE B1 — a superseded generation can never install anything", () => {
  it("a request whose generation was bumped mid-flight resolves to superseded", async () => {
    const gate = deferred<{ ok: true; practitioners: P[] }>();
    let generation = 1;

    const pending = resolveEligibleSelection<P>({
      generation: 1,
      isCurrent: (g) => g === generation,
      fetchEligible: () => gate.promise,
      readCurrentTarget: () => "A",
      preferredFallback: "OWNER",
    });

    // The date changes while the old request is in flight.
    generation = 2;
    gate.resolve({ ok: true, practitioners: [{ id: "A" }, { id: "B" }] });

    expect((await pending).kind).toBe("superseded");
  });

  it("the staleness check happens AFTER the await, not before", async () => {
    // If it were checked up front, a request superseded mid-flight would still
    // report a selection and overwrite newer state.
    const gate = deferred<{ ok: true; practitioners: P[] }>();
    let generation = 7;
    const pending = resolveEligibleSelection<P>({
      generation: 7,
      isCurrent: (g) => g === generation,
      fetchEligible: () => gate.promise,
      readCurrentTarget: () => "A",
      preferredFallback: "OWNER",
    });
    generation = 8; // superseded only after the call began
    gate.resolve({ ok: true, practitioners: [{ id: "A" }] });
    expect((await pending).kind).toBe("superseded");
  });
});

describe("CASE B2 — a later explicit target survives an in-flight refresh", () => {
  it("the target is read at RESOLVE time, so B is preserved, not reverted to A", async () => {
    const gate = deferred<{ ok: true; practitioners: P[] }>();
    let currentTarget = "A"; // selected when the refresh began

    const pending = resolveEligibleSelection<P>({
      generation: 1,
      isCurrent: () => true, // same generation: this request is NOT stale
      fetchEligible: () => gate.promise,
      readCurrentTarget: () => currentTarget,
      preferredFallback: "OWNER",
    });

    // The owner explicitly picks B while the refresh is still in flight.
    currentTarget = "B";
    gate.resolve({ ok: true, practitioners: [{ id: "A" }, { id: "B" }] });

    const outcome = await pending;
    expect(outcome.kind).toBe("selected");
    expect(outcome.kind === "selected" && outcome.target).toBe("B");
  });

  it("...and A is still chosen when the owner did NOT change anything", async () => {
    // The preservation rule must not become "always take the newest list head".
    const gate = deferred<{ ok: true; practitioners: P[] }>();
    const pending = resolveEligibleSelection<P>({
      generation: 1,
      isCurrent: () => true,
      fetchEligible: () => gate.promise,
      readCurrentTarget: () => "A",
      preferredFallback: "OWNER",
    });
    gate.resolve({ ok: true, practitioners: [{ id: "B" }, { id: "A" }] });
    const outcome = await pending;
    expect(outcome.kind === "selected" && outcome.target).toBe("A");
  });
});

describe("CASE B3 — legitimate fallback still works", () => {
  it("an ineligible current target falls back to the acting practitioner", async () => {
    const outcome = await resolveEligibleSelection<P>({
      generation: 1,
      isCurrent: () => true,
      fetchEligible: async () => ({
        ok: true,
        practitioners: [{ id: "OWNER" }, { id: "B" }],
      }),
      readCurrentTarget: () => "GONE",
      preferredFallback: "OWNER",
    });
    expect(outcome.kind === "selected" && outcome.target).toBe("OWNER");
  });

  it("...then to the first eligible when the acting practitioner is not eligible", async () => {
    const outcome = await resolveEligibleSelection<P>({
      generation: 1,
      isCurrent: () => true,
      fetchEligible: async () => ({ ok: true, practitioners: [{ id: "B" }] }),
      readCurrentTarget: () => "GONE",
      preferredFallback: "OWNER",
    });
    expect(outcome.kind === "selected" && outcome.target).toBe("B");
  });

  it("an empty eligible list is reported distinctly, never as a selection", async () => {
    // The caller must block booking rather than silently fall back to self.
    const outcome = await resolveEligibleSelection<P>({
      generation: 1,
      isCurrent: () => true,
      fetchEligible: async () => ({ ok: true, practitioners: [] }),
      readCurrentTarget: () => "A",
      preferredFallback: "OWNER",
    });
    expect(outcome.kind).toBe("empty");
  });

  it("a failed lookup is reported distinctly, never as an empty list", async () => {
    const outcome = await resolveEligibleSelection<P>({
      generation: 1,
      isCurrent: () => true,
      fetchEligible: async () => ({ ok: false, error: "nope" }),
      readCurrentTarget: () => "A",
      preferredFallback: "OWNER",
    });
    expect(outcome.kind).toBe("failed");
  });
});
