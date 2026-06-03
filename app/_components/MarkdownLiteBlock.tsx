import { Fragment, type ReactNode } from "react";

// Generic React-only markdown-lite renderer for portal-side surfaces
// (and any other place that needs to show studio-authored text
// safely without dangerouslySetInnerHTML). Parses the same subset
// lib/email/markdown-lite.ts handles for the email rendering path:
//
//   - **bold**
//   - *italic*
//   - bullet lines starting with "- "
//   - links [label](https://...)  (and http://, mailto:)
//   - paragraphs separated by blank lines
//   - single newlines become <br />
//
// Every visible string flows through React's default text escaping;
// only the fixed React element set (<p>, <ul>, <li>, <strong>,
// <em>, <a>, <br />) is emitted. URLs that do not start with an
// allowed scheme fall back to literal text. This matches the safety
// stance app/_components/PublicPolicyReminderCard.tsx took in
// PR #116; that card stays focused on the policy-specific layout
// and now leans on this block when rendering text.
//
// This file does NOT do:
//   * Any DB access.
//   * Any HTML string concatenation; everything is React elements.
//   * Any block of formatting outside the subset above.

const LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const BOLD_RE = /\*\*([^*\n]+)\*\*/g;
const ITALIC_RE = /(^|[^\*])\*([^*\n]+)\*(?!\*)/g;

function safeHref(url: string): string | null {
  const lower = url.toLowerCase();
  if (
    lower.startsWith("https://") ||
    lower.startsWith("http://") ||
    lower.startsWith("mailto:")
  ) {
    return url;
  }
  return null;
}

type Token = { kind: "text"; value: string } | { kind: "node"; node: ReactNode };

function splitOnPattern(
  tokens: Token[],
  pattern: RegExp,
  build: (match: RegExpExecArray) => ReactNode,
): Token[] {
  const next: Token[] = [];
  for (const tok of tokens) {
    if (tok.kind !== "text") {
      next.push(tok);
      continue;
    }
    const source = tok.value;
    const re = new RegExp(pattern.source, pattern.flags);
    let cursor = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      if (m.index > cursor) {
        next.push({ kind: "text", value: source.slice(cursor, m.index) });
      }
      next.push({ kind: "node", node: build(m) });
      cursor = m.index + m[0].length;
    }
    if (cursor < source.length) {
      next.push({ kind: "text", value: source.slice(cursor) });
    }
  }
  return next;
}

function renderInline(text: string, keyBase: string): ReactNode {
  let tokens: Token[] = [{ kind: "text", value: text }];

  tokens = splitOnPattern(tokens, LINK_RE, (m) => {
    const label = m[1];
    const href = safeHref(m[2]);
    if (!href) {
      return `[${label}](${m[2]})`;
    }
    return (
      <a
        href={href}
        rel="noopener noreferrer"
        className="underline decoration-from-font underline-offset-2"
      >
        {label}
      </a>
    );
  });
  tokens = splitOnPattern(tokens, BOLD_RE, (m) => <strong>{m[1]}</strong>);
  tokens = splitOnPattern(tokens, ITALIC_RE, (m) => (
    <>
      {m[1]}
      <em>{m[2]}</em>
    </>
  ));

  return tokens.map((t, i) => (
    <Fragment key={`${keyBase}-${i}`}>
      {t.kind === "text" ? t.value : t.node}
    </Fragment>
  ));
}

type Block =
  | { kind: "para"; lines: string[] }
  | { kind: "list"; items: string[] };

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let openPara: string[] | null = null;

  function flushPara() {
    if (openPara && openPara.length > 0) {
      blocks.push({ kind: "para", lines: openPara });
    }
    openPara = null;
  }

  for (const raw of lines) {
    if (raw.trim().length === 0) {
      flushPara();
      continue;
    }
    const bullet = raw.match(/^\s{0,3}-\s+(.*)$/);
    if (bullet) {
      flushPara();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "list") {
        last.items.push(bullet[1]);
      } else {
        blocks.push({ kind: "list", items: [bullet[1]] });
      }
    } else {
      if (!openPara) openPara = [];
      openPara.push(raw);
    }
  }
  flushPara();
  return blocks;
}

// Render a markdown-lite string as paragraph/list React elements.
// Returns null when the input is empty/whitespace so callers can
// omit empty surfaces without an additional check. The optional
// `textClass` props let the host page tune typography without this
// component owning the visual choice.
export function MarkdownLiteBlock({
  text,
  paragraphClass = "text-[14px] leading-relaxed text-[#0A0A0A]",
  listClass = "list-disc pl-5 text-[14px] leading-relaxed text-[#0A0A0A]",
  keyPrefix = "ml",
}: {
  text: string | null | undefined;
  paragraphClass?: string;
  listClass?: string;
  keyPrefix?: string;
}) {
  if (!text || text.trim().length === 0) return null;
  const blocks = parseBlocks(text);
  return (
    <>
      {blocks.map((b, bi) => {
        if (b.kind === "para") {
          return (
            <p key={`${keyPrefix}-p${bi}`} className={paragraphClass}>
              {b.lines.map((line, li) => (
                <Fragment key={`${keyPrefix}-p${bi}-l${li}`}>
                  {li > 0 && <br />}
                  {renderInline(line, `${keyPrefix}-p${bi}-l${li}`)}
                </Fragment>
              ))}
            </p>
          );
        }
        return (
          <ul key={`${keyPrefix}-u${bi}`} className={listClass}>
            {b.items.map((item, ii) => (
              <li key={`${keyPrefix}-u${bi}-i${ii}`}>
                {renderInline(item, `${keyPrefix}-u${bi}-i${ii}`)}
              </li>
            ))}
          </ul>
        );
      })}
    </>
  );
}
