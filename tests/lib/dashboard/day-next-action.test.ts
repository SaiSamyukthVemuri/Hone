import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDayNextAction } from "@/lib/dashboard/day-next-action";
import { resolveNextAction } from "@/lib/dashboard/next-action";

// V1 does not ask the history question off Today. This proves the wrapper
// never invents an answer, and never disturbs the branches that do not need
// one.

const base = {
  clientId: "c1",
  appointmentId: "a1",
  sessionId: null as string | null,
  hasChartedArea: false,
};

describe("TODAY — delegates verbatim, so today's action is unchanged", () => {
  it("every input produces exactly what resolveNextAction produces", () => {
    for (const status of ["confirmed", "completed", "cancelled", "no_show"]) {
      for (const hasHistory of [true, false]) {
        for (const sessionId of [null, "s1"]) {
          for (const hasChartedArea of [true, false]) {
            const input = { ...base, status, sessionId, hasChartedArea };
            expect(
              resolveDayNextAction({ ...input, history: { asked: true, hasHistory } }),
              `${status}/${hasHistory}/${sessionId}/${hasChartedArea}`,
            ).toEqual(resolveNextAction({ ...input, hasHistory }));
          }
        }
      }
    }
  });
});

describe("NOT ASKED — the neutral action, never a fabricated absence", () => {
  it("an upcoming uncharted row gets the neutral 'Open client'", () => {
    expect(
      resolveDayNextAction({ ...base, status: "confirmed", history: { asked: false } }),
    ).toEqual({ label: "Open client", href: "/clients/c1", chip: null });
  });

  it("it NEVER claims the returning-client affordance it did not establish", () => {
    for (const status of ["confirmed", "completed", "cancelled", "no_show"]) {
      const out = resolveDayNextAction({ ...base, status, history: { asked: false } });
      expect(out.label, status).not.toBe("Review Before Today");
    }
  });

  it("the branches decided BEFORE history are untouched", () => {
    // These never read `hasHistory` in the resolver, so an unasked question
    // cannot change them.
    expect(
      resolveDayNextAction({ ...base, status: "confirmed", sessionId: "s1", hasChartedArea: true, history: { asked: false } }),
    ).toEqual({ label: "View session", href: "/clients/c1/sessions/s1", chip: "Charted" });
    expect(
      resolveDayNextAction({ ...base, status: "confirmed", sessionId: "s1", history: { asked: false } }),
    ).toEqual({ label: "Continue charting", href: "/clients/c1/sessions/s1", chip: null });
    expect(
      resolveDayNextAction({ ...base, status: "completed", history: { asked: false } }),
    ).toEqual({
      label: "Chart appointment",
      href: "/clients/c1/sessions/new?appointment_id=a1",
      chip: "Charting needed",
    });
    expect(
      resolveDayNextAction({ ...base, status: "cancelled", history: { asked: false } }),
    ).toEqual({ label: "Open client", href: "/clients/c1", chip: null });
  });

  it("those branches match the resolver EXACTLY, whatever history would have said", () => {
    // The guard is the point: where history cannot reach the outcome, the
    // wrapper must be indistinguishable from the resolver under BOTH answers.
    for (const status of ["completed", "cancelled", "no_show"]) {
      const input = { ...base, status };
      const unasked = resolveDayNextAction({ ...input, history: { asked: false } });
      expect(unasked).toEqual(resolveNextAction({ ...input, hasHistory: true }));
      expect(unasked).toEqual(resolveNextAction({ ...input, hasHistory: false }));
    }
  });

  it("a returning and a brand-new client are treated IDENTICALLY off Today", () => {
    // V1 asks nothing, so it must say nothing — the two must be
    // indistinguishable, which is what makes the silence honest.
    const a = resolveDayNextAction({ ...base, status: "confirmed", history: { asked: false } });
    const b = resolveDayNextAction({ ...base, status: "confirmed", history: { asked: false } });
    expect(a).toEqual(b);
    expect(a.chip).toBeNull();
  });

  it("no unasked row produces an alarming or diagnostic label", () => {
    for (const status of ["confirmed", "completed", "cancelled", "no_show"]) {
      const out = resolveDayNextAction({ ...base, status, history: { asked: false } });
      expect(out.label).not.toMatch(/unavailable|error|unknown|new client/i);
    }
  });
});

describe("the type makes an unasked answer unspellable", () => {
  it("{ asked: false } carries no hasHistory field", () => {
    const h = { asked: false } as const;
    expect(Object.keys(h)).toEqual(["asked"]);
  });
});

describe("the neutral answer is RETURNED, not delegated with a fabricated false", () => {
  // A behavioural test cannot see this. Delegating the undecided branch with
  // `hasHistory: false` produces the identical object TODAY, because the
  // resolver's last line is the same neutral action — so a mutation to that
  // form survives every assertion above.
  //
  // It is still wrong. The moment `resolveNextAction` grows another branch
  // that reads `hasHistory` — the flag exists precisely so it can — the
  // delegated form starts answering a question this wrapper never asked,
  // silently, with no test failing. So the structure is pinned directly.
  const SRC = readFileSync(
    join(process.cwd(), "lib/dashboard/day-next-action.ts"),
    "utf8",
  );
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the undecided path builds the action itself", () => {
    const tail = CODE.slice(CODE.indexOf("decidedWithoutHistory(rest)"));
    expect(tail).toMatch(
      /return \{ label: "Open client", href: `\/clients\/\$\{rest\.clientId\}`, chip: null \};/,
    );
  });

  it("hasHistory: false is passed EXACTLY once, and only behind the guard", () => {
    const fabricated = [...CODE.matchAll(/hasHistory: false/g)];
    expect(fabricated).toHaveLength(1);
    // …and that one sits inside the branch that has already proven the value
    // cannot be read.
    const guard = CODE.indexOf("if (decidedWithoutHistory(rest))");
    expect(guard).toBeGreaterThan(-1);
    expect(fabricated[0].index!).toBeGreaterThan(guard);
  });

  it("the guard names every branch the resolver decides before history", () => {
    // If the resolver gains a pre-history branch and this list is not updated,
    // the wrapper degrades to the neutral action rather than to a wrong claim —
    // safe by construction. This pins the current set so the drift is visible.
    const NEXT = readFileSync(join(process.cwd(), "lib/dashboard/next-action.ts"), "utf8");
    const beforeHistory = NEXT.slice(0, NEXT.indexOf("if (input.hasHistory)"));
    for (const cond of ["input.sessionId", '"completed"', '"cancelled"', '"no_show"']) {
      expect(beforeHistory, cond).toContain(cond);
      expect(CODE, cond).toContain(cond.replace("input.", ""));
    }
  });
});
