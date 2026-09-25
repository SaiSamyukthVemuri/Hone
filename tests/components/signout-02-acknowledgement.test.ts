import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// SIGNOUT-02 — the acknowledgement contract, pinned where a browser cannot see.
//
// The BEHAVIOURAL proof is e2e/signout-acknowledgement.spec.ts: a real held
// Server Action, a real second press at a disabled control, real computed
// colours under both motion preferences. This file pins the things that proof
// is structurally bad at — WHICH mechanism was used, and the absences that
// matter (no timer, no onClick, no claimed success), which a passing browser
// run can never demonstrate.
//
// The SIGNOUT-01 form-mount pins live in tests/app/mobile-ux.test.ts and are
// unchanged in substance: they now follow the control into this leaf rather
// than asserting over markup that moved.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// LINE comments before BLOCK comments: a `//` line containing `/*` otherwise
// leaves the block stripper eating to the next `*/`, removing real code and
// making every "does not contain" assertion vacuously true. This file leans
// heavily on absence assertions, so that ordering is load-bearing here.
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const LEAF = "app/(app)/SignOutMenuItem.tsx";
const ACCOUNT = "app/(app)/AccountMenu.tsx";
const MENU = "app/(app)/MobileMenu.tsx";

const leaf = codeOnly(read(LEAF));

describe("SIGNOUT-02 · the stripper is honest", () => {
  it("keeps code and drops prose", () => {
    // Every absence assertion below is vacuous if the stripper over-eats. The
    // leaf's header discusses `onClick`, `setTimeout` and `PendingButton` BY
    // NAME, so this is not a formality: without it, the "no timer" and "no
    // click handler" pins would pass on a file that had all three.
    expect(leaf, "real code survives").toContain("useFormStatus");
    expect(leaf, "real code survives").toContain('type="submit"');
    // These tokens exist ONLY inside comments in that file.
    expect(leaf, "comment prose is gone").not.toContain("SIGNOUT-01");
    expect(leaf, "comment prose is gone").not.toContain("PendingButton");
  });
});

describe("SIGNOUT-02 · the mechanism is the shipped one", () => {
  it("uses useFormStatus, the contract-2b hook, and no second architecture", () => {
    expect(leaf).toContain("useFormStatus");
    expect(leaf).toContain('from "react-dom"');
    // The alternatives, each of which would be a new acknowledgement
    // architecture on the shell rather than a use of the existing one.
    expect(leaf).not.toContain("useTransition");
    expect(leaf).not.toContain("createContext");
    expect(leaf).not.toContain("useRouter");
    expect(leaf).not.toContain("NProgress");
  });

  it("is a client leaf, and does not weaken the server-safe primitive boundary", () => {
    // `useFormStatus` reports nothing unless it runs inside the form it reads,
    // so this MUST be a leaf — and a client one. components/ui/ is the
    // server-compatible set with its own guard; this deliberately does not
    // live there.
    expect(read(LEAF)).toContain('"use client"');
    expect(() => read("components/ui/SignOutMenuItem.tsx")).toThrow();
  });

  it("both shells delegate to the SAME leaf", () => {
    // Two copies would drift, and the whole point of SIGNOUT-01 is that these
    // two surfaces carried an identical defect because they carried identical
    // hand-rolled markup.
    for (const f of [ACCOUNT, MENU]) {
      expect(codeOnly(read(f)), f).toContain("<SignOutMenuItem");
      expect(codeOnly(read(f)), f).toContain('from "./SignOutMenuItem"');
    }
  });
});

