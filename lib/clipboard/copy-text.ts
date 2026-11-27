// HON-124 item 11. One way to copy text to the clipboard, so every copy control answers the same way.
//
// Returns true ONLY after the browser reports the write succeeded. It never throws: a missing clipboard API (an insecure context or an old
// browser makes `navigator.clipboard` undefined, and calling `.writeText` on it throws synchronously, which a `.then(ok, fail)` chain does
// NOT catch), a permission refusal and a rejected promise all come back as false, so the caller can say so and offer the text to select.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard || typeof navigator.clipboard.writeText !== "function") return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Select every character of an element (the select-the-text fallback after a failed copy). Returns false when it cannot. */
export function selectElementText(el: HTMLElement | null): boolean {
  if (!el) return false;
  try {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      el.select();
      return true;
    }
    const sel = window.getSelection();
    if (!sel) return false;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  } catch {
    return false;
  }
}

export const COPY_FAILED_MESSAGE = "Couldn’t copy. The text is selected: press and hold, or use your keyboard, to copy it.";
