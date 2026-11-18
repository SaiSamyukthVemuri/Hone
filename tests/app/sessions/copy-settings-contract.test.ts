import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-guard: the in-form "Copy settings" control is a CLIENT-SIDE draft
// prefill that assigns no destination area identity and no outcome field, and
// a copied probe lot is NEVER marked confirmed.

const ROOT = process.cwd();
const FORM = readFileSync(
  join(ROOT, "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx"),
  "utf8",
);

describe("in-form Copy settings is a setup-only prefill", () => {
  it("copySettings assigns no destination area identity and no outcome of its own", () => {
    // Isolate the copySettings function body.
    const start = FORM.indexOf("function copySettings()");
    const body = FORM.slice(start, FORM.indexOf("\n  }", start));
    // NOTE ON THE PROBE LOT. `probeLotNumber:` / `probeLotConfirmed:` are listed
    // here because copySettings must not hand-roll them — but that is NOT a
    // claim that the lot is never copied. The shared PATCH owns all three lot
    // keys and does copy the number and (conditionally) the inventory link; see
    // the dedicated truthfulness suite below. This assertion is only that the
    // form has no second, divergent copy path of its own.
    for (const forbidden of [
      "primaryArea:",
      "side:",
      "customAreaDetail:",
      "areas:",
      "probeLotNumber:",
      "probeLotConfirmed:",
      "hairsTreated:",
      "comments:",
      "observationChips:",
      "toleranceRating:",
      "reactionType:",
      "numbingStatus:",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("the UI still tells the practitioner to confirm a copied lot", () => {
    // If the lot is replaced, the confirmation prompt is the safety net; losing
    // it would turn a helpful copy into a silent traceability claim.
    expect(FORM).toMatch(/lotStatus/);
    expect(FORM).toMatch(/"copied"/);
  });
});
