"use client";

import { useRef, useState } from "react";
import { markdownLiteToHtml } from "@/lib/email/markdown-lite";

// Toolbar helpers and preview modal for the postcare editor. Both are
// co-located here so PostcareSettingsForm.tsx stays focused on field
// composition. No server actions, no I/O. Bold inserts the existing
// markdown-lite **markers** the renderer already understands; the
// preview renders the same markdown-lite to HTML using the email
// renderer, so what the practitioner sees here matches what the client
// receives.

// ---------------------------------------------------------------------------
// Markdown-lite textarea: a normal textarea with a small toolbar that
// inserts the same **bold** / "- bullet" / *italic* tokens the email
// renderer already understands. Also wires Cmd+B / Ctrl+B so a
// practitioner who is used to a doc editor never has to remember the
// asterisks.
//
// The component is controlled (value + onChange forwarded) so the
// parent form state stays the single source of truth. Programmatic
// edits dispatch a synthetic input event via the native value setter
// trick so React's onChange fires; otherwise React's value would
// override the DOM mutation on the next render.
// ---------------------------------------------------------------------------

type ToolbarTextareaProps = {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
  ariaLabel?: string;
};

// Apply a paired-wrap transform (e.g. **bold**, *italic*) around the
// current textarea selection. Toggles: if the current selection is
// already wrapped, unwrap it. Returns the new value and the cursor
// range to restore.
function applyPairedWrap(
  textarea: HTMLTextAreaElement,
  marker: string,
  placeholder: string,
): { next: string; selStart: number; selEnd: number } {
  const { selectionStart, selectionEnd, value } = textarea;
  const before = value.slice(0, selectionStart);
  const sel = value.slice(selectionStart, selectionEnd);
  const after = value.slice(selectionEnd);
  const mLen = marker.length;
  const isWrapped =
    sel.length >= mLen * 2 && sel.startsWith(marker) && sel.endsWith(marker);
  if (isWrapped) {
    const inner = sel.slice(mLen, sel.length - mLen);
    return {
      next: before + inner + after,
      selStart: before.length,
      selEnd: before.length + inner.length,
    };
  }
  const inner = sel.length > 0 ? sel : placeholder;
  return {
    next: before + marker + inner + marker + after,
    selStart: before.length + mLen,
    selEnd: before.length + mLen + inner.length,
  };
}

// Apply a per-line prefix (e.g. "- ") to each selected line. If every
// selected line already starts with the prefix, strip it (toggle).
function applyLinePrefix(
  textarea: HTMLTextAreaElement,
  prefix: string,
): { next: string; selStart: number; selEnd: number } {
  const { selectionStart, selectionEnd, value } = textarea;
  // Expand selection to whole lines so the prefix lands at column 0.
  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const nextNewline = value.indexOf("\n", selectionEnd);
  const lineEnd = nextNewline === -1 ? value.length : nextNewline;
  const before = value.slice(0, lineStart);
  const block = value.slice(lineStart, lineEnd);
  const after = value.slice(lineEnd);
  const lines = block.split("\n");
  const allPrefixed = lines.every((l) => l.startsWith(prefix));
  const newLines = allPrefixed
    ? lines.map((l) => l.slice(prefix.length))
    : lines.map((l) => prefix + l);
  const newBlock = newLines.join("\n");
  return {
    next: before + newBlock + after,
    selStart: lineStart,
    selEnd: lineStart + newBlock.length,
  };
}

// Push a mutation through the textarea so React's onChange fires.
// Without the native setter trick, React would re-render the same
// `value` prop and overwrite our DOM change on the next paint.
function commit(
  textarea: HTMLTextAreaElement,
  next: string,
  selStart: number,
  selEnd: number,
): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (setter) {
    setter.call(textarea, next);
  } else {
    textarea.value = next;
  }
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.focus();
  textarea.setSelectionRange(selStart, selEnd);
}

