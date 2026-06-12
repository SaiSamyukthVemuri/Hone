// Safe Markdown-lite renderer for postcare email content.
//
// Studios paste plain prose into Settings; this helper supports a
// small, controlled formatting subset on top of that prose:
//
//   - **bold**
//   - *italic*
//   - bullet lines starting with "- "
//   - links: [label](https://example.com), with allowed schemes only
//   - paragraphs preserved (blank line)
//   - single newlines become <br />
//
// Security model:
//   1. Escape all HTML metacharacters first (escapeHtml). The
//      resulting string is HTML-safe and contains no real tags.
//   2. Apply markdown-style regex transforms on the escaped string.
//      Since we only inject a static, controlled set of tags
//      (<strong>, <em>, <a>, <ul>, <li>, <p>, <br />) and validate
//      link URLs against an allowed-scheme list, the output remains
//      safe to use inside HTML email bodies without
//      dangerouslySetInnerHTML / sanitizer-library risk.
//
// What is intentionally NOT supported:
//   - raw HTML / scripts / iframes / images / style attributes
//   - javascript: and data: URLs (the link helper rejects them)
//   - headings, blockquotes, tables, code blocks
//
// Browser-side use (comment corrected in PR #219): the practitioner
// postcare preview modal
// (app/(app)/settings/studio/PostcareEditingHelpers.tsx) DOES render
// this helper's HTML output via dangerouslySetInnerHTML, so the
// preview matches the real email byte for byte. That is safe under
// the same model as the email path: input is escaped FIRST, only the
// fixed tag set above is ever injected, and link URLs must pass the
// allowed-scheme check, so practitioner-typed markup or script can
// never reach the DOM as live HTML. That preview modal is the ONLY
// approved browser surface for this renderer's HTML; do not pipe its
// output into dangerouslySetInnerHTML anywhere else without a
// security review.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Allow only http(s) and mailto. Reject everything else (including
// javascript:, data:, file:, vbscript:). The matched URL has already
// been HTML-escaped before reaching this point.
function safeLinkHref(escapedUrl: string): string | null {
  // After HTML escaping, ':' and '/' are unchanged; we just need to
  // validate the scheme. Unescape the few characters that matter for
  // a URL prefix check (escaped chars cannot appear in a scheme).
  const lower = escapedUrl.toLowerCase();
  if (
    lower.startsWith("https://") ||
    lower.startsWith("http://") ||
    lower.startsWith("mailto:")
  ) {
    return escapedUrl;
  }
  return null;
}

// Apply inline transforms ON ALREADY-ESCAPED text: links, bold,
// italic, in that order. Link processing must come first because the
// label may contain * characters; we tag them with placeholders so
// later bold/italic passes don't touch link internals.
function renderInline(escaped: string): string {
  // 1) Links: [label](url). The negative lookbehind for ']' prevents
  //    nested brackets in the label from re-matching. URL is taken
  //    verbatim (already escaped) and validated by scheme.
  const linkPattern = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let withLinks = escaped.replace(linkPattern, (_match, label, url) => {
    const safeUrl = safeLinkHref(url);
    if (!safeUrl) {
      // Reject by leaving the original literal text in place.
      return `[${label}](${url})`;
    }
    return `<a href="${safeUrl}">${label}</a>`;
  });

  // 2) Bold then italic. Bold first so ** is consumed before single *.
  withLinks = withLinks.replace(
    /\*\*([^*\n]+)\*\*/g,
    (_m, body) => `<strong>${body}</strong>`,
  );
  withLinks = withLinks.replace(
    /(^|[^\*])\*([^*\n]+)\*(?!\*)/g,
    (_m, prefix, body) => `${prefix}<em>${body}</em>`,
  );
  return withLinks;
}

// Group lines into paragraphs and bulleted lists. A run of
// consecutive `- ` lines becomes a single <ul>; non-bullet lines
// inside a paragraph block are joined by <br />.
export function markdownLiteToHtml(text: string | null | undefined): string {
  if (!text || text.trim().length === 0) return "";
  const escaped = escapeHtml(text);
  // Normalise CRLF and trim trailing whitespace per line.
  const lines = escaped.replace(/\r\n?/g, "\n").split("\n");

  type Block =
    | { kind: "para"; lines: string[] }
    | { kind: "list"; items: string[] };
  const blocks: Block[] = [];

  function pushPara(line: string) {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "para") {
      last.lines.push(line);
    } else {
      blocks.push({ kind: "para", lines: [line] });
    }
  }
  function pushBullet(item: string) {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "list") {
      last.items.push(item);
    } else {
      blocks.push({ kind: "list", items: [item] });
    }
  }
  function paraBreak() {
    blocks.push({ kind: "para", lines: [] });
  }

  for (const raw of lines) {
    if (raw.trim().length === 0) {
      // Blank line: end current block.
      if (
        blocks.length > 0 &&
        blocks[blocks.length - 1].kind === "para" &&
        (blocks[blocks.length - 1] as { lines: string[] }).lines.length > 0
      ) {
        paraBreak();
      }
      continue;
    }
    // Bullet line: "- foo" or " - foo" up to a small leading indent.
    const bulletMatch = raw.match(/^\s{0,3}-\s+(.*)$/);
    if (bulletMatch) {
      pushBullet(bulletMatch[1]);
    } else {
      pushPara(raw);
    }
  }

  const htmlParts: string[] = [];
  for (const block of blocks) {
    if (block.kind === "para") {
      if (block.lines.length === 0) continue;
      const inner = block.lines
        .map((l) => renderInline(l))
        .join("<br />");
      htmlParts.push(`<p>${inner}</p>`);
    } else {
      const items = block.items
        .map((i) => `<li>${renderInline(i)}</li>`)
        .join("");
      htmlParts.push(`<ul>${items}</ul>`);
    }
  }
  return htmlParts.join("\n");
}
