import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

import { Button, buttonClasses } from "@/components/ui/button";
import {
  CONTROL_DISABLED,
  CONTROL_PRESS,
  LEAF_CONTROL_PRESS,
  PRESS_TRANSITION,
  SURFACE_PRESS,
} from "@/components/ui/control-base";
import { Spinner, spinnerClasses } from "@/components/ui/spinner";

// UI-R01 — the interaction foundations, proved structurally.
//
// WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY IS NOT
// -----------------------------------------------------
// These are SOURCE-CONTRACT proofs: they prove what the primitives SAY.
// Timing — CLICK_TO_ACK and CLICK_TO_VISIBLE_PENDING — is proved in the
// browser, in e2e/perceived-speed.spec.ts, because a millisecond claim made by
// a string comparison would be a lie. This file's job is the half a browser
// test is bad at: that every variant carries the vocabulary, that no call site
// can quietly opt out, and that the geometry contract is structural rather
// than a matter of review discipline.

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(el);
const read = (p: string) => readFileSync(p, "utf8");

/**
 * A file's EXECUTABLE text: line comments, block comments and JSX comments
 * stripped.
 *
 * Every source assertion below goes through this, and the first draft of this
 * file is why. Asserting `not.toContain("<button")` against raw source failed
 * on the migrated files — because the migration comments EXPLAIN what was
 * removed and therefore quote it. The same trap the repo already documented
 * for the `--linked` scan in tests/scripts/db-harness-guardrails.test.ts:
 * comments may name the very thing the rule forbids.
 */
