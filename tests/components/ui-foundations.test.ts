import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// UI0 foundations contract.
//
// This is a GUARD, not a snapshot. The repository has repeatedly shipped
// controls under 44px and controls with their focus outline removed, and each
// time the fix was pinned by a bespoke assertion naming one testid — so the
// tests encoded the fix and never the rule. These assertions encode the RULE,
// against the primitive that is supposed to guarantee it.
//
// It deliberately does NOT ban raw <button> elements elsewhere in the tree.
// 281 interactive elements are currently under the floor; migrating them is a
// later phase, and a gate that fails on day one gets disabled.

const UI_DIR = path.resolve(__dirname, "../../components/ui");
const GLOBALS_CSS = readFileSync(
  path.resolve(__dirname, "../../app/globals.css"),
  "utf8",
);

function uiSource(file: string): string {
  return readFileSync(path.join(UI_DIR, file), "utf8");
}

function codeOnly(src: string): string {
  // Strip JSX {/* */} and /* */ blocks then // lines, so the explanatory prose
  // in these files (which legitimately discusses "outline-none" and "use
  // client" when explaining what the primitives avoid) never trips a negative
  // source assertion.
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Button, buttonClasses } = await import("@/components/ui/button");
const { fieldControlClass, FieldLabel } = await import("@/components/ui/field");
const { StatusPill } = await import("@/components/ui/status-pill");
const { SectionLabel } = await import("@/components/ui/section-label");
const { Skeleton } = await import("@/components/ui/skeleton");

const VARIANTS = ["primary", "secondary", "quiet", "danger"] as const;
const SIZES = ["sm", "md"] as const;

function classAttr(markup: string): string {
  return /class="([^"]*)"/.exec(markup)?.[1] ?? "";
}

describe("Button: the 44px interaction floor is in the primitive", () => {
  for (const variant of VARIANTS) {
    for (const size of SIZES) {
      it(`renders min-h-[44px] for variant=${variant} size=${size}`, () => {
        const cls = classAttr(
          renderToStaticMarkup(
            createElement(Button, { variant, size }, "Label"),
          ),
        );
        expect(cls).toContain("min-h-[44px]");
        // min-height does nothing on an inline box, so the display mode has to
        // travel with it or the floor is silently inert.
        expect(cls).toContain("inline-flex");
      });
    }
  }

  it("only relaxes the height behind a precise pointer, never a width breakpoint", () => {
    const compact = classAttr(
      renderToStaticMarkup(createElement(Button, { size: "sm" }, "Label")),
    );
    expect(compact).toContain("pointer-fine:min-h-8");
    // A `sm:`/`md:` gate would drop the floor on a 768px iPad, which is still
    // a thumb. Any bare responsive min-h override here is a regression.
    expect(compact).not.toMatch(/\b(sm|md|lg|xl):min-h-/);
  });

  it("keeps the floor when a caller passes their own className", () => {
    const cls = classAttr(
      renderToStaticMarkup(
        createElement(Button, { className: "w-full mt-2" }, "Label"),
      ),
    );
    expect(cls).toContain("min-h-[44px]");
    expect(cls).toContain("w-full");
  });

  it("gives <Link>-as-button the identical floor via buttonClasses()", () => {
    for (const variant of VARIANTS) {
      const cls = buttonClasses({ variant });
      expect(cls).toContain("min-h-[44px]");
      expect(cls).toContain("inline-flex");
    }
  });
});

describe("Button: one canonical focus-visible treatment", () => {
  for (const variant of VARIANTS) {
    it(`variant=${variant} carries the focus-visible ring`, () => {
      const cls = classAttr(
        renderToStaticMarkup(createElement(Button, { variant }, "Label")),
      );
      expect(cls).toContain("focus-visible:ring-2");
      expect(cls).toContain("focus-visible:ring-offset-2");
      expect(cls).toContain("focus-visible:ring-focus-ring");
    });
  }

  it("uses focus-visible, never a bare focus: indicator", () => {
    const cls = buttonClasses();
    expect(cls).not.toMatch(/(^|\s)focus:/);
  });

  it("never removes an outline without providing the replacement ring", () => {
    // The exact defect this constant exists to prevent: `outline-none` with no
    // substitute. Checked across every primitive, not just Button.
    for (const file of readdirSync(UI_DIR)) {
      const code = codeOnly(uiSource(file));
      // Capture the whole candidate, variant prefix included, so
      // "focus-visible:outline-none" is not mistaken for a bare removal.
      const removals = code.match(/[A-Za-z0-9:_-]*outline-none/g) ?? [];
      for (const removal of removals) {
        expect(
          removal,
          `${file}: outline removal must be focus-visible-scoped`,
        ).toBe("focus-visible:outline-none");
      }
      if (removals.length > 0) {
        expect(code, `${file}: outline removed without a ring`).toContain(
          "focus-visible:ring-2",
        );
      }
    }
  });
});

