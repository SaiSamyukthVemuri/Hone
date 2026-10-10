import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { MK_FONT_DISPLAY } from "./tokens";
import { MarketingAnalytics } from "./MarketingAnalytics";
import { marketingSans } from "./fonts";

// Marketing design-system primitives (server components). These encapsulate the
// type scale, spacing rhythm, and the single mineral-teal accent so pages stay
// declarative. Tokens resolve to app/globals.css `@theme` colors
// (bg-paper / text-ink / text-mineral / bg-band / border-hairline …).

const displayStyle = (
  clamp: string,
  extra?: CSSProperties,
): CSSProperties => ({
  fontFamily: MK_FONT_DISPLAY,
  fontSize: clamp,
  fontWeight: 600, // Inter Semibold: clean modern heading weight
  lineHeight: 1.1,
  letterSpacing: "-0.02em",
  ...extra,
});

/** Page wrapper, applies the marketing surface (font + paper background). */
export function MarketingSurface({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`marketing-surface min-h-screen ${marketingSans.variable} ${className}`}>
      {children}
      <MarketingAnalytics />
    </div>
  );
}

/** Centered content column. `size="prose"` narrows for long-form reading. */
export function Container({
  children,
  className = "",
  size = "default",
}: {
  children: ReactNode;
  className?: string;
  size?: "default" | "prose" | "wide";
}) {
  // One coherent fluid shell for header/hero/sections/footer (`default` +
  // `wide`); a narrower reading shell for long-form articles (`prose`). Widths
  // are defined in app/globals.css so every route shares the same edges.
  const shell = size === "prose" ? "mk-shell-reading" : "mk-shell";
  return <div className={`${shell} ${className}`}>{children}</div>;
}

type Tone = "paper" | "warm" | "band";

/** A vertical-rhythm section. `tone="band"` is the one dark comparison band.
 *  Padding is the site-wide `--mk-section-pad` (app/globals.css), so every
 *  marketing page shares one rhythm instead of each section choosing its own. */
export function Section({
  children,
  id,
  tone = "paper",
  className = "",
}: {
  children: ReactNode;
  id?: string;
  tone?: Tone;
  className?: string;
}) {
  const toneClass =
    tone === "band"
      ? "bg-band text-paper"
      : tone === "warm"
        ? "bg-warm text-ink"
        : "bg-paper text-ink";
  return (
    <section
      id={id}
      className={`${toneClass} py-[var(--mk-section-pad)] ${className}`}
      data-tone={tone}
    >
      {children}
    </section>
  );
}

/** Short label above a heading, in sentence case. It names what the block is
 *  about; it is not decoration, so it is set as words rather than as a tracked
 *  all-caps device (MKT-03 retired the uppercase treatment site-wide). */
export function Eyebrow({
  children,
  onBand = false,
  className = "",
}: {
  children: ReactNode;
  onBand?: boolean;
  className?: string;
}) {
  return (
    <p
      className={`text-[0.9375rem] font-medium leading-[1.4] ${
        onBand ? "text-[color:var(--color-onband-muted)]" : "text-mineral"
      } ${className}`}
    >
      {children}
    </p>
  );
}

// ONE TYPE SCALE FOR EVERY MARKETING PAGE (MKT-03 revision 2). The H1 ran
// 64-72px at a 1.02 line height: Instrument Sans' ascenders and descenders
// nearly met between lines, five-line headlines filled a half-width hero, and
// each page's opening sat at a different size. Now every page's H1 shares one
// clamp, about 34px on a phone to 58px on a wide desktop, and every heading
// has room for its glyphs:
//
//   H1  Display    34 -> 58px   line-height 1.08
//   H2  Title      28 -> 40px   line-height 1.14
//   H3  Subtitle   18 -> 21px   line-height 1.3
//
// The values are fluid between the widths that matter (320, 768, 1024, 1440),
// and the guard in tests/app/marketing-desktop.test.ts pins the scale.
export const TYPE_SCALE = {
  display: "clamp(2.125rem, 1.55rem + 2.45vw, 3.625rem)",
  title: "clamp(1.75rem, 1.45rem + 1.25vw, 2.5rem)",
  subtitle: "clamp(1.125rem, 1.06rem + 0.3vw, 1.3125rem)",
} as const;

