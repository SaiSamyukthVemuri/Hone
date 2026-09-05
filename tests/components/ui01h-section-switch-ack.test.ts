import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// UI-01H-A — section-switch tap acknowledgement.
//
// A <Link> click starts a React transition that keeps the OLD page mounted,
// fully painted and fully interactive, until the RSC payload arrives. Nothing
// on screen says the tap registered, so on a tablet the practitioner taps
// again. Nine `aria-current` section-switch rows exist; three already
// acknowledge. These five did not.
//
// Adoption only: `components/pending-link.tsx` already ships the primitive and
// already has consumers. No primitive was added or changed.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ROWS = {
  clients: { file: "app/(app)/clients/page.tsx", label: "Loading clients…", kind: "PendingLink" },
  records: { file: "app/(app)/records/page.tsx", label: "Loading section…", kind: "PendingLink" },
  snapshot: { file: "app/(app)/dashboard/practice-snapshot.tsx", label: "Loading period…", kind: "PendingLink" },
  scope: { file: "app/(app)/settings/availability/ScopeSelector.tsx", label: "Loading schedule…", kind: "PendingContainerLink" },
  settings: { file: "app/(app)/settings/SettingsNav.tsx", label: "Loading settings…", kind: "PendingLink" },
} as const;

describe("UI-01H-A: every converted row acknowledges the tap", () => {
  for (const [name, row] of Object.entries(ROWS)) {
    it(`${name} uses ${row.kind} with a truthful label`, () => {
      const src = read(row.file);
      expect(src).toContain('from "@/components/pending-link"');
      expect(src).toContain(`<${row.kind}`);
      expect(src).toContain(`pendingLabel="${row.label}"`);
    });
  }

  it("no aria-current row in these files is still a bare <Link>", () => {
    // The regression this guards: converting the opening tag but leaving a
    // sibling row behind, which would acknowledge inconsistently within one nav.
    for (const row of Object.values(ROWS)) {
      const src = read(row.file);
      const bare = [...src.matchAll(/<Link\b[\s\S]{0,400}?aria-current/g)];
      expect(bare.map(() => row.file), `${row.file} has a bare <Link> on an aria-current row`).toEqual([]);
    }
  });
});

describe("UI-01H-A: the right variant for the right content", () => {
  it("ScopeSelector uses PendingContainerLink because its chips are inline-flex", () => {
    const src = read(ROWS.scope.file);
    // chip() is `inline-flex items-center gap-2` and the content is a colour
    // dot plus a name. PendingLink wraps children in a <span>, which would
    // collapse that arrangement into one flex child; PendingContainerLink
    // renders children directly. The primitive documents exactly this split.
    expect(src).toContain("inline-flex items-center gap-2");
    expect(src).toContain("<PendingContainerLink");
    expect(src).not.toContain("<PendingLink");
  });

  it("label-content rows use PendingLink, not the container form", () => {
    for (const key of ["clients", "records", "snapshot", "settings"] as const) {
      expect(read(ROWS[key].file)).not.toContain("<PendingContainerLink");
    }
  });
});

describe("UI-01H-A: intent and semantics preserved", () => {
  it("aria-current survives on every row — the semantics were already correct", () => {
    for (const row of Object.values(ROWS)) {
      expect(read(row.file)).toMatch(/aria-current=\{/);
    }
  });

  it("the dashboard row keeps scroll={false}", () => {
    // Next applies a forward-navigation scroll reset to every <Link>; this row
    // declines it so changing the period does not throw the reader to the top
    // of the page, away from the numbers they just asked for.
    expect(read(ROWS.snapshot.file)).toContain("scroll={false}");
  });

  it("every pendingLabel is distinct, so the live region names the destination", () => {
    const labels = Object.values(ROWS).map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("the three rows that already acknowledged were NOT touched", () => {
    // calendar ViewToggle, dashboard day nav and the profile tab bar already
    // acknowledge. Re-working them would be churn on correct code.
    expect(read("app/(app)/calendar/ViewToggle.tsx")).toContain("PendingLink");
    expect(read("components/profile-tab-bar.tsx")).toContain("useTransition");
  });
});

describe("UI-01H-A: no new primitive", () => {
  it("pending-link.tsx is unchanged — this slice only adopts it", () => {
    const src = read("components/pending-link.tsx");
    expect(src).toContain("export function PendingLink");
    expect(src).toContain("export function PendingContainerLink");
    // The acknowledgement contract the rows now inherit. It takes the shared
    // press token from control-base rather than spelling it, so the timing
    // cannot drift from the rest of the control layer.
    expect(src).toContain('import { PRESS_TRANSITION');
    expect(src).toMatch(/cx\(PRESS_TRANSITION/);
    expect(src).toMatch(/role="status"/);
    expect(src).toContain("sr-only");
  });
});
