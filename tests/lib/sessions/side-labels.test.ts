import { describe, expect, it } from "vitest";
import {
  SESSION_BLOCK_SIDE_OPTIONS,
  sessionBlockSideLabel,
} from "@/lib/sessions/side-labels";

// PR #162. Chloe asked whether "Bilateral" meant "both sides" while
// charting a real session. The stored enum value MUST stay
// "bilateral" because migration 0039 + server validation pin it; only
// the display label changes. These tests pin both halves of that
// contract so a future refactor cannot drift them apart.

describe("SESSION_BLOCK_SIDE_OPTIONS pins the five canonical values", () => {
  it("carries exactly five options in canonical order", () => {
    expect(SESSION_BLOCK_SIDE_OPTIONS.map((o) => o.value)).toEqual([
      "center",
      "left",
      "right",
      "bilateral",
      "n/a",
    ]);
  });

  it("bilateral renders as 'Both sides' (Chloe's ask)", () => {
    const bilateral = SESSION_BLOCK_SIDE_OPTIONS.find(
      (o) => o.value === "bilateral",
    );
    expect(bilateral).toBeDefined();
    expect(bilateral?.label).toBe("Both sides");
    // The prior "Bilateral" copy must NOT appear as a label.
    for (const opt of SESSION_BLOCK_SIDE_OPTIONS) {
      expect(opt.label).not.toBe("Bilateral");
    }
  });

  it("the other four labels are unchanged", () => {
    const byValue = new Map(
      SESSION_BLOCK_SIDE_OPTIONS.map((o) => [o.value, o.label] as const),
    );
    expect(byValue.get("center")).toBe("Center");
    expect(byValue.get("left")).toBe("Left");
    expect(byValue.get("right")).toBe("Right");
    expect(byValue.get("n/a")).toBe("n/a");
  });
});

describe("sessionBlockSideLabel maps stored values to user-facing labels", () => {
  it("maps bilateral -> Both sides", () => {
    expect(sessionBlockSideLabel("bilateral")).toBe("Both sides");
  });

  it("returns the canonical Title-case label for the other values", () => {
    expect(sessionBlockSideLabel("center")).toBe("Center");
    expect(sessionBlockSideLabel("left")).toBe("Left");
    expect(sessionBlockSideLabel("right")).toBe("Right");
    expect(sessionBlockSideLabel("n/a")).toBe("n/a");
  });

  it("returns null for null / undefined", () => {
    expect(sessionBlockSideLabel(null)).toBeNull();
    expect(sessionBlockSideLabel(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Source-grep: the internal "bilateral" value must remain in:
//   * server validation array in block-actions.ts
//   * TypeScript SessionBlockSide union in lib/types/database.ts
//   * migration 0039 CHECK constraint (immutable history)
// A future refactor that renames the stored value would silently
// break every existing session block row.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

describe("internal 'bilateral' value is unchanged", () => {
  it("server validation in block-actions.ts still accepts bilateral", () => {
    const text = readFileSync(
      path.join(
        REPO_ROOT,
        "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
      ),
      "utf8",
    );
    expect(text).toMatch(/"bilateral"/);
  });

  it("lib/types/database.ts SessionBlockSide union still includes bilateral", () => {
    const text = readFileSync(
      path.join(REPO_ROOT, "lib/types/database.ts"),
      "utf8",
    );
    expect(text).toMatch(/\|\s*"bilateral"/);
  });

  it("migration 0039 CHECK constraint still pins bilateral", () => {
    const text = readFileSync(
      path.join(
        REPO_ROOT,
        "supabase/migrations/0039_session_block_structured_area.sql",
      ),
      "utf8",
    );
    expect(text).toMatch(/'bilateral'/);
  });
});

// ---------------------------------------------------------------------------
// The setup-form and the read-only blocks view both consume the
// shared helper. Pin the imports + usage so a future PR cannot
// reintroduce a local SIDE_OPTIONS array that drifts from the
// canonical labels (which is exactly how the "Bilateral" copy
// survived for so long).
// ---------------------------------------------------------------------------

describe("charting surfaces consume the shared side-labels helper", () => {
  it("block-setup-form imports SESSION_BLOCK_SIDE_OPTIONS from the shared helper", () => {
    const text = readFileSync(
      path.join(
        REPO_ROOT,
        "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
      ),
      "utf8",
    );
    expect(text).toMatch(
      /import \{ SESSION_BLOCK_SIDE_OPTIONS \} from "@\/lib\/sessions\/side-labels"/,
    );
    // The local hardcoded SIDE_OPTIONS array (with "Bilateral") must
    // be gone. Only the alias `const SIDE_OPTIONS = SESSION_BLOCK_SIDE_OPTIONS;`
    // remains.
    expect(text).not.toMatch(
      /\{\s*value:\s*"bilateral",\s*label:\s*"Bilateral"\s*\}/,
    );
  });

  it("session-blocks-view uses sessionBlockSideLabel for block.side rendering", () => {
    const text = readFileSync(
      path.join(
        REPO_ROOT,
        "app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx",
      ),
      "utf8",
    );
    expect(text).toMatch(
      /import \{ sessionBlockSideLabel \} from "@\/lib\/sessions\/side-labels"/,
    );
    expect(text).toMatch(/sessionBlockSideLabel\(block\.side\)/);
    // Prior shape pushed block.side raw; that path must be gone so a
    // saved record with side='bilateral' no longer prints lowercase
    // "bilateral" in the read view.
    expect(text).not.toMatch(/extras\.push\(block\.side\)/);
  });
});