/** Page H1. The same size on every marketing page. */
export function Display({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h1
      className={`text-balance ${className}`}
      style={displayStyle(TYPE_SCALE.display, { lineHeight: 1.08, letterSpacing: "-0.022em" })}
    >
      {children}
    </h1>
  );
}

/** Section heading (H2). */
export function Title({
  children,
  as = "h2",
  className = "",
}: {
  children: ReactNode;
  as?: "h2" | "h3";
  className?: string;
}) {
  const Tag = as;
  return (
    <Tag
      className={`text-balance ${className}`}
      style={displayStyle(TYPE_SCALE.title, {
        lineHeight: 1.14,
        letterSpacing: "-0.018em",
      })}
    >
      {children}
    </Tag>
  );
}

/** Sub-heading / row title (H3). */
export function Subtitle({
  children,
  as = "h3",
  className = "",
}: {
  children: ReactNode;
  as?: "h2" | "h3" | "h4";
  className?: string;
}) {
  const Tag = as;
  return (
    <Tag
      className={`text-balance ${className}`}
      style={displayStyle(TYPE_SCALE.subtitle, {
        lineHeight: 1.3,
        letterSpacing: "-0.01em",
      })}
    >
      {children}
    </Tag>
  );
}

/** Lead / body paragraph. */
export function Lede({
  children,
  onBand = false,
  className = "",
}: {
  children: ReactNode;
  onBand?: boolean;
  className?: string;
}) {
  return (
    <p
      className={`text-pretty text-[1.0625rem] leading-[1.55] sm:text-[1.125rem] ${
        onBand ? "text-[color:var(--color-onband-muted)]" : "text-muted"
      } ${className}`}
    >
      {children}
    </p>
  );
}

/** 1px hairline separator. */
export function Hairline({
  className = "",
  strong = false,
}: {
  className?: string;
  strong?: boolean;
}) {
  return (
    <div
      role="separator"
      aria-hidden="true"
      className={className}
      style={{
        height: 1,
        backgroundColor: strong
          ? "var(--color-hairline-strong)"
          : "var(--color-hairline)",
      }}
    />
  );
}

/** Small teal-wash chip/pill. */
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-wash px-3 py-1 text-[0.8125rem] font-medium text-[color:var(--color-mineral-deep)]">
      {children}
    </span>
  );
}

type CTAVariant = "primary" | "secondary" | "outline";

/**
 * Walkthrough or nav CTA. Renders a Link. `event` is a privacy-safe analytics
 * event name (from lib/marketing/content ANALYTICS_EVENTS) attached as
 * data-event; no PII is ever attached here.
 *
 * ONE FILLED BUTTON PER VIEW. `primary` is the walkthrough request, the one
 * conversion. Everything else on the same screen is `outline` (the header) or
 * `secondary` (an underlined text action), so the filled button is never
 * competing with a copy of itself.
 *
 * FOCUS IS AN OUTLINE, NOT A RING (DESIGN LAW 6). A box-shadow ring vanishes
 * in forced-colours mode; an outline is redrawn in the system colour.
 */
export function CTAButton({
  href,
  children,
  variant = "primary",
  onBand = false,
  event,
  className = "",
}: {
  href: string;
  children: ReactNode;
  variant?: CTAVariant;
  onBand?: boolean;
  event?: string;
  className?: string;
}) {
  const base = `inline-flex min-h-11 items-center justify-center gap-2 rounded-[8px] text-[0.9375rem] font-semibold transition-colors duration-[var(--hone-duration-ui)] focus-visible:outline-2 focus-visible:outline-offset-2 ${
    onBand ? "focus-visible:outline-[color:var(--color-paper)]" : "focus-visible:outline-[color:var(--color-mineral)]"
  }`;
  const variantClass =
    variant === "primary"
      ? "bg-mineral px-5 text-paper hover:bg-[color:var(--color-mineral-deep)]"
      : variant === "outline"
        ? "border border-[color:var(--color-hairline-strong)] bg-transparent px-4 text-ink hover:border-[color:var(--color-muted)] hover:bg-warm"
        : onBand
          ? "px-1 text-paper underline decoration-[color:var(--color-onband-muted)] underline-offset-[6px] hover:decoration-paper"
          : "px-1 text-ink underline decoration-[color:var(--color-hairline-strong)] underline-offset-[6px] hover:decoration-[color:var(--color-ink)]";
  return (
    <Link
      href={href}
      data-event={event}
      className={`${base} ${variantClass} ${className}`}
    >
      {children}
    </Link>
  );
}
