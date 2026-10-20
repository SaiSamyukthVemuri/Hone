import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buttonClasses } from "@/components/ui/button";

// UI-01J — the treatment-images surface reaches the touch floor.
//
// MEASURED recipes on this file before the slice (probe at 390px, touch):
//   bare text-xs, no padding ..... 16px   edit-note trigger, View larger, Archive
//   px-3 py-1  text-xs ........... 24px   save note, cancel note
//   px-3 py-1  text-sm ........... 28px   Close preview
//   px-4 py-2  text-sm ........... 36px   Attach image (upload submit)
//
// Archive is the sharpest: it hides a clinical photo, and it was a 16px
// underline with no focus indicator anywhere in the file.

const ROOT = process.cwd();
const FILE = "app/(app)/clients/[id]/images/TreatmentImagesManager.tsx";
const read = () => readFileSync(join(ROOT, FILE), "utf8");

describe("UI-01J: the seven short controls are on the primitive", () => {
  it("converts exactly seven call sites", () => {
    const src = read();
    expect((src.match(/<Button\b/g) ?? []).length).toBe(7);
    expect((src.match(/<\/Button>/g) ?? []).length).toBe(7);
  });

  it("leaves no hand-rolled short recipe behind", () => {
    const src = read();
    expect(src).not.toMatch(/px-3 py-1\b(?![.\d])/);
    expect(src).not.toMatch(/className="rounded-md bg-neutral-900 px-4 py-2/);
    expect(src).not.toMatch(/className="text-neutral-500 underline/);
  });

  it("the file no longer declares a focus indicator of its own", () => {
    // It had none before; the converted controls now inherit the canonical
    // ring rather than any call site re-declaring one.
    expect(read()).not.toMatch(/focus-visible:/);
    expect(read()).not.toMatch(/outline-none/);
  });
});

describe("UI-01J: the thumbnail wrapper is deliberately NOT converted", () => {
  it("keeps its plain <button> around the <img>", () => {
    const src = read();
    // This is the one remaining raw button, and that is correct: it wraps an
    // <img> and is already as large as the photo. Button composes
    // `inline-flex items-center justify-center min-h-[44px] rounded-md
    // font-medium` plus a variant fill — applying it here would visibly break
    // the photo grid for no accessibility gain.
    // Production's recovery integration owns the thumbnail wrapper in
    // GridPhoto; keep the manager free of raw short buttons without reverting it.
    expect((src.match(/<button\b/g) ?? []).length).toBe(0);
    const cell = readFileSync(join(ROOT, "app/(app)/clients/[id]/images/GridPhoto.tsx"), "utf8");
    expect((cell.match(/<button\b/g) ?? []).length).toBe(1);
    expect(cell).toMatch(/className="block overflow-hidden rounded-md"/);
    expect(cell).toMatch(/aria-label="View larger treatment photo"/);
  });
});

describe("UI-01J: the primitive supplies what the recipes lacked", () => {
  it("every variant used carries the floor and the canonical ring", () => {
    for (const variant of ["primary", "secondary", "quiet"] as const) {
      for (const size of ["sm", "md"] as const) {
        const cls = buttonClasses({ variant, size });
        expect(cls).toContain("min-h-[44px]");
        expect(cls).toContain("inline-flex");
        expect(cls).toContain("focus-visible:ring-2");
        expect(cls).not.toMatch(/(^|\s)focus:/);
      }
    }
  });
});

describe("UI-01J: intent and behaviour preserved", () => {
  it("Archive reports in-flight through the primitive, per image", () => {
    const src = read();
    // `busyId === img.id` is per-row, so only the photo being archived shows
    // busy — the whole grid does not freeze.
    expect(src).toMatch(/pending=\{busyId === img\.id\}/);
    expect(src).toMatch(/busyLabel="Archiving…"/);
  });

  it("the upload submit keeps its count-aware label AND gains a busy label", () => {
    const src = read();
    expect(src).toMatch(/busyLabel="Uploading…"/);
    // The three-way label survives as children; busyLabel only replaces it
    // while the upload is in flight.
    expect(src).toMatch(/Attach \$\{selectedFiles\.length\} images/);
    expect(src).toMatch(/"Attach image"/);
    // It stays a submit, so the form still submits on Enter.
    expect(src).toMatch(/type="submit"/);
    // Disabled now expresses only the real precondition; `uploading` moved to
    // `pending`, which the primitive folds into disabled + aria-busy.
    expect(src).toMatch(/disabled=\{selectedFiles\.length === 0\}/);
  });

  it("note save/cancel keep their emphasis and their pending gate", () => {
    const src = read();
    expect(src).toMatch(/variant="primary"[\s\S]{0,120}busyLabel="Saving…"/);
    expect(src).toMatch(/variant="secondary"[\s\S]{0,80}disabled=\{pending\}/);
  });

  it("the two text actions keep their underline affordance", () => {
    // `underline` is additive, which control-base documents as safe through
    // className; colour and padding are not.
    expect((read().match(/className="underline"/g) ?? []).length).toBe(2);
  });

  it("the close-preview control keeps its accessible name and shrink-0", () => {
    const src = read();
    expect(src).toMatch(/aria-label="Close preview"/);
    expect(src).toMatch(/className="shrink-0"/);
  });
});

describe("UI-01J: no new primitive", () => {
  it("components/ui/button.tsx is imported, not altered", () => {
    const prim = readFileSync(join(ROOT, "components/ui/button.tsx"), "utf8");
    expect(prim).toContain("export function Button");
    expect(prim).toMatch(/disabled=\{disabled \|\| pending\}/);
    expect(prim).toMatch(/aria-busy=\{pending \|\| undefined\}/);
  });
});

// The non-Button controls on the same surface (FETT photos gap 1, #892): the
// file picker, the attach-as radios and the session / treatment-area selects.
// MEASURED before by class only: picker ~36px, radio rows ~20px, selects ~38px.
// A min-height does nothing on an inline box, so the picker needs inline-flex.
describe("FETT photos: the remaining photo controls reach the floor", () => {
  it("the 'Choose images' file picker is a 44px inline-flex target", () => {
    const src = read();
    const picker = src.match(/<label className="([^"]*)">\s*Choose images/);
    expect(picker, "the picker label").toBeTruthy();
    const cls = (picker as RegExpMatchArray)[1];
    expect(cls).toContain("min-h-[44px]");
    expect(cls).toContain("inline-flex");
    expect(cls).toContain("items-center");
  });

  it("each attach-as radio row is a 44px flex target", () => {
    const src = read();
    const row = src.match(/<label\s+key=\{value\}\s+className="([^"]*)"/);
    expect(row, "the radio row label").toBeTruthy();
    const cls = (row as RegExpMatchArray)[1];
    expect(cls).toContain("min-h-[44px]");
    expect(cls).toMatch(/(^|\s)flex(\s|$)/);
  });

  it("both the session and the treatment-area selects carry the floor", () => {
    const selects = [...read().matchAll(/<select[\s\S]*?className="([^"]*)"/g)].map((m) => m[1]);
    expect(selects).toHaveLength(2);
    for (const cls of selects) expect(cls).toContain("min-h-[44px]");
  });
});
