import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #228: mobile/iPad UX stabilization pins. The behavior is proven
// by the browser lane (e2e/mobile-ux.spec.ts); these pins keep the
// load-bearing source properties from regressing in the fast lane.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const LAYOUT = read("app/(app)/layout.tsx");
const MENU = read("app/(app)/MobileMenu.tsx");
const ACCOUNT = read("app/(app)/AccountMenu.tsx");
// SIGNOUT-02: the submit control both shells now delegate to.
const SIGNOUT_LEAF = read("app/(app)/SignOutMenuItem.tsx");
const GLOBALS = read("app/globals.css");

describe("app shell: no overflow band-aid", () => {
  it("no page-wide overflow-x-hidden band-aid was added", () => {
    expect(LAYOUT).not.toMatch(/overflow-x-hidden|overflow-x:\s*hidden/);
    expect(GLOBALS).not.toMatch(/overflow-x:\s*hidden/);
  });
});

// SIGNOUT-01. An authenticated practitioner pressed "Sign out" and stayed
// signed in: the submit button's own onClick closed the menu, React flushed
// that discrete update synchronously, and the <form> was detached before the
// button's activation behaviour ran — so the browser cancelled the submission
// and the Server Action never dispatched.
//
// The behaviour is proved in the browser by
// e2e/signout-session-destruction.spec.ts, which drives a real logout on both
// surfaces and reads auth.sessions / auth.refresh_tokens. These pins keep the
// load-bearing SOURCE property from being reintroduced in the fast lane.
describe("SIGNOUT-01: the Sign out submit path never unmounts its own form", () => {
  // These pins assert over CODE, never prose. Both shells DISCUSS `onClick`,
  // `<Link>` and the withdrawn mechanisms BY NAME in load-bearing comments, and
  // since NAV-ACK-01 (DESIGN.md contract 2d) MobileMenu.tsx explains in a
  // comment that `useLinkStatus` must run inside the `<Link>` that owns the
  // navigation. Matched against raw source, that sentence reads as a `<Link>`
  // carrying no onClick and fails the link pin below for a reason that has
  // nothing to do with the panel — a false positive on a real contract. Strip
  // comments first, so each assertion is about what actually renders.
  //
  // LINE comments are stripped BEFORE block comments, deliberately: a `//` line
  // containing `/*` would otherwise leave the block stripper eating everything
  // to the next `*/`, silently removing real code and making every assertion
  // here vacuously true.
  const codeOnly = (source: string) =>
    source
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");

  function signOutForm(name: string, source: string): string {
    const code = codeOnly(source);
    // SIGNOUT-02c. The form MOVED but its action did not. It is hoisted out
    // of the dismissible panel onto the shell's persistent root, so nothing
    // about a press can unmount it — strictly stronger than the property
    // SIGNOUT-01 originally needed. Its action is still `signOut` itself,
    // because wrapping it in a client function removed the POST target and the
    // `$ACTION_ID_` field from the SERVER'S HTML, so a press before hydration
    // dispatched nothing at all.
    const open = code.search(/<form\b[\s\S]{0,200}?action=\{signOut\}[\s\S]{0,200}?id="signout-/);
    expect(open, `${name}: the Sign out form exists`).toBeGreaterThan(-1);
    // The form is SELF-CLOSING now: it holds nothing. The submit control lives
    // in the panel and reaches it by `form=`, which is what lets the form sit
    // on the persistent root where no dismissal can touch it.
    const close = code.indexOf("/>", open);
    expect(close, `${name}: the Sign out form tag is closed`).toBeGreaterThan(open);
    return code.slice(open, close + 2);
  }

  for (const [name, source] of [
    ["MobileMenu.tsx", MENU],
    ["AccountMenu.tsx", ACCOUNT],
  ] as const) {
    // If the stripper over-eats, every assertion below passes for the wrong
    // reason. Prove it keeps real code and drops real prose.
    it(`${name}: the comment stripper keeps code and drops prose`, () => {
      const code = codeOnly(source);
      expect(code, `${name}: the Sign out form survives`).toMatch(
        /<form\b[\s\S]{0,200}?action=\{signOut\}[\s\S]{0,200}?id="signout-/,
      );
      expect(code, `${name}: real links survive`).toMatch(/<Link\b/);
      // This token exists ONLY inside a comment in both shells.
      expect(code, `${name}: comment prose is gone`).not.toContain(
        "SIGNOUT-01",
      );
    });

    it(`${name}: the Sign out submit path carries no click handler of its own`, () => {
      const form = signOutForm(name, source);

      // SIGNOUT-02 moved the control itself into a leaf, because
      // `useFormStatus` reports nothing unless it runs INSIDE the form it
      // reads. The property this test exists for did not move, so the
      // assertion follows it into the leaf rather than being relaxed to fit
      // the new shape. Both halves are checked: the call site, and the control.
      expect(
        codeOnly(source),
        `${name}: the form's action is the server action itself`,
      ).toMatch(/<form\b[\s\S]{0,200}?action=\{signOut\}[\s\S]{0,200}?id="signout-/);
      expect(
        codeOnly(source),
        `${name}: the panel's control submits the hoisted form`,
      ).toMatch(/<SignOutMenuItem\s+formId="signout-/);

      // THE FORM IS OUTSIDE THE PANEL. That is what makes its status
      // observer survive a dismissal, and it also means this form can no
      // longer be unmounted by the press — strictly stronger than the
      // property SIGNOUT-01 originally needed.
      expect(
        codeOnly(source),
        `${name}: the sign-out form is hoisted out of the {open && ...} panel`,
      ).toMatch(/<form\b[\s\S]{0,200}?action=\{signOut\}[\s\S]{0,200}?id="signout-/);
      // No hand-rolled control left behind in the form.
      expect(form, `${name}: no control sits in the hoisted form`).not.toMatch(
        /<button/,
      );

      // THE DEFECT, in one assertion, now applied to BOTH files. Any onClick on
      // this submit path closes the menu during the click, detaches the form
      // before its activation behaviour runs, and the logout never dispatches.
      expect(
        form,
        "a click handler here unmounts the form mid-click and cancels the submission",
      ).not.toMatch(/onClick/);

      const leaf = codeOnly(SIGNOUT_LEAF);
      expect(leaf, "the leaf is a real submit control").toContain('type="submit"');
      expect(leaf, "the leaf still renders the label").toContain("Sign out");
      expect(
        leaf,
        "a click handler in the leaf detaches the form exactly as one in the menu did",
      ).not.toMatch(/onClick/);
    });

    it(`${name}: ordinary links still dismiss the panel themselves`, () => {
      // Deliberately NOT pinned to one spelling of the handler: the point is
      // that a link inside a panel that survives the navigation must dismiss
      // it, not which function does the dismissing.
      const links = codeOnly(source).match(/<Link\b[\s\S]*?>/g) ?? [];
      expect(links.length, `${name}: the panel still renders links`).toBeGreaterThan(0);
      for (const link of links) {
        expect(
          link,
          `${name}: a <Link> with no onClick would leave the panel open`,
        ).toMatch(/onClick=/);
      }
    });
  }

  it("logout authority stays server-side, with Supabase semantics unchanged", () => {
    const ACTIONS = read("app/(app)/dashboard/actions.ts");
    expect(ACTIONS).toMatch(/"use server"/);
    expect(ACTIONS).toMatch(/await supabase\.auth\.signOut\(\)/);
    expect(ACTIONS).toMatch(/redirect\("\/login"\)/);
  });
});
