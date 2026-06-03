import { Fragment, type ReactNode } from "react";

// Public-facing policy reminder card. Shown on /manage, /cancel, and
// /reschedule above the destructive/appointment-changing action so the
// client sees the studio's cancellation and no-show policies before
// they commit to a change. Reminder/display only; the underlying
// cancel/reschedule actions do not consult these fields and are not
// blocked when either policy is empty.
//
// Rendering subset (matches the policy editor in
// app/(app)/settings/studio/PolicySettingsForm.tsx, which writes the
// same markdown-lite shape lib/email/markdown-lite.ts consumes for
// email):
//   - **bold**
//   - *italic*
//   - bullet lines starting with "- "
//   - links [label](https://...) (and http://, mailto:)
//   - paragraphs separated by blank lines
//   - single newlines become <br />
//
// Safety stance. The browser surface deliberately avoids
// dangerouslySetInnerHTML. Every visible string flows through React's
// default text escaping; only the fixed React element set
// (<p>, <ul>, <li>, <strong>, <em>, <a>, <br />) is emitted. The parse
// structure mirrors lib/email/markdown-lite.ts so the email and the
// public reminder render the same way; the inline rules use the same
// regex shapes but emit React nodes directly. URLs that do not start
// with an allowed scheme fall back to literal text.

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

// Run a regex over every text token and replace each match with a
// pre-built React node. Text outside matches passes through unchanged
// so subsequent passes can still see it.
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
    // Re-create the regex so .lastIndex state does not leak across
    // tokens. All patterns are global.
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

// Render one line of plain (un-escaped) markdown-lite text into a
// sequence of React nodes. Links first so bold/italic do not chew
// through link internals; bold before italic so `**foo**` is not
// re-matched by the italic pass.
function renderInline(text: string, keyBase: string): ReactNode {
  let tokens: Token[] = [{ kind: "text", value: text }];

  tokens = splitOnPattern(tokens, LINK_RE, (m) => {
    const label = m[1];
    const href = safeHref(m[2]);
    if (!href) {
      // Disallowed scheme: fall back to literal so a `javascript:`
      // URL renders as harmless text rather than vanishing.
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

function renderPolicy(text: string): ReactNode {
  const blocks = parseBlocks(text);
  return blocks.map((b, bi) => {
    if (b.kind === "para") {
      return (
        <p
          key={`p${bi}`}
          className="text-[14px] leading-relaxed text-[#0A0A0A]"
        >
          {b.lines.map((line, li) => (
            <Fragment key={`p${bi}-l${li}`}>
              {li > 0 && <br />}
              {renderInline(line, `p${bi}-l${li}`)}
            </Fragment>
          ))}
        </p>
      );
    }
    return (
      <ul
        key={`u${bi}`}
        className="list-disc pl-5 text-[14px] leading-relaxed text-[#0A0A0A]"
      >
        {b.items.map((item, ii) => (
          <li key={`u${bi}-i${ii}`}>{renderInline(item, `u${bi}-i${ii}`)}</li>
        ))}
      </ul>
    );
  });
}

export function PublicPolicyReminderCard({
  cancellationPolicyText,
  noShowPolicyText,
  studioName,
}: {
  cancellationPolicyText: string | null;
  noShowPolicyText: string | null;
  studioName: string;
}) {
  const hasCancellation =
    !!cancellationPolicyText && cancellationPolicyText.trim().length > 0;
  const hasNoShow = !!noShowPolicyText && noShowPolicyText.trim().length > 0;

  // When both fields are empty the card is omitted entirely; we do
  // not render a "policies not configured" placeholder. This matches
  // the spec rule "Do not block cancel/reschedule because a policy
  // is missing. This is reminder/display only."
  if (!hasCancellation && !hasNoShow) return null;

  return (
    <section
      aria-label="Studio policies"
      className="flex flex-col gap-5 p-6"
      style={{ backgroundColor: "#FAFAF7", border: "1px solid #E5E2D9" }}
    >
      <p className="text-[14px] leading-relaxed text-[#0A0A0A]">
        Please review {studioName}&rsquo;s policies before changing your
        appointment.
      </p>
      {hasCancellation && (
        <div className="flex flex-col gap-2">
          <h3
            className="text-[12px] font-medium uppercase"
            style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
          >
            Cancellation policy
          </h3>
          {renderPolicy(cancellationPolicyText!)}
        </div>
      )}
      {hasNoShow && (
        <div className="flex flex-col gap-2">
          <h3
            className="text-[12px] font-medium uppercase"
            style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
          >
            No-show policy
          </h3>
          {renderPolicy(noShowPolicyText!)}
        </div>
      )}
    </section>
  );
}