describe("SIGNOUT-02 · SIGNOUT-01 is not weakened", () => {
  it("the leaf is a real submit control with no handler of its own", () => {
    expect(leaf).toContain('type="submit"');
    // THE SIGNOUT-01 DEFECT, which this slice must not reintroduce in a new
    // place. An onClick here detaches the form mid-click exactly as one in the
    // menu did, and the Server Action never dispatches.
    expect(leaf).not.toMatch(/onClick/);
  });

  it("the form is hoisted out of the panel, and keeps the server action", () => {
    for (const f of [ACCOUNT, MENU]) {
      const code = codeOnly(read(f));
      // NATIVE SUBMISSION. A client function here removes the POST target and
      // the `$ACTION_ID_` field from the server's HTML, so a press before
      // hydration dispatches nothing. Proved against the served markup in
      // e2e/signout-session-destruction.spec.ts.
      expect(code, f).toMatch(/<form\b[\s\S]{0,200}?action=\{signOut\}[\s\S]{0,200}?id="signout-/);
      expect(code, f).toContain("<SignOutFlightReporter />");
      expect(code, f).not.toContain("trackSignOut");
      // And the control reaches it from inside the panel.
      expect(code, f).toMatch(/formId="signout-/);
    }
  });

  it("logout authority stays server-side and unchanged", () => {
    // This slice is presentation only. If it ever needs to touch the action,
    // that is a different change with a different risk tier.
    const actions = read("app/(app)/dashboard/actions.ts");
    expect(actions).toMatch(/await supabase\.auth\.signOut\(\)/);
    expect(actions).toMatch(/redirect\("\/login"\)/);
  });
});

describe("SIGNOUT-02 · the state is truthful", () => {
  it("has no timer and no fake progress", () => {
    // The rule this pins: the pending state must expire because the ACTION
    // answered, never because time passed. A timer would report a resolution
    // that had not happened.
    expect(leaf).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
    expect(leaf).not.toMatch(/progress|percent|\bstep\b/i);
  });

  it("never claims success", () => {
    expect(leaf).toContain('"Signing out…"');
    // A past-tense or farewell string here would assert an outcome the control
    // cannot know: it only knows a request is outstanding.
    expect(leaf).not.toMatch(/Signed out|Goodbye|See you|Success/i);
  });

  it("disables while in flight, which IS the duplicate-activation guard", () => {
    expect(leaf).toContain("disabled={inFlight}");
    expect(leaf).toContain("aria-busy");
  });
});

describe("SIGNOUT-02b · the pending state outlives the panel", () => {
  const shells = [ACCOUNT, MENU];

  it("the leaf reports NOTHING upward — it only renders", () => {
    // Every bug in this slice came from the leaf owning a fact that outlives
    // it. It now takes the shared truth as a prop and has no way to change it.
    expect(leaf).toContain("const inFlight = pending || busy;");
    expect(leaf).not.toContain("onPendingChange");
    expect(leaf).not.toContain("claimSignOut");
    expect(leaf).not.toContain("orphanSignOut");
    expect(leaf).not.toContain("adoptSignOut");
  });

  it("both shells read ONE authority, and neither owns a private copy", () => {
    // `app/(app)/layout.tsx` renders BOTH menus on every page and hides one
    // with CSS, so they are always-mounted siblings. A per-shell `useState`
    // made the flag per-SHELL rather than per-practitioner: crossing the `lg`
    // breakpoint mid-logout revealed the other menu with its own flag still
    // false, and a fresh enabled Sign out with it.
    for (const f of shells) {
      const code = codeOnly(read(f));
      expect(code, f).toContain("const signingOut = useSignOutInFlight();");
      expect(code, f).toContain("busy={signingOut}");
      expect(code, f).not.toContain("[signingOut, setSigningOut]");
    }
  });

  it("the observer cannot be unmounted by a dismissal, and never writes on unmount", () => {
    // `useFormStatus` reports only for the form it runs inside, so the
    // observer has to be IN the form — and the form is on the shell's
    // persistent root, which closing the panel or crossing the breakpoint
    // cannot take down.
    const reporter = codeOnly(read("app/(app)/SignOutFlightReporter.tsx"));
    expect(reporter).toContain("useFormStatus");
    // IT RELEASES; IT DOES NOT ACQUIRE. The visible control sits OUTSIDE this
    // hidden form, so its own `useFormStatus()` never fires — it is disabled
    // only by `busy` from the shared store. Acquiring here, in a passive
    // effect, left the control enabled between the press and the effect. The
    // form's `onSubmit` takes the hold synchronously instead.
    expect(reporter).toContain("setSignOutInFlight(false);");
    expect(reporter).not.toContain("setSignOutInFlight(true)");
    // Only a reporter that actually saw the submission may release it, or a
    // mount-time `false` would decrement a hold this form never placed.
    expect(reporter).toContain("if (!sawPending.current) return;");
    for (const f of shells) {
      expect(codeOnly(read(f)), f).toContain(
        "onSubmit={() => setSignOutInFlight(true)}",
      );
    }
    // It observes; it does not submit, and it renders nothing.
    expect(reporter).toContain("return null;");
    expect(reporter).not.toMatch(/<form[\s>]/);
    // AND IT NEVER RELEASES ON UNMOUNT. A component going away is not
    // evidence that the request ended; releasing there previously let a
    // second logout be submitted while the first was still running.
    expect(reporter).not.toMatch(/return \(\) =>/);

    const store = codeOnly(read("app/(app)/signout-flight.ts"));
    expect(store).toContain("useSyncExternalStore");
    expect(store).toContain("function getServerSnapshot(): boolean {");
    // Counted and floored, so overlapping publishers cannot release each other.
    expect(store).toContain("if (inFlight < 0) inFlight = 0;");
    // No inference levers, and no client wrapper.
    expect(store).not.toContain("orphan");
    expect(store).not.toContain("adopt");
    expect(store).not.toContain("setTimeout");
    expect(store).not.toContain("trackSignOut");
    // No provider, no layout surgery: the shell layout stays a server component.
    expect(read("app/(app)/layout.tsx")).not.toContain('"use client"');
  });

  it("NO destination stays navigable while a logout is in flight", () => {
    // The contract three earlier versions each missed part of:
    //   * `aria-disabled` is advisory;
    //   * `preventDefault` on click is bypassed by Ctrl/Cmd-click, middle
    //     click and "Open link in new tab";
    //   * holding only the cross-layout links is right about client
    //     navigation and irrelevant to a FRESH DOCUMENT, where the shell
    //     rebuilds with `signingOut === false`.
    // The SHAPE is pinned, not the intent: a held item renders a <span>, and
    // no anchor may merely be conditioned on `signingOut`.
    for (const f of shells) {
      const code = codeOnly(read(f));
      expect(code, f).toContain("const isHeld = () => signingOut;");
      expect(code, f).toMatch(/isHeld\(\) \? \(\s*<span/);
      expect(code, f).not.toMatch(/aria-disabled=\{signingOut/);
      // The narrow containment must not creep back.
      expect(code, f).not.toContain("leavesShell");
    }
  });

  it("the dismissal is deferred and replayed, never dropped", () => {
    // The panel must outlive the logout so `useFormStatus` can report the
    // settlement — but a dismissal the practitioner asked for still has to
    // happen, or the menu is left stuck open over whatever follows.
    for (const f of shells) {
      const code = codeOnly(read(f));
      expect(code, f).toContain("deferredClose.current = true;");
      expect(code, f).toContain("deferredClose.current = false;");
      // Every dismissal path goes through the one rule.
      expect(code, f).toContain('if (e.key === "Escape") close();');
      expect(code, f).toContain("onClick={() => (open ? close() : setOpen(true))}");
      expect(code, f).toContain("close();");
    }
  });

  it("no click handler crept onto the submit path", () => {
    // The SIGNOUT-01 defect, re-checked because this change edits both shells.
    expect(leaf).not.toMatch(/onClick/);
    for (const f of shells) {
      const code = codeOnly(read(f));
      const open = code.indexOf("<form action={signOut}>");
      const close = code.indexOf("</form>", open);
      expect(code.slice(open, close), f).not.toMatch(/onClick/);
    }
  });
});

describe("SIGNOUT-02 · the press survives reduced motion", () => {
  it("the press is a colour step, not only a transform", () => {
    // control-base.ts states the rule for anything composing its press layer:
    // the scale collapses to a no-op under prefers-reduced-motion, so "THE
    // CALLER MUST SUPPLY A COLOUR TREATMENT" — the colour is what survives.
    // Proved in the browser under both motion preferences; pinned here so a
    // refactor to a transform-only press is caught in the fast lane.
    expect(leaf).toMatch(/active:bg-/);
    expect(leaf).toContain("hone-transition-press");
  });

  it("carries the pointer cursor iOS Safari needs to apply :active", () => {
    // Codex P2. Tailwind v4's preflight leaves a <button> at `cursor: default`,
    // and button.tsx records that restoring the pointer is what makes iOS
    // Safari apply `:active` at all. Without it the press step above could
    // never paint on an iPhone — a touch device, where :hover never fires
    // either, so the control would acknowledge nothing.
    //
    // This is pinned at SOURCE because the browser lane structurally cannot
    // see it: chromium-only, and the phone-width tests are Chromium wearing an
    // iPhone user agent rather than Safari. Asserting the class is the honest
    // limit of what this repo can prove here.
    expect(leaf).toContain("cursor-pointer");
  });

  it("the press differs from the hover fill at source", () => {
    // Repeating the hover colour is invisible to a mouse user, because
    // pressing necessarily hovers first. The browser proof compares the two
    // computed colours; this keeps them from being spelled the same.
    const hover = leaf.match(/hover:bg-(\S+?)[\s"]/)?.[1];
    const active = leaf.match(/active:bg-(\S+?)[\s"]/)?.[1];
    expect(hover, "the idle row still has a hover fill").toBeTruthy();
    expect(active, "the row has a press fill").toBeTruthy();
    expect(active).not.toBe(hover);
  });
});
