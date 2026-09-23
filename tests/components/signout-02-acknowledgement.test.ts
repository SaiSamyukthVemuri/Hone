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

  it("the form itself is untouched in both shells", () => {
    for (const f of [ACCOUNT, MENU]) {
      expect(codeOnly(read(f)), f).toContain("<form action={signOut}>");
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

  it("the leaf reports pending UP and accepts busy back DOWN", () => {
    expect(leaf).toContain("onPendingChange");
    expect(leaf).toContain("busy");
    // Both are needed: the shell cannot know without the first, and a
    // remounted leaf cannot know without the second.
    expect(leaf).toContain("const inFlight = pending || busy;");
  });

  it("only TRANSITIONS are reported, never the initial false", () => {
    // Load-bearing. Reporting the mount-time `false` would have a freshly
    // reopened leaf immediately clear the shell's flag, reinstating the very
    // defect this closes — and silently, since everything still compiles.
    expect(leaf).toContain("if (pending === reported.current) return;");
  });

  it("each shell holds the flag and hands it back", () => {
    for (const f of shells) {
      const code = codeOnly(read(f));
      expect(code, f).toContain("const [signingOut, setSigningOut] = useState(false);");
      expect(code, f).toContain("busy={signingOut}");
      expect(code, f).toContain("onPendingChange={setSigningOut}");
    }
  });

  it("all three dismissal paths are gated on the in-flight logout", () => {
    for (const f of shells) {
      const code = codeOnly(read(f));
      // Escape.
      expect(code, f).toContain('if (e.key === "Escape" && !signingOut) setOpen(false);');
      // Outside pointerdown.
      expect(code, f).toContain("if (signingOut) return;");
      // The trigger may still OPEN — refusing that too would strand the menu.
      expect(code, f).toContain("setOpen((v) => (v && signingOut ? true : !v))");
    }
  });

  it("ONE dismissal function carries the rule, links included", () => {
    // The correction to a first version that gated Escape, the outside click
    // and the trigger but left the LINKS alone as "not a dismissal". They are
    // not — but they closed the panel all the same, unmounting the leaf whose
    // effect is the only thing that can report settlement. `signingOut` then
    // stuck ON permanently, because a logout the practitioner walked away from
    // never applies its redirect to the page they walked to. That traded a
    // duplicate logout for a dead control.
    //
    // Stating the rule once, inside `close`, is what makes every caller
    // inherit it instead of each one having to remember.
    for (const f of shells) {
      const code = codeOnly(read(f));
      expect(code, f).toMatch(
        /const close = \(\) => \{\s*if \(signingOut\) return;\s*setOpen\(false\);\s*\};/,
      );
    }
  });

  it("links that LEAVE the route group are held while a logout is in flight", () => {
    // `app/(app)/layout.tsx` is what carries the in-flight flag through a
    // navigation, so a link out of that route group unmounts the flag and the
    // leaf together — and the destination layout renders its own Sign out.
    // Two links do that: /admin and /no-access.
    for (const f of shells) {
      const code = codeOnly(read(f));
      expect(code, f).toContain('href.startsWith("/admin") || href.startsWith("/no-access")');
      expect(code, f).toContain("if (signingOut && leavesShell(href))");
      expect(code, f).toContain("e.preventDefault();");
    }
  });

  it("the premise is real: the admin layout has its own Sign out", () => {
    // If this ever stops being true, the hold above is dead weight and should
    // be re-justified rather than left as cargo.
    const adminLayout = read("app/admin/layout.tsx");
    expect(adminLayout).toContain("signOut");
  });

  it("the links still navigate — only the dismissal is deferred", () => {
    // Bounded: no navigation was redesigned. The link still preventDefaults
    // and pushes (NAV-ACK-01); the panel simply outlives the push while a
    // logout is in flight, which is what keeps the observer alive.
    const menu = codeOnly(read(MENU));
    expect(menu).toContain("navigate(e, item.href, item.label);");
    expect(codeOnly(read(ACCOUNT))).toContain("close();");
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
