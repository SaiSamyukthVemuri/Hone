import { readFileSync } from "node:fs";
import { join } from "node:path";

// PERF-01C — the Dashboard's source, as it RENDERS.
//
// WHY THIS EXISTS
// ---------------
// The dashboard used to be one file, and a dozen guards assert product
// decisions by reading it as text: Today comes before To do, To do before
// Birthdays, the snapshot is demoted below both, the booking card is gated on
// derived readiness, buildDashboardTodo is called exactly once. Those
// assertions are about the ORDER AND CONTENT OF WHAT RENDERS.
//
// PERF-01C moved the secondary stack — To do, Birthdays, the practice
// snapshot, the setup cards — into `secondary-stack.tsx` so the day's roster no
// longer waits on studio paperwork. The render order did not change. Only the
// file boundary did.
//
// A guard that kept reading `page.tsx` alone would now be asserting over half
// the page, and would go green for the wrong reason the moment a moved card
// disappeared. So this helper reconstructs the composed source by splicing the
// child's file in AT THE POINT THE CHILD RENDERS — the <Suspense> block — which
// is exactly where its markup appears in the output.
//
// This is deliberately NOT a weakening. Every ordering assertion keeps its
// meaning, because the splice preserves position; and the splice itself throws
// if the boundary is ever renamed or removed, so the guards can never
// silently degrade into reading one file again.

const PAGE_PATH = "app/(app)/dashboard/page.tsx";
const STACK_PATH = "app/(app)/dashboard/secondary-stack.tsx";

/**
 * The <Suspense> element that stands where the secondary stack renders.
 *
 * Matched by SHAPE, not by an exact string: the boundary carries a `key` (see
 * the page for why that key is load-bearing) and is formatted across several
 * lines, so pinning its literal text made this helper throw the moment the key
 * was added. The opening tag is located by its `fallback` prop, which is the
 * part that identifies it.
 */
const BOUNDARY_OPEN_RE = /<Suspense\b[\s\S]*?fallback=\{<SecondaryStackSkeleton \/>\}[\s\S]*?>/;
const BOUNDARY_CLOSE = "</Suspense>";

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

export const DASHBOARD_PAGE_SRC = read(PAGE_PATH);
export const SECONDARY_STACK_SRC = read(STACK_PATH);

/**
 * `page.tsx` with the <Suspense> boundary replaced by the streamed child's
 * source, so text order matches render order.
 */
export function composedDashboardSource(): string {
  const src = DASHBOARD_PAGE_SRC;
  const match = BOUNDARY_OPEN_RE.exec(src);
  const open = match ? match.index : -1;
  if (!match) {
    throw new Error(
      `composed-dashboard: boundary not found in ${PAGE_PATH}. ` +
        `If the Suspense boundary was renamed or removed, update this helper ` +
        `deliberately — do not let the hierarchy guards fall back to reading ` +
        `half the page.`,
    );
  }
  const close = src.indexOf(BOUNDARY_CLOSE, open + match[0].length);
  if (close < 0) {
    throw new Error("composed-dashboard: unterminated Suspense boundary");
  }
  return (
    src.slice(0, open) +
    SECONDARY_STACK_SRC +
    src.slice(close + BOUNDARY_CLOSE.length)
  );
}

export const COMPOSED_DASHBOARD = composedDashboardSource();
