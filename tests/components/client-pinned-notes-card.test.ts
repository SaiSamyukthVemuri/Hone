import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ClientPinnedNotesCard,
  MAX_LENGTH,
  PinnedNoteField,
  pinnedNotePermissions,
  toSingleLine,
} from "@/components/client-pinned-notes-card";
import { PinnedNotesReadonly } from "@/components/pinned-notes-readonly";
import type { ClientPinnedNote } from "@/lib/types/database";

// HON-9: the FULL pinned note is readable in place. The read surfaces already
// wrapped (dashboard roster, client card); the edit and add fields were a
// single-line <input> that scrolled a 200-character note sideways inside one
// line, and the appointment page's read-only list could be pushed sideways by a
// long unbroken note. The unit lane is node + static markup (no click-through);
// auto-grow and the keyboard path are proved in e2e/pinned-note-edit-mobile.

const LONG = `${"Allergic to lidocaine, prefers the right side first, numbs easily on the upper lip; ".repeat(3)}`.slice(0, MAX_LENGTH);

function note(text: string, id = "note-1"): ClientPinnedNote {
  return { id, text } as unknown as ClientPinnedNote;
}

const noop = async () => undefined;

describe("PinnedNoteField: the whole note is visible while editing", () => {
  const html = renderToStaticMarkup(
    createElement(PinnedNoteField, { value: LONG, onChange: () => undefined, onEnter: () => undefined, ariaLabel: "Edit pinned note" }),
  );

  it("is a wrapping textarea, never a single-line text input", () => {
    expect(html).toContain("<textarea");
    expect(html).not.toMatch(/<input[^>]*type="text"/);
    expect(html).toMatch(/class="[^"]*whitespace-pre-wrap[^"]*break-words/);
    expect(html).toMatch(/class="[^"]*resize-none[^"]*overflow-hidden/);
  });

  it("holds the ENTIRE 200-character note as its content", () => {
    expect(LONG).toHaveLength(MAX_LENGTH);
    expect(html).toContain(LONG.replace(/&/g, "&amp;").replace(/</g, "&lt;"));
  });

  it("keeps the 200-character limit and shows a live counter", () => {
    expect(html).toContain(`maxLength="${MAX_LENGTH}"`);
    expect(html.replace(/<!-- -->/g, "")).toContain(`>${MAX_LENGTH}/${MAX_LENGTH}<`);
    expect(html).toContain('aria-live="polite"');
  });

  it("is labelled for assistive technology", () => {
    expect(html).toContain('aria-label="Edit pinned note"');
  });
});

describe("toSingleLine: no newline is ever introduced (Enter still saves)", () => {
  for (const [why, input, want] of [
    ["LF", "a\nb", "a b"],
    ["CRLF", "a\r\nb", "a b"],
    ["CR", "a\rb", "a b"],
    ["several", "a\n\nb\nc", "a  b c"],
    ["none", "plain note", "plain note"],
  ] as const) {
    it(`${why}: ${JSON.stringify(input)} becomes ${JSON.stringify(want)}`, () => {
      expect(toSingleLine(input)).toBe(want);
    });
  }
});

describe("ClientPinnedNotesCard: read and add surfaces", () => {
  const html = renderToStaticMarkup(
    createElement(ClientPinnedNotesCard, { clientId: "client-1", viewer: { isOwner: true, practitionerId: "owner-1" }, notes: [note(LONG)], addAction: noop, editAction: noop, removeAction: noop }),
  );

  it("shows the full note text, wrapped, in the list", () => {
    expect(html).toContain(LONG);
    expect(html).toMatch(/class="[^"]*min-w-0[^"]*whitespace-pre-wrap[^"]*break-words/);
  });

  it("the add box is the wrapping field too, not a single-line input", () => {
    expect(html).toContain('aria-label="New pinned note"');
    expect(html).not.toMatch(/<input[^>]*type="text"/);
  });
});

describe("HON-44: the Edit and Remove controls follow the role and the author (the server and 0254 enforce the same rule)", () => {
  const authored = (by: string | null): ClientPinnedNote =>
    ({ id: "n", text: "Latex allergy", created_by_practitioner_id: by }) as unknown as ClientPinnedNote;
  const render = (viewer: { isOwner: boolean; practitionerId: string }, n: ClientPinnedNote) =>
    renderToStaticMarkup(
      createElement(ClientPinnedNotesCard, { clientId: "c", viewer, notes: [n], addAction: noop, editAction: noop, removeAction: noop }),
    );

  it("pinnedNotePermissions: owner edits and removes any; a practitioner edits only their own and removes none", () => {
    const owner = { isOwner: true, practitionerId: "o" };
    const prac = { isOwner: false, practitionerId: "p" };
    expect(pinnedNotePermissions(authored("p"), owner)).toEqual({ canEdit: true, canRemove: true });
    expect(pinnedNotePermissions(authored("someone-else"), owner)).toEqual({ canEdit: true, canRemove: true });
    expect(pinnedNotePermissions(authored(null), owner)).toEqual({ canEdit: true, canRemove: true });
    expect(pinnedNotePermissions(authored("p"), prac)).toEqual({ canEdit: true, canRemove: false });
    expect(pinnedNotePermissions(authored("someone-else"), prac)).toEqual({ canEdit: false, canRemove: false });
    expect(pinnedNotePermissions(authored(null), prac)).toEqual({ canEdit: false, canRemove: false });
  });

  it("a practitioner sees Edit on their own caution and never Remove", () => {
    const html = render({ isOwner: false, practitionerId: "p" }, authored("p"));
    expect(html).toContain('aria-label="Edit pinned note"');
    expect(html).not.toContain('aria-label="Remove pinned note"');
  });

  it("a practitioner sees neither control on a colleague's or a legacy caution, but can still read and add", () => {
    for (const by of ["someone-else", null]) {
      const html = render({ isOwner: false, practitionerId: "p" }, authored(by));
      expect(html).toContain("Latex allergy");
      expect(html).not.toContain('aria-label="Edit pinned note"');
      expect(html).not.toContain('aria-label="Remove pinned note"');
      expect(html).toContain('aria-label="New pinned note"');
    }
  });

  it("the owner sees both controls on every caution", () => {
    for (const by of ["p", "someone-else", null]) {
      const html = render({ isOwner: true, practitionerId: "o" }, authored(by));
      expect(html).toContain('aria-label="Edit pinned note"');
      expect(html).toContain('aria-label="Remove pinned note"');
    }
  });
});

describe("PinnedNotesReadonly: a long unbroken note wraps instead of pushing the page sideways", () => {
  const unbroken = "x".repeat(MAX_LENGTH);
  const html = renderToStaticMarkup(createElement(PinnedNotesReadonly, { notes: [note(unbroken)] }));

  it("each note can break inside a word and shrink below its content width", () => {
    expect(html).toContain(unbroken);
    expect(html).toMatch(/<li[^>]*class="[^"]*min-w-0[^"]*whitespace-pre-wrap[^"]*break-words/);
    expect(html).toMatch(/<ul[^>]*class="[^"]*min-w-0/);
  });

  it("renders nothing when there are no notes (unchanged)", () => {
    expect(renderToStaticMarkup(createElement(PinnedNotesReadonly, { notes: [] }))).toBe("");
  });
});

describe("auto-height fits the whole note (source pins; layout is proved in e2e)", () => {
  // The unit lane cannot measure layout, so the two sizing rules are pinned in
  // the source; e2e/pinned-note-edit-mobile measures scrollHeight vs clientHeight.
  const src = readFileSync(path.resolve(__dirname, "../../components/client-pinned-notes-card.tsx"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  it("adds the top and bottom borders to scrollHeight (border-box), so the last line is not clipped (Codex P2 4301103594)", () => {
    expect(code).toMatch(/borderTopWidth/);
    expect(code).toMatch(/borderBottomWidth/);
    expect(code).toMatch(/el\.scrollHeight \+ borders/);
  });

  it("re-fits when the field's WIDTH changes, not only when the text does (Codex P2 4301103599)", () => {
    expect(code).toMatch(/new ResizeObserver\(/);
    expect(code).toMatch(/ro\.observe\(el\)/);
    expect(code).toMatch(/ro\.disconnect\(\)/);
  });
});
