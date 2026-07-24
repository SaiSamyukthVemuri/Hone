import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const EDITOR = "components/client-personal-notes-editor.tsx";
const BULLETS = "lib/notes/bullets.ts";

describe("personal-notes bullets — editor wiring", () => {
  const e = read(EDITOR);
  it("adds an Add bullet control + explanatory copy on the personal notes textarea", () => {
    expect(e).toMatch(/Add bullet/);
    expect(e).toMatch(/Use bullets for quick things to remember/);
    expect(e).toMatch(/onClick=\{addBullet\}/);
    expect(e).toMatch(/onKeyDown=\{onNotesKeyDown\}/);
  });
  it("1/7/8) keeps the textarea UNCONTROLLED (defaultValue) — no auto-conversion, no bullets on load", () => {
    expect(e).toMatch(/name="personal_notes"[\s\S]*?defaultValue=\{initial\.personal_notes\}/);
    expect(e).toMatch(/ref=\{notesRef\}/);
  });
  it("stores PLAIN TEXT only — no HTML / contenteditable / markdown / rich-text lib", () => {
    expect(e).not.toMatch(/contentEditable|dangerouslySetInnerHTML/i);
    expect(e).not.toMatch(/react-quill|slate|tiptap|draft-js|prosemirror|remark|markdown-it/i);
  });
  it("9) does NOT touch Private warnings (no bullet wiring; still collapsed by default)", () => {
    const i = e.indexOf('name="private_warnings"');
    const pw = e.slice(i - 200, i + 300);
    expect(pw).not.toMatch(/onNotesKeyDown|notesRef|addBullet|onKeyDown/);
    expect(e).toMatch(/open=\{false\}/);
  });
  it("reuses the existing action + the 20000 max unchanged", () => {
    expect(e).toMatch(/const MAX_NOTE_LENGTH = 20000/);
    expect(e).toMatch(/<form\s+action=\{formAction\}/);
  });
});

describe("personal-notes bullets — pure logic is plain text", () => {
  it("only emits a plain '• ' marker; no HTML anywhere", () => {
    const b = read(BULLETS);
    expect(b).toMatch(/export const BULLET = "• "/);
    expect(b).not.toMatch(/innerHTML|&nbsp;|<[a-z]/i);
  });
});
