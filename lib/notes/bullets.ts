// Plain-text bullet helpers for the Personal Notes textarea. NO HTML, no
// Markdown, no rich text: the value stays exactly the plain text the practitioner
// sees and the existing action stores. Pure functions (no DOM) so the keyboard
// contract is unit-testable; the editor applies the result to an UNCONTROLLED
// textarea via a ref, so existing saved notes are never auto-converted.

export const BULLET = "• "; // "• "

type Edit = { value: string; cursor: number };

function lineStart(value: string, pos: number): number {
  const nl = value.lastIndexOf("\n", pos - 1);
  return nl === -1 ? 0 : nl + 1;
}

function currentLine(value: string, pos: number): { ls: number; le: number; line: string } {
  const ls = lineStart(value, pos);
  let le = value.indexOf("\n", pos);
  if (le === -1) le = value.length;
  return { ls, le, line: value.slice(ls, le) };
}

// "Add bullet": insert "• " at the START of the current line. Returns null (no
// change) if the line is already bulleted or if it would exceed maxLength.
export function insertBullet(
  value: string,
  selStart: number,
  maxLength: number,
): Edit | null {
  const ls = lineStart(value, selStart);
  if (value.startsWith(BULLET, ls)) return null; // never double-bullet
  if (value.length + BULLET.length > maxLength) return null;
  return {
    value: value.slice(0, ls) + BULLET + value.slice(ls),
    cursor: selStart + BULLET.length, // cursor moves with the inserted text
  };
}

// Enter inside a bulleted line: continue with a new "• ", OR: on an EMPTY bullet
// (the whole line is just "• "), exit bullet mode by removing the marker. Returns
// null to let the browser insert a normal newline (non-bullet line, or overflow).
export function bulletEnter(
  value: string,
  selStart: number,
  maxLength: number,
): Edit | null {
  const { ls, le, line } = currentLine(value, selStart);
  if (!line.startsWith(BULLET)) return null;
  if (line === BULLET) {
    // empty bullet -> exit: drop the marker, leaving a plain empty line.
    return { value: value.slice(0, ls) + value.slice(le), cursor: ls };
  }
  if (value.length + 1 + BULLET.length > maxLength) return null; // would overflow
  return {
    value: value.slice(0, selStart) + "\n" + BULLET + value.slice(selStart),
    cursor: selStart + 1 + BULLET.length,
  };
}

// Backspace at the beginning of an EMPTY bullet (cursor right after "• " on a line
// that is only "• "): remove the marker. Otherwise null (normal backspace).
export function bulletBackspace(value: string, selStart: number): Edit | null {
  const { ls, le, line } = currentLine(value, selStart);
  if (line === BULLET && selStart === ls + BULLET.length) {
    return { value: value.slice(0, ls) + value.slice(le), cursor: ls };
  }
  return null;
}