function code(path: string): string {
  return read(path)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The rendered <button ...> attribute text, without its class list. */
const attrs = (markup: string): string =>
  (/<button([^>]*)>/.exec(markup)?.[1] ?? "").replace(/class="[^"]*"/, "");

/**
 * The disabled ATTRIBUTE, never the substring.
 *
 * An enabled Button still carries "disabled" in its class attribute, via
 * `disabled:cursor-not-allowed disabled:opacity-50`. ui-foundations.test.ts
 * documents this exact trap; repeating the substring check here would have
 * made the idle-state proof vacuous.
 */
const isDisabled = (markup: string): boolean => /(^|\s)disabled(=|\s|$)/.test(attrs(markup));

const VARIANTS = ["primary", "secondary", "quiet", "danger"] as const;
const SIZES = ["sm", "md"] as const;

describe("UI-R01 press acknowledgement: the state the app was missing", () => {
  for (const variant of VARIANTS) {
    it(`variant=${variant} acknowledges a press without hover`, () => {
      const html = render(createElement(Button, { variant }, "Go"));
      // The recon measured `active:` in 10 of 118 button files. On a touch
      // device :hover never fires, so :active IS the acknowledgement — a
      // control without it is dead from first contact on a phone.
      expect(html).toContain("active:scale-[0.98]");
      expect(html).toContain(PRESS_TRANSITION);
    });
  }

  // ── The safety split, which is the whole point of the vocabulary ──────────
  //
  // Review caught the earlier shape: CONTROL_PRESS carried `active:scale-[0.98]`
  // and was intended for broad adoption across ~108 unread control files. A
  // non-none scale establishes a containing block for position:fixed
  // descendants and a new stacking context while pressed, so a control
  // anchoring a popover would silently reparent it. A comment could not protect
  // that; the API now does.

  it("THE UNIVERSAL primitive never transforms — enforced, not merely documented", () => {
    for (const banned of ["scale", "transform", "translate", "rotate", "skew", "filter"]) {
      expect(
        CONTROL_PRESS,
        `CONTROL_PRESS must stay safe on ANY control; "${banned}" creates a ` +
          `containing block for fixed descendants. Use LEAF_CONTROL_PRESS instead.`,
      ).not.toContain(banned);
    }
  });

  it("the universal primitive still acknowledges a press, without hover", () => {
    expect(CONTROL_PRESS).toContain("active:");
    expect(CONTROL_PRESS).toContain(PRESS_TRANSITION);
  });

  it("pressed and DISABLED remain visually distinguishable", () => {
    // opacity-90 (pressed) must not collide with opacity-50 (disabled), or a
    // pressed control would read as unavailable.
    expect(CONTROL_PRESS).toContain("opacity-90");
    expect(CONTROL_PRESS).not.toContain("opacity-50");
    expect(CONTROL_DISABLED).toContain("opacity-50");
  });

  it("LEAF_CONTROL_PRESS is the ONLY shared primitive carrying a scale", () => {
    expect(LEAF_CONTROL_PRESS).toContain("active:scale-[0.98]");
    expect(SURFACE_PRESS).not.toContain("scale");
    expect(CONTROL_PRESS).not.toContain("scale");
  });

  it("the leaf treatment COMPOSES the universal one, so reduced motion still lands", () => {
    // Dropping the scale under reduced motion must not drop the whole
    // acknowledgement; the universal treatment underneath is what remains.
    expect(LEAF_CONTROL_PRESS).toContain("motion-reduce:active:scale-100");
    expect(LEAF_CONTROL_PRESS).toContain("active:opacity-90");
  });

  it("Button opts into the leaf treatment DELIBERATELY, in source", () => {
    const src = code("components/ui/button.tsx");
    expect(src).toContain("LEAF_CONTROL_PRESS");
    // And not by accidentally inheriting a transform from the universal one.
    expect(src).not.toMatch(/\bCONTROL_PRESS\b(?!_)/);
  });

  it("guarantees reduced-motion feedback ITSELF, not via the call site", () => {
    // Caught by review. The first draft relied on the consumer having an
    // `active:` background — true of Button, false of the ~108 arbitrary
    // elements UI-R03 will apply this to. A primitive that only works when the
    // call site remembers something is the failure mode control-base.ts exists
    // to prevent.
    // The universal treatment is opacity-based, so it is ALREADY independent of
    // motion — there is nothing to fall back to, because nothing was motion.
    expect(CONTROL_PRESS).toContain("active:opacity-90");
    expect(CONTROL_PRESS).not.toContain("opacity-50");
  });

  it("drops the transform under reduced motion but KEEPS an acknowledgement", () => {
    const html = render(createElement(Button, { variant: "primary" }, "Go"));
    // The movement stops...
    expect(html).toContain("motion-reduce:active:scale-100");
    // ...but the control still changes on press, because every variant also
    // carries an active: background. Reduced motion must not mean NO feedback.
    expect(html).toMatch(/active:bg-/);
  });

  for (const variant of VARIANTS) {
    it(`variant=${variant} still carries an active: background, so motion is never the only signal`, () => {
      expect(render(createElement(Button, { variant }, "Go"))).toMatch(/active:bg-/);
    });
  }

  it("CONTROL_PRESS carries its own transition, so the marker is not emitted twice", () => {
    expect(CONTROL_PRESS).toContain(PRESS_TRANSITION);
    const occurrences = render(createElement(Button, {}, "Go")).split(PRESS_TRANSITION).length - 1;
    expect(occurrences).toBe(1);
  });

  it("SURFACE_PRESS never transforms — containers acknowledge with their surface", () => {
    // A transform on a row would scale its text and borders, and would create a
    // containing block for fixed descendants and a new stacking context. Rows
    // in this app host absolutely-positioned scrims; that must not change.
    expect(SURFACE_PRESS).not.toContain("scale");
    expect(SURFACE_PRESS).not.toContain("translate");
    expect(SURFACE_PRESS).toContain("active:");
    expect(SURFACE_PRESS).toContain(PRESS_TRANSITION);
  });

  it("the press transition animates the property Tailwind ACTUALLY emits — `scale`", () => {
    // THIS GUARD WAS VACUOUS AND REVIEW CAUGHT IT.
    //
    // It asserted the transition-property list contained `transform`. But
    // Tailwind v4 compiles `active:scale-[0.98]` to the STANDALONE `scale:`
    // property — the compiled stylesheet emits
    //   active\:scale-\[0\.98\]:active{scale:.98}
    // — so `transform` is not the property that needs transitioning, and
    // deleting `scale` from the list (the exact regression this exists to
    // catch) left the guard green. Proven by mutation before this rewrite.
    //
    // It now asserts the load-bearing property. `transform` is asserted too,
    // because the list carries it deliberately for any call site that sets a
    // transform directly — but it is no longer a stand-in for `scale`.
    const css = read("app/globals.css");
    const block = css.slice(
      css.indexOf(".hone-transition-press,"),
      css.indexOf(".hone-transition-press {"),
    );
    const props = /transition-property:([^;]*);/.exec(block)?.[1] ?? "";
    expect(props, "no transition-property found in the shared marker block").not.toBe("");
    const listed = props.split(",").map((x) => x.trim());
    expect(listed).toContain("scale");
    expect(listed).toContain("transform");
  });

  it("reduced motion still collapses the shared markers to 1ms, not 0", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
    expect(css).toMatch(/transition-duration:\s*1ms/);
  });
});

