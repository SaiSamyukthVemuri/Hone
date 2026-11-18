import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #197 (Chloe round-3 polish): saved response notes are preserved.
const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const FORM = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");

describe("4. one free-text box in charting", () => {
  it("response-notes textarea only renders for existing saved notes (data preserved)", () => {
    expect(FORM).toMatch(/\{draft\.reactionNotes\.trim\(\) !== "" && \(/);
    expect(FORM).toMatch(/reactionNotes: draft\.reactionNotes\.trim\(\) \|\| null/);
  });
});