describe("Button: press, pending and submit semantics", () => {
  it("acknowledges a press on touch, where :hover never fires", () => {
    for (const variant of VARIANTS) {
      const cls = buttonClasses({ variant });
      expect(cls, `${variant} needs an active: state`).toMatch(/\bactive:/);
      // Restoring the pointer is also what makes iOS Safari apply :active.
      expect(cls).toContain("cursor-pointer");
    }
  });

  it("carries the shared 120ms press transition marker", () => {
    expect(buttonClasses()).toContain("hone-transition-press");
  });

  it("defaults to type=button so it cannot submit a form by accident", () => {
    const markup = renderToStaticMarkup(createElement(Button, {}, "Label"));
    expect(markup).toContain('type="button"');
  });

  it("still honours an explicit type=submit", () => {
    const markup = renderToStaticMarkup(
      createElement(Button, { type: "submit" }, "Save"),
    );
    expect(markup).toContain('type="submit"');
  });

  it("pending disables the control and marks it aria-busy", () => {
    const markup = renderToStaticMarkup(
      createElement(Button, { pending: true }, "Save"),
    );
    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-busy="true"');
  });

  it("pending swaps the label only when a busyLabel is supplied", () => {
    expect(
      renderToStaticMarkup(
        createElement(Button, { pending: true, busyLabel: "Saving…" }, "Save"),
      ),
    ).toContain("Saving…");
    expect(
      renderToStaticMarkup(createElement(Button, { pending: true }, "Save")),
    ).toContain("Save");
  });

  it("is not aria-busy when idle", () => {
    expect(
      renderToStaticMarkup(createElement(Button, {}, "Save")),
    ).not.toContain("aria-busy");
  });
});

describe("Field: iOS cannot zoom a focused control", () => {
  it("ships 16px text on every coarse pointer and 14px only on a fine one", () => {
    const cls = fieldControlClass();
    expect(cls).toContain("text-base");
    expect(cls).toContain("pointer-fine:text-sm");
    // A width breakpoint would hand 14px to a portrait iPad and re-open the
    // zoom bug that was already fixed once, per-control, in June.
    expect(cls).not.toMatch(/\b(sm|md|lg|xl):text-(xs|sm)\b/);
  });

  it("meets the same 44px floor and focus contract as Button", () => {
    const cls = fieldControlClass();
    expect(cls).toContain("min-h-[44px]");
    expect(cls).toContain("focus-visible:ring-2");
    expect(cls).toContain("focus-visible:ring-focus-ring");
    expect(cls).not.toMatch(/(^|\s)focus:/);
  });

  it("paints the invalid border from aria-invalid, so state cannot drift", () => {
    expect(fieldControlClass()).toContain("aria-[invalid=true]:border-danger-solid");
  });

  it("FieldLabel associates the control implicitly and marks required once", () => {
    const markup = renderToStaticMarkup(
      createElement(FieldLabel, {
        label: "Studio name",
        required: true,
        children: createElement("input", { className: fieldControlClass() }),
      }),
    );
    expect(markup).toMatch(/^<label/);
    expect(markup).toContain("<input");
    // Decorative asterisk, real text for assistive tech.
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("(required)");
  });
});

describe("StatusPill: shape is shared, meaning is not", () => {
  it("renders a non-interactive span, safe inside a row-body link", () => {
    const markup = renderToStaticMarkup(
      createElement(StatusPill, { tone: "success", children: "Done" }),
    );
    expect(markup).toMatch(/^<span/);
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<a ");
  });

  it("gives every tone a distinct surface + foreground pair", () => {
    const tones = ["neutral", "info", "success", "warning", "danger"] as const;
    const seen = tones.map((tone) =>
      classAttr(
        renderToStaticMarkup(
          createElement(StatusPill, { tone, children: "x" }),
        ),
      ),
    );
    expect(new Set(seen).size).toBe(tones.length);
    for (const cls of seen) {
      expect(cls).toMatch(/bg-[a-z-]+-surface/);
      expect(cls).toMatch(/text-[a-z-]+-fg/);
    }
  });

  it("exposes no clinical vocabulary — callers own their own state machines", () => {
    const code = codeOnly(uiSource("status-pill.tsx"));
    for (const domainWord of [
      "intake",
      "appointment",
      "consent",
      "allergy",
      "card_on_file",
      "no_show",
    ]) {
      expect(code.toLowerCase()).not.toContain(domainWord);
    }
  });
});

