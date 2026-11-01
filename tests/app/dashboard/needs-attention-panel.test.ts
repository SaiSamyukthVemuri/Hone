import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NEEDS_ATTENTION_COMPACT_COUNT } from "@/app/(app)/dashboard/needs-attention-panel";

// HON-65 shared UI lesson, applied to the Needs Attention panel: no anchor
// jumps, state and focus preserved, nothing that writes. These are source
// guards; the real click journey (expand with the keyboard, focus stays on the
// toggle, phone width) is a browser proof owned by Photos and is not claimed here.

const SRC = readFileSync(
  join(process.cwd(), "app/(app)/dashboard/needs-attention-panel.tsx"),
  "utf8",
);

describe("Needs Attention panel interaction contract", () => {
  it("the disclosure is a real button, not an anchor or hash link", () => {
    expect(SRC).toMatch(/<button\s+type="button"/);
    expect(SRC).not.toMatch(/href="#/);
    expect(SRC).not.toMatch(/href=\{`#/);
  });

  it("expanding never scrolls or moves focus programmatically", () => {
    expect(SRC).not.toMatch(/scrollIntoView|scrollTo\(|\.focus\(|window\.location|router\./);
  });

  it("the toggle states what it controls and whether it is open", () => {
    expect(SRC).toContain("aria-expanded={expanded}");
    expect(SRC).toContain('aria-controls="needs-attention-list"');
    expect(SRC).toContain('id="needs-attention-list"');
  });

  it("rows are keyed by the domain id so expanding keeps existing rows mounted", () => {
    expect(SRC).toContain("key={entry.id}");
  });

  it("opening an item is navigation only: the panel carries no write", () => {
    expect(SRC).not.toMatch(/use server|formAction|<form|fetch\(|\.rpc\(|\.from\(/);
  });

  it("starts compact", () => {
    expect(NEEDS_ATTENTION_COMPACT_COUNT).toBe(6);
  });
});
