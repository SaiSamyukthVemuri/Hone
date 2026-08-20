import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// QuickImport "Preview import" must be locked for EVERY active transition.
//
// The regression this pins: the UI0 migration split the button's single
// `disabled={isPending || text.trim().length === 0}` into a `disabled` for
// emptiness plus a `pending` for the busy label. `pending` was the
// preview-SHAPED state (`isPending && !preview`), so once a preview existed
// and a CONFIRM import was in flight, neither half was true and the Preview
// button went live again — overlapping server actions on the same shared
// `useTransition`, with a late re-preview response able to land out of order
// on top of a finished import.
//
// The invariant, stated once: PREVIEW IS DISABLED WHENEVER isPending IS TRUE,
// independent of which busy label is showing.
//
// HOW THIS TESTS IT. QuickImport is a client component driven by useState +
// useTransition, and the unit lane has no DOM, so it cannot be driven through
// those states directly. Instead this reads the REAL prop expressions out of
// the shipped source and evaluates them, then feeds the result through the
// REAL Button primitive and asserts on rendered markup. That means it exercises
// both halves of the contract that actually broke: the call site's expressions,
// and Button's `disabled || pending` composition. Editing either one
// re-evaluates here rather than silently drifting.

const QUICK_IMPORT = path.resolve(
  __dirname,
  "../../../../app/(app)/settings/import/QuickImport.tsx",
);
const SRC = readFileSync(QUICK_IMPORT, "utf8");

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Button } = await import("@/components/ui/button");

/** Pulls the props off the `<Button>` whose child text is `label`. */
function buttonProps(label: string): string {
  // `[^<]*?` rather than `[\\s\\S]*?`: props never contain `<`, so this anchors
  // to the NEAREST preceding <Button and cannot span across an earlier one.
  const match = new RegExp(`<Button\\b([^<]*?)>\\s*${label}\\s*</Button>`).exec(
    SRC,
  );
  if (!match) throw new Error(`no <Button> rendering ${label} in QuickImport`);
  return match[1];
}

function propExpression(props: string, name: string): string | null {
  // The expressions in this file contain no nested braces, so a non-greedy
  // match to the first `}` is exact. If that ever stops being true the throw
  // below surfaces it rather than silently matching a fragment.
  const match = new RegExp(`\\b${name}=\\{([^}]*)\\}`).exec(props);
  return match ? match[1].trim() : null;
}

type World = { isPending: boolean; preview: object | null; text: string };

function evaluate(expression: string, world: World): boolean {
  const fn = new Function(
    "isPending",
    "preview",
    "text",
    `return (${expression});`,
  ) as (isPending: boolean, preview: object | null, text: string) => unknown;
  return Boolean(fn(world.isPending, world.preview, world.text));
}

const PREVIEW_PROPS = buttonProps("Preview import");
const PREVIEW_DISABLED = propExpression(PREVIEW_PROPS, "disabled");
const PREVIEW_PENDING = propExpression(PREVIEW_PROPS, "pending");

/** Renders the real Button with the real expressions and reports the DOM state. */
function previewIsDisabled(world: World): boolean {
  if (!PREVIEW_DISABLED) throw new Error("Preview button lost its disabled prop");
  const markup = renderToStaticMarkup(
    createElement(
      Button,
      {
        disabled: evaluate(PREVIEW_DISABLED, world),
        pending: PREVIEW_PENDING ? evaluate(PREVIEW_PENDING, world) : false,
        children: "Preview import",
      },
    ),
  );
  // Must match the ATTRIBUTE, not the substring: the class string always
  // carries `disabled:cursor-not-allowed disabled:opacity-50`.
  return /\sdisabled=""/.test(markup);
}

const SOME_PREVIEW = { readyGroups: 2, warningGroups: 0 };