describe("UI-R01 spinner: one spinner, stable box, legible when still", () => {
  it("is square and absolutely sized in both axes, so it cannot resize a control", () => {
    expect(spinnerClasses("sm")).toContain("size-4");
    expect(spinnerClasses("md")).toContain("size-5");
  });

  it("communicates state when it cannot move", () => {
    // animate-none alone leaves a ring with a transparent quarter, which reads
    // as broken. Closing the quarter makes the still frame a deliberate glyph:
    // the change is a SHAPE change, never colour alone.
    const c = spinnerClasses("sm");
    expect(c).toContain("motion-reduce:animate-none");
    expect(c).toContain("motion-reduce:border-t-current");
  });

  it("is silent by default, because something else is already announcing", () => {
    // Paired with Button's aria-busy or PendingLink's role=status region, a
    // spinner that also announced would double-announce.
    const html = render(createElement(Spinner, {}));
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("role=\"status\"");
  });

  it("speaks only when told it is the only voice in the control", () => {
    const html = render(createElement(Spinner, { label: "Loading" }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading");
    // The mark itself stays decorative even then.
    expect(html).toContain('aria-hidden="true"');
  });

  it("IS the navigation mark — one spinner in the app, not two", () => {
    // pending-link.tsx must compose the primitive rather than re-spelling it.
    // If these drift, navigation pending and control pending stop looking like
    // the same product.
    const src = code("components/pending-link.tsx");
    expect(src).toContain("spinnerClasses");
    expect(src).not.toMatch(/const MARK =\s*"size-4 animate-spin/);
  });

  it("ships no third-party package", () => {
    const src = code("components/ui/spinner.tsx");
    expect(src).not.toMatch(/from "(clsx|tailwind-merge|cva|class-variance-authority|framer-motion)"/);
  });
});

describe("UI-R01 pending: visible, guarded, and geometry-stable", () => {
  it("a pending Button with no busyLabel now SHOWS something (it did not before)", () => {
    // Before UI-R01 this branch rendered children unchanged: `pending` with no
    // busyLabel produced no pending state at all beyond the disabled dimming.
    const html = render(createElement(Button, { pending: true }, "Export data"));
    expect(html).toContain('data-pending-mark="true"');
    expect(html).toContain("animate-spin");
  });

  it("keeps the label in flow at opacity-0, so the control cannot resize", () => {
    const html = render(createElement(Button, { pending: true }, "Export data"));
    // The words are still in the box — that is what reserves the width.
    expect(html).toContain("Export data");
    expect(html).toContain("opacity-0");
    // And the mark is out of flow, centred over them.
    expect(html).toMatch(/absolute inset-0/);
  });

  it("KEEPS the accessible name while busy — the label is not aria-hidden", () => {
    // Caught by review: the first draft hid the label from the a11y tree, so
    // the button's accessible name collapsed to empty for exactly as long as it
    // was aria-busy. "Busy" about a control that no longer says what it is.
    //
    // Asserting `toContain("Export data")` above does NOT catch this — the text
    // is in the DOM either way. The property is whether it is EXPOSED, so that
    // is what this asserts: the label span carries no aria-hidden, and the only
    // hidden thing is the decorative mark.
    const html = render(createElement(Button, { pending: true }, "Export data"));
    const labelSpan = /<span class="opacity-0"[^>]*>/.exec(html)?.[0] ?? "";
    expect(labelSpan, "the label span must exist and be plain").not.toBe("");
    expect(labelSpan).not.toContain("aria-hidden");
    // Exactly one aria-hidden in the pending markup: the spinner.
    expect((html.match(/aria-hidden/g) ?? []).length).toBe(1);
  });

  it("marks itself busy and disables itself, so a double submit is impossible", () => {
    const html = render(createElement(Button, { pending: true }, "Save"));
    expect(html).toContain('aria-busy="true"');
    expect(isDisabled(html)).toBe(true);
    expect(html).toContain('data-pending="true"');
  });

  it("is pressable and not busy when idle", () => {
    const html = render(createElement(Button, {}, "Save"));
    expect(html).not.toContain("aria-busy");
    // The ATTRIBUTE, not the substring — an enabled Button's class list
    // contains "disabled:" by design.
    expect(isDisabled(html)).toBe(false);
    expect(html).toContain("disabled:"); // guards the guard
    expect(html).not.toContain('data-pending-mark="true"');
  });

  it("PRESERVES the shipped busyLabel contract rather than redefining it", () => {
    // 16 call sites and an existing ui-foundations proof depend on this exact
    // behaviour. UI-R01 adds a better default; it does not break the old one.
    const html = render(
      createElement(Button, { pending: true, busyLabel: "Saving…" }, "Save"),
    );
    expect(html).toContain("Saving…");
    expect(html).not.toContain("Export data");
  });

  it("the geometry-stable form is selected by OMITTING busyLabel", () => {
    const withLabel = render(
      createElement(Button, { pending: true, busyLabel: "Saving…" }, "Save"),
    );
    const withoutLabel = render(createElement(Button, { pending: true }, "Save"));
    expect(withLabel).not.toContain('data-pending-mark="true"');
    expect(withoutLabel).toContain('data-pending-mark="true"');
  });

  it("gives the spinner a positioning context, or the overlay would escape", () => {
    expect(buttonClasses()).toContain("relative");
  });
});

describe("UI-R01 focus: one treatment, on every shared control", () => {
  for (const variant of VARIANTS) {
    for (const size of SIZES) {
      it(`variant=${variant} size=${size} exposes focus-visible`, () => {
        const html = render(createElement(Button, { variant, size }, "Go"));
        expect(html).toContain("focus-visible:ring-2");
        expect(html).toContain("focus-visible:outline-hidden");
      });
    }
  }

  it("never regresses to a bare focus:, which also fires on mouse click", () => {
    const cls = buttonClasses();
    expect(cls).not.toMatch(/(^|\s)focus:/);
  });

  it("the touch floor survives everything UI-R01 added", () => {
    for (const variant of VARIANTS) {
      expect(buttonClasses({ variant })).toContain("min-h-[44px]");
      expect(buttonClasses({ variant })).toContain("inline-flex");
    }
  });
});

describe("UI-R01 PendingButton: the leaf that owns useFormStatus", () => {
  const src = code("components/pending-button.tsx");

  it("is a client leaf", () => {
    // RAW source: the directive is not a comment and must be the first thing
    // in the file.
    expect(read("components/pending-button.tsx").trimStart().startsWith('"use client"')).toBe(true);
  });

  it("does NOT drag the server-compatible primitive into the client", () => {
    // Button must stay server-renderable: putting useFormStatus inside it
    // would hydrate every settings, records and clinical page for nothing.
    const button = code("components/ui/button.tsx");
    expect(button).not.toContain('"use client"');
    expect(button).not.toContain("useFormStatus");
    const spinner = code("components/ui/spinner.tsx");
    expect(spinner).not.toContain('"use client"');
  });

  it("submits, and drives Button's existing pending API rather than a new one", () => {
    expect(src).toContain("useFormStatus");
    expect(src).toContain('type="submit"');
    expect(src).toContain("pending={pending}");
  });

  it("imports nothing beyond the hook and the primitive — it is a leaf", () => {
    const imports = src.match(/^import .*$/gm) ?? [];
    expect(imports.length).toBeLessThanOrEqual(2);
  });
});

describe("UI-R01 proof surface: the migrated controls", () => {
  const exportBtn = code("app/(app)/settings/data/ExportButton.tsx");
  const tracking = code("app/(app)/settings/tracking/TrackingProviderForm.tsx");

  it("the async export control uses the primitive, not a hand-built button", () => {
    expect(exportBtn).toContain('from "@/components/ui/button"');
    expect(exportBtn).not.toContain("<button");
    // The hardcoded brand hex and inline style are gone.
    expect(exportBtn).not.toContain("#0A0A0A");
    expect(exportBtn).not.toContain("style={{ backgroundColor");
  });

  it("the export control no longer swaps a width-changing label", () => {
    // "Export data" (11) -> "Preparing export…" (17) resized the button mid-press.
    expect(exportBtn).not.toContain('"Preparing export…"');
    expect(exportBtn).not.toMatch(/pending \? "/);
  });

  it("the export control announces success and failure", () => {
    expect(exportBtn).toContain('role="status"');
    expect(exportBtn).toContain('aria-live="polite"');
    expect(exportBtn).toContain('role="alert"');
  });

  it("save and destructive both use the primitive, and destructive says so", () => {
    expect(tracking).toContain('from "@/components/ui/button"');
    expect(tracking).not.toContain("<button");
    expect(tracking).toContain('variant="danger"');
    expect(tracking).not.toMatch(/pending \? "Saving…" : "Save"/);
  });

  it("the destructive action cannot race the save it sits beside", () => {
    expect(tracking).toMatch(/variant="danger"[\s\S]{0,200}disabled=\{pending\}/);
  });

  it("navigation keeps ONE authority — no second link spinner was introduced", () => {
    // The link kinds were already proved in production (SettingsNav is a simple
    // PendingLink; the dashboard rows are PendingContainerLink). UI-R01's job
    // was not to migrate them again, it was to avoid growing a rival.
    const nav = code("app/(app)/settings/SettingsNav.tsx");
    expect(nav).toContain("PendingLink");
    expect(nav).not.toContain('from "next/link"');
  });
});