export function MarkdownLiteTextarea({
  value,
  onChange,
  rows = 8,
  placeholder,
  ariaLabel,
}: ToolbarTextareaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  function doBold() {
    const el = ref.current;
    if (!el) return;
    const { next, selStart, selEnd } = applyPairedWrap(el, "**", "bold text");
    commit(el, next, selStart, selEnd);
  }
  function doItalic() {
    const el = ref.current;
    if (!el) return;
    const { next, selStart, selEnd } = applyPairedWrap(el, "*", "italic text");
    commit(el, next, selStart, selEnd);
  }
  function doBullet() {
    const el = ref.current;
    if (!el) return;
    const { next, selStart, selEnd } = applyLinePrefix(el, "- ");
    commit(el, next, selStart, selEnd);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd+B on macOS, Ctrl+B elsewhere. Match the convention used by
    // every text editor a practitioner has likely seen.
    const isMod = e.metaKey || e.ctrlKey;
    if (!isMod) return;
    const key = e.key.toLowerCase();
    if (key === "b") {
      e.preventDefault();
      doBold();
    } else if (key === "i") {
      e.preventDefault();
      doItalic();
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="toolbar"
        aria-label="Formatting"
        className="flex flex-wrap items-center gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs dark:border-neutral-800 dark:bg-neutral-900"
      >
        <ToolbarButton onClick={doBold} aria-label="Bold (Cmd+B)" title="Bold (Cmd+B / Ctrl+B)">
          <strong>B</strong>
        </ToolbarButton>
        <ToolbarButton onClick={doItalic} aria-label="Italic (Cmd+I)" title="Italic (Cmd+I / Ctrl+I)">
          <em>I</em>
        </ToolbarButton>
        <ToolbarButton onClick={doBullet} aria-label="Bullet list" title="Bullet list">
          •
        </ToolbarButton>
        <span className="ml-auto text-[10px] text-neutral-500">
          Markdown-lite. Renders the same in the email.
        </span>
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        rows={rows}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-sm leading-relaxed outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
      />
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  title,
  ...rest
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex h-6 min-w-[24px] items-center justify-center rounded border border-transparent px-1.5 text-neutral-700 hover:border-neutral-300 hover:bg-white dark:text-neutral-200 dark:hover:border-neutral-700 dark:hover:bg-neutral-950"
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Preview modal. Renders an "email body" preview using the exact same
// markdownLiteToHtml renderer that produces the real postcare email.
// Inputs are the live form state passed by the parent so the preview
// always shows what a "Save and send" would render right now. No
// server roundtrip; no email is sent.
//
// Safety: markdownLiteToHtml escapes input FIRST and then injects only
// a controlled set of safe tags (strong, em, a, ul, li, p, br). The
// link helper restricts hrefs to http(s)/mailto. The practitioner is
// the input source, so this is a trusted-input render path. We still
// scope styles inside a single wrapping div and avoid any external
// network for the preview.
// ---------------------------------------------------------------------------

export type PostcarePreviewInputs = {
  studioName: string;
  contactEmail: string | null;
  ownerFallbackEmail: string;
  aftercareText: string;
  warningSignsText: string;
  productRecommendationsText: string;
  reviewUrl: string;
  reviewPromptText: string;
};

export function PostcarePreviewButton(props: PostcarePreviewInputs) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900"
        title="Preview the exact email body. Nothing is sent."
      >
        Preview email
      </button>
      {open && (
        <PostcarePreviewModal {...props} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function PostcarePreviewModal({
  studioName,
  contactEmail,
  ownerFallbackEmail,
  aftercareText,
  warningSignsText,
  productRecommendationsText,
  reviewUrl,
  reviewPromptText,
  onClose,
}: PostcarePreviewInputs & { onClose: () => void }) {
  // Resolve the Contact address the same way send-time logic does:
  // postcare_contact_email -> owner_email -> null.
  const resolvedContact =
    contactEmail && contactEmail.trim().length > 0
      ? contactEmail.trim()
      : ownerFallbackEmail.trim().length > 0
        ? ownerFallbackEmail.trim()
        : null;

  const aftercareHtml = markdownLiteToHtml(aftercareText);
  const warningHtml = markdownLiteToHtml(warningSignsText);
  const productsHtml = markdownLiteToHtml(productRecommendationsText);

  const reviewBlockHtml = reviewUrl
    ? (() => {
        const prompt =
          reviewPromptText.trim().length > 0
            ? reviewPromptText.trim()
            : "If you had a good experience, reviews help small businesses.";
        // Escape just the prompt; the URL itself is rendered via the
        // markdown-lite link form so the renderer's scheme allowlist
        // applies.
        const safePromptHtml = markdownLiteToHtml(
          `${prompt} [Leave a review](${reviewUrl})`,
        );
        return safePromptHtml;
      })()
    : "";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Postcare email preview"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-950">
        <header className="flex items-baseline justify-between gap-3 border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <div className="flex flex-col">
            <h2 className="text-sm font-medium">Postcare email preview</h2>
            <p className="text-xs text-neutral-500">
              Subject: Aftercare for your appointment with{" "}
              {studioName || "your studio"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
          >
            Close
          </button>
        </header>
        <div className="flex-1 overflow-auto px-6 py-6">
          <div className="prose prose-sm max-w-none text-neutral-900 dark:text-neutral-100">
            <p>Hi (client first name),</p>
            <p>
              Thanks for coming in. Here is what to do for the next little
              while.
            </p>
            {aftercareHtml && (
              <>
                <h3>Aftercare</h3>
                {/* Trusted input (practitioner's own text), escape-first
                    markdown-lite renderer. See PostcareEditingHelpers
                    header comment for the safety model. */}
                <div dangerouslySetInnerHTML={{ __html: aftercareHtml }} />
              </>
            )}
            {warningHtml && (
              <>
                <h3>What is not normal</h3>
                <div dangerouslySetInnerHTML={{ __html: warningHtml }} />
              </>
            )}
            {productsHtml && (
              <>
                <h3>Product recommendations</h3>
                <div dangerouslySetInnerHTML={{ __html: productsHtml }} />
              </>
            )}
            <p>
              If something feels unusual or excessive, contact{" "}
              {studioName || "your studio"} directly. This email is
              post-treatment care information, not a substitute for medical
              advice or emergency care.
            </p>
            {resolvedContact && (
              <p className="text-sm text-neutral-500">
                Contact:{" "}
                <a href={`mailto:${resolvedContact}`}>{resolvedContact}</a>
              </p>
            )}
            {reviewBlockHtml && (
              <div
                className="text-sm"
                dangerouslySetInnerHTML={{ __html: reviewBlockHtml }}
              />
            )}
          </div>
          <p className="mt-6 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-700/40 dark:bg-blue-950/30 dark:text-blue-100">
            Preview only. No email is sent. The greeting and appointment
            line are filled in automatically when you actually send
            postcare from an appointment.
          </p>
        </div>
      </div>
    </div>
  );
}