describe("QuickImport Preview: the disabled truth table", () => {
  it("1. idle + valid text → enabled", () => {
    expect(
      previewIsDisabled({ isPending: false, preview: null, text: "name,email" }),
    ).toBe(false);
  });

  it("2. idle + empty text → disabled", () => {
    expect(
      previewIsDisabled({ isPending: false, preview: null, text: "   " }),
    ).toBe(true);
  });

  it("3. preview request pending → disabled", () => {
    expect(
      previewIsDisabled({ isPending: true, preview: null, text: "name,email" }),
    ).toBe(true);
  });

  it("4. confirm/import pending while a preview already exists → disabled", () => {
    // THE REGRESSION. Before the repair this returned false: `disabled` only
    // covered emptiness and `pending` was false because a preview existed.
    expect(
      previewIsDisabled({
        isPending: true,
        preview: SOME_PREVIEW,
        text: "name,email",
      }),
    ).toBe(true);
  });

  it("is disabled in EVERY isPending state, whatever else is true", () => {
    for (const preview of [null, SOME_PREVIEW]) {
      for (const text of ["name,email", "   ", ""]) {
        expect(
          previewIsDisabled({ isPending: true, preview, text }),
          `isPending with preview=${preview ? "set" : "null"} text=${JSON.stringify(text)}`,
        ).toBe(true);
      }
    }
  });

  it("matches the pre-migration expression exactly, across the whole table", () => {
    // The production behaviour this restores, spelled independently of the
    // shipped source so the two must agree rather than be copied.
    const base = (w: World) => w.isPending || w.text.trim().length === 0;
    for (const isPending of [false, true]) {
      for (const preview of [null, SOME_PREVIEW]) {
        for (const text of ["name,email", "   ", ""]) {
          const world = { isPending, preview, text };
          expect(
            previewIsDisabled(world),
            `isPending=${isPending} preview=${preview ? "set" : "null"} text=${JSON.stringify(text)}`,
          ).toBe(base(world));
        }
      }
    }
  });
});

describe("QuickImport Preview: the lock does not depend on the busy label", () => {
  it("gates `disabled` on isPending itself, not on the preview-shaped pending state", () => {
    expect(PREVIEW_DISABLED).toContain("isPending");
    // The specific defect: `disabled` must not be narrowed to the label's
    // condition. If someone reintroduces `isPending && !preview` as the only
    // pending gate, case 4 above fails — this assertion just names why.
    expect(PREVIEW_DISABLED).not.toMatch(/!\s*preview/);
  });

  it("keeps the pending label presentational, so 'Reading…' still only shows for a preview", () => {
    expect(PREVIEW_PENDING).toBe("isPending && !preview");
    expect(PREVIEW_PROPS).toContain('busyLabel="Reading…"');
    expect(
      evaluate(PREVIEW_PENDING!, {
        isPending: true,
        preview: SOME_PREVIEW,
        text: "x",
      }),
      "an in-flight confirm must not relabel Preview as Reading…",
    ).toBe(false);
  });
});

describe("QuickImport Confirm: unchanged by the repair", () => {
  it("stays disabled for the whole transition and for an empty preview", () => {
    const props = buttonProps("Confirm import");
    const disabled = propExpression(props, "disabled");
    const pending = propExpression(props, "pending");
    expect(pending).toBe("isPending");
    // Button ORs the two, so effective disabled is
    // `zeroGroups || isPending` — byte-for-byte the pre-migration expression.
    const effective = (isPending: boolean, ready: number, warning: number) => {
      const fn = new Function(
        "isPending",
        "preview",
        `return (${disabled}) || (${pending});`,
      ) as (isPending: boolean, preview: object) => unknown;
      return Boolean(
        fn(isPending, { readyGroups: ready, warningGroups: warning }),
      );
    };
    expect(effective(false, 2, 0)).toBe(false);
    expect(effective(true, 2, 0)).toBe(true);
    expect(effective(false, 0, 0)).toBe(true);
    expect(effective(true, 0, 0)).toBe(true);
  });
});