describe("SectionLabel + Skeleton", () => {
  it("SectionLabel keeps the established tracking at both sizes", () => {
    for (const size of ["section", "caption"] as const) {
      const cls = classAttr(
        renderToStaticMarkup(
          createElement(SectionLabel, { size, children: "Before today" }),
        ),
      );
      expect(cls).toContain("uppercase");
      expect(cls).toContain("tracking-wider");
      expect(cls).toContain("text-fg-muted");
    }
  });

  it("SectionLabel can render real heading markup", () => {
    expect(
      renderToStaticMarkup(
        createElement(SectionLabel, { as: "h3", children: "Payments" }),
      ),
    ).toMatch(/^<h3/);
  });

  it("Skeleton is decorative and reduced-motion aware", () => {
    const markup = renderToStaticMarkup(
      createElement(Skeleton, { className: "h-4 w-32" }),
    );
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("hone-skeleton");
    expect(markup).toContain("animate-pulse");
    expect(markup).toContain("h-4 w-32");
  });
});

describe("Foundations do not widen the client boundary", () => {
  it("no primitive declares 'use client'", () => {
    for (const file of readdirSync(UI_DIR)) {
      expect(uiSource(file), `${file} must stay server-compatible`).not.toMatch(
        /^\s*["']use client["']/m,
      );
    }
  });

  it("no primitive imports a browser-only or stateful React API", () => {
    for (const file of readdirSync(UI_DIR)) {
      const code = codeOnly(uiSource(file));
      for (const hook of [
        "useState",
        "useEffect",
        "useRef",
        "useTransition",
        "useFormStatus",
      ]) {
        expect(code, `${file} must not use ${hook}`).not.toContain(hook);
      }
    }
  });

  it("adds no runtime dependency — no clsx, cva, tailwind-merge or motion", () => {
    for (const file of readdirSync(UI_DIR)) {
      const code = codeOnly(uiSource(file));
      for (const dep of [
        "clsx",
        "class-variance-authority",
        "tailwind-merge",
        "framer-motion",
        "motion/react",
        "@radix-ui",
      ]) {
        expect(code, `${file} must not import ${dep}`).not.toContain(dep);
      }
    }
  });
});

describe("globals.css backs the primitives", () => {
  it("defines the interaction timing the primitives reference", () => {
    expect(GLOBALS_CSS).toContain("--hone-duration-press: 120ms");
    expect(GLOBALS_CSS).toContain("--hone-duration-ui: 180ms");
    expect(GLOBALS_CSS).toContain(".hone-transition-press");
  });

  it("collapses the new transitions and stops the skeleton under reduced motion", () => {
    const reduced = GLOBALS_CSS.slice(
      GLOBALS_CSS.indexOf("@media (prefers-reduced-motion: reduce)", GLOBALS_CSS.indexOf("--hone-duration-press")),
    );
    expect(reduced).toContain(".hone-transition-press");
    expect(reduced).toContain(".hone-skeleton");
    expect(reduced).toContain("animation: none");
  });

  it("defines every semantic colour token the primitives consume", () => {
    for (const token of [
      "--color-surface:",
      "--color-surface-sunken:",
      "--color-line:",
      "--color-line-strong:",
      "--color-fg:",
      "--color-fg-muted:",
      "--color-accent:",
      "--color-accent-hover:",
      "--color-on-accent:",
      "--color-focus-ring:",
      "--color-info-surface:",
      "--color-info-fg:",
      "--color-success-surface:",
      "--color-success-fg:",
      "--color-warning-surface:",
      "--color-warning-fg:",
      "--color-danger-surface:",
      "--color-danger-fg:",
      "--color-status-neutral-surface:",
      "--color-status-neutral-fg:",
      "--color-danger-solid:",
      "--color-danger-solid-hover:",
    ]) {
      expect(GLOBALS_CSS, `${token} missing`).toContain(token);
    }
  });

  it("keeps practitioner identity colour out of the semantic token layer", () => {
    // Identity colour is DATA (a practitioner picks it); status colour is
    // meaning. They must not share an authority.
    const tokenBlock = GLOBALS_CSS.slice(
      GLOBALS_CSS.indexOf("HONE UI FOUNDATIONS"),
      GLOBALS_CSS.indexOf("--hone-duration-press"),
    );
    expect(tokenBlock).not.toMatch(/--color-practitioner|--color-service-/);
  });
});
