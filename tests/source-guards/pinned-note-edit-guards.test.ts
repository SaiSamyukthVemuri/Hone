import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Source guards for editing a mutable pinned client note (client_pinned_notes —
// an operational reminder, NOT the append-only immutable client_clinical_notes).
// These pin the safety contract the DB test can't see: the edit is an in-place
// UPDATE (never delete+recreate), authorized from the session, tenant-scoped, and
// mutates ONLY the text.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
// Strip comments so assertions test CODE, not the safety prose in the comments.
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const ACTIONS = "app/(app)/clients/[id]/pinned-notes-actions.ts";
const CARD = "components/client-pinned-notes-card.tsx";
const PAGE = "app/(app)/clients/[id]/page.tsx";

// The edit action body only (between its declaration and the next action).
function editBody(): string {
  const src = code(ACTIONS);
  const from = src.indexOf("editClientPinnedNoteAction");
  const to = src.indexOf("removeClientPinnedNoteAction");
  return src.slice(from, to);
}

describe("pinned-note edit — server action contract", () => {
  it("exports editClientPinnedNoteAction", () => {
    expect(code(ACTIONS)).toMatch(/export async function editClientPinnedNoteAction/);
  });

  it("authorizes from the SESSION (getCurrentPractitionerWithStudio), never the form studio", () => {
    expect(editBody()).toMatch(/const \{ studio \} = await getCurrentPractitionerWithStudio\(\)/);
  });

  it("is an in-place UPDATE scoped to id + the authed studio + client (tenant isolation, no delete+recreate)", () => {
    const b = editBody();
    expect(b).toMatch(/\.update\(\{\s*text\s*\}\)/);
    expect(b).toMatch(/\.eq\("id", noteId\)/);
    expect(b).toMatch(/\.eq\("studio_id", studio\.id\)/);
    expect(b).toMatch(/\.eq\("client_id", clientId\)/);
    // never inserts or deletes on the edit path → no duplicates, pinned state kept
    expect(b).not.toMatch(/\.insert\(/);
    expect(b).not.toMatch(/\.delete\(/);
  });

  it("mutates ONLY text — never id / created_by / created_at / studio_id / client_id", () => {
    const b = editBody();
    for (const forbidden of ["created_", "studio_id", "client_id", "\\bid\\b"]) {
      expect(b).not.toMatch(new RegExp(`\\.update\\(\\{[^}]*${forbidden}`));
    }
  });

  it("rejects empty text and over-length before touching the DB", () => {
    const b = editBody();
    expect(b).toMatch(/if \(!text\) throw/);
    expect(b).toMatch(/MAX_PINNED_NOTE_LENGTH/);
  });

  it("optimistic concurrency: validates original_text and guards the UPDATE on the note's current text", () => {
    const b = editBody();
    expect(b).toMatch(/const originalText = trimmedString\(formData\.get\("original_text"\)\)/);
    expect(b).toMatch(/if \(!originalText\) throw/);
    expect(b).toMatch(/\.eq\("text", originalText\)/); // CAS: only lands if unchanged
  });

  it("rejects a raced / stale / deleted / foreign note with ONE fixed safe message (no raw DB leak)", () => {
    const b = editBody();
    expect(b).toMatch(
      /That note changed or is no longer available\. Refresh and try again\./,
    );
    expect(b).toMatch(/if \(error\) throw new Error\("Could not update the note\. Please try again\."\)/);
    expect(b).not.toMatch(/error\.message/); // edit path never surfaces raw DB text
  });
});

describe("pinned-note edit — UI wiring", () => {
  it("the card exposes an Edit control + an inline editor pre-filled with the current text", () => {
    const c = read(CARD);
    expect(c).toMatch(/editAction/);
    expect(c).toMatch(/aria-label="Edit pinned note"/);
    expect(c).toMatch(/setEditText\(note\.text\)/); // pre-fill
    expect(c).toMatch(/autoFocus/);
  });

  it("cancel restores without saving (cancelEdit never calls editAction)", () => {
    const c = read(CARD);
    const cancel = c.slice(c.indexOf("function cancelEdit"), c.indexOf("function submitEdit"));
    expect(cancel).not.toMatch(/editAction|FormData/);
  });

  it("submit is disabled while pending or empty (duplicate-submit + empty guard)", () => {
    const c = read(CARD);
    expect(c).toMatch(/disabled=\{pending \|\| editText\.trim\(\)\.length === 0\}/);
  });

  it("the client profile passes editAction to the card", () => {
    const p = read(PAGE);
    expect(p).toMatch(/editAction=\{editClientPinnedNoteAction\}/);
  });
});
