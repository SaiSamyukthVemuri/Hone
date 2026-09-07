import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buttonClasses } from "@/components/ui/button";

// UI-01G Cluster B — the padded-but-short controls on the Client Profile.
//
// Thirteen controls shared one hand-rolled recipe: `px-3 py-1.5 · text-xs`,
// which computes to 28-30px. That is a thumb target on the surface a
// practitioner opens most, and NONE of the thirteen carried a focus indicator.
//
// This is adoption, not new design: the recipe is a duplicate of
// buttonClasses({ size: "sm" }), which already owns the 44px floor, the
// canonical focus ring, the press acknowledgement and the disabled treatment.
// Seven of the thirteen are <Link> navigation, which is exactly why
// buttonClasses is exported separately from <Button>.

const ROOT = process.cwd();
const FILES = {
  timeline: "components/client-appointment-timeline.tsx",
  plans: "components/treatment-plans-card.tsx",
  portal: "components/portal-messages-card.tsx",
} as const;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("Cluster B: the hand-rolled short recipe is gone", () => {
  for (const [name, file] of Object.entries(FILES)) {
    it(`${name} no longer spells the 28-30px recipe by hand`, () => {
      expect(
        read(file),
        "px-3 py-1.5 with text-xs computes to ~30px — under the thumb floor",
      ).not.toMatch(/px-3 py-1\.5/);
    });
  }

  it("all thirteen call sites now route through the primitive", () => {
    const sites =
      (read(FILES.timeline).match(/buttonClasses\(/g) ?? []).length +
      (read(FILES.plans).match(/<Button\b/g) ?? []).length +
      (read(FILES.portal).match(/<Button\b/g) ?? []).length;
    expect(sites).toBe(13);
  });
});

describe("Cluster B: the primitive supplies what the recipe lacked", () => {
  it("carries the 44px floor on touch and relaxes only for a fine pointer", () => {
    const cls = buttonClasses({ variant: "secondary", size: "sm" });
    expect(cls).toContain("min-h-[44px]");
    expect(cls).toContain("inline-flex"); // min-height is inert on an inline box
    expect(cls).toContain("pointer-fine:min-h-8");
    // A width breakpoint would hand a portrait iPad the compact box.
    expect(cls).not.toMatch(/\b(sm|md|lg):min-h-/);
  });

  it("adds the focus indicator these thirteen never had", () => {
    const cls = buttonClasses({ variant: "secondary", size: "sm" });
    expect(cls).toContain("focus-visible:ring-2");
    expect(cls).not.toMatch(/(^|\s)focus:/);
  });

  it("adds press acknowledgement, because :hover never fires on touch", () => {
    expect(buttonClasses({ variant: "primary", size: "sm" })).toMatch(/active:/);
    expect(buttonClasses({ variant: "secondary", size: "sm" })).toContain(
      "hone-transition-press",
    );
  });

  it("keeps the type size at 12px — density comes from the box, not the text", () => {
    expect(buttonClasses({ variant: "secondary", size: "sm" })).toContain("text-xs");
  });
});

describe("Cluster B: intent was preserved, not redesigned", () => {
  it("the timeline's filled actions stay primary and its others secondary", () => {
    const src = read(FILES.timeline);
    expect((src.match(/variant: "primary"/g) ?? []).length).toBe(3);
    expect((src.match(/variant: "secondary"/g) ?? []).length).toBe(4);
  });

  it("navigation stays <Link> — buttonClasses is why it need not become a button", () => {
    const src = read(FILES.timeline);
    expect(src).toContain("buttonClasses(");
    expect(src, "these are destinations, not actions").not.toMatch(/<Button\b/);
  });

  it("pending controls keep their busy label through the primitive", () => {
    expect(read(FILES.plans)).toMatch(/busyLabel="Saving…"/);
    expect(read(FILES.portal)).toMatch(/busyLabel="Sending…"/);
    // and the primitive composes disabled + aria-busy with it
    const prim = read("components/ui/button.tsx");
    expect(prim).toMatch(/disabled=\{disabled \|\| pending\}/);
    expect(prim).toMatch(/aria-busy=\{pending \|\| undefined\}/);
  });

  it("controls that were disabled while pending still are", () => {
    expect(read(FILES.plans)).toMatch(/disabled=\{pending\}/);
    expect(read(FILES.portal)).toMatch(/disabled=\{pending\}/);
  });

  it("no control was nested inside another interactive element", () => {
    // buttonClasses must never be applied inside another <a> or <button>:
    // an <a> inside an <a> has undefined activation behaviour.
    for (const file of Object.values(FILES)) {
      expect(read(file)).not.toMatch(/<Link[^>]*>\s*<Link/);
      expect(read(file)).not.toMatch(/<button[^>]*>\s*<button/);
    }
  });
});
