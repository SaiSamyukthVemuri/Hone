import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { MK_FONT_DISPLAY } from "./tokens";
import { MarketingAnalytics } from "./MarketingAnalytics";

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
  fontWeight: 700, // Fraunces Bold — matches the established look and gives sturdier glyphs
  lineHeight: 1.08,
  letterSpacing: "-0.01em",
  // Turn off ligatures so the "f" never joins its neighbours (e.g. the "ft"
  // ligature that read as odd); render standard, separate letterforms.
  fontFeatureSettings: '"liga" 0, "dlig" 0, "calt" 0',
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
    <div className={`marketing-surface min-h-screen ${className}`}>
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
  const max =
    size === "prose" ? "max-w-[46rem]" : size === "wide" ? "max-w-[75rem]" : "max-w-[70rem]";
  return (
    <div className={`mx-auto w-full ${max} px-5 sm:px-6 lg:px-8 ${className}`}>
      {children}
    </div>
  );
}

type Tone = "paper" | "warm" | "band";

/** A vertical-rhythm section. `tone="band"` is the one dark comparison band. */
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
      className={`${toneClass} py-[clamp(4rem,8vw,8rem)] ${className}`}
      data-tone={tone}
    >
      {children}
    </section>
  );
}

/** Uppercase, letter-spaced kicker/label. */
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
      className={`text-[0.8125rem] font-semibold uppercase tracking-[0.14em] ${
        onBand ? "text-[color:var(--color-onband-muted)]" : "text-mineral"
      } ${className}`}
    >
      {children}
    </p>
  );
}

/** Hero H1. */
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
      style={displayStyle("clamp(2.5rem, 1.55rem + 4.2vw, 4.25rem)", { lineHeight: 1.05 })}
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
      style={displayStyle("clamp(2rem, 1.4rem + 2.6vw, 3rem)")}
    >
      {children}
    </Tag>
  );
}

/** Sub-heading / card title (H3). */
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
      className={className}
      style={displayStyle("clamp(1.375rem, 1.15rem + 1vw, 1.75rem)", { lineHeight: 1.2 })}
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
      className={`text-[1.0625rem] sm:text-[1.125rem] leading-[1.6] ${
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
 * Primary/secondary walkthrough or nav CTA. Renders a Link. `event` is a
 * privacy-safe analytics event name (from lib/marketing/content ANALYTICS_EVENTS)
 * attached as data-event for the analytics layer wired in a later stage, no
 * PII is ever attached here.
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
  const base =
    "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[8px] px-5 text-[0.9375rem] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[color:var(--color-mineral)]";
  const variantClass =
    variant === "primary"
      ? "bg-mineral text-paper hover:bg-[color:var(--color-mineral-deep)] focus-visible:ring-offset-[color:var(--color-paper)]"
      : variant === "outline"
        ? "border border-[color:var(--color-hairline-strong)] bg-transparent text-ink hover:bg-warm focus-visible:ring-offset-[color:var(--color-paper)]"
        : onBand
          ? "text-paper underline decoration-[color:var(--color-onband-muted)] underline-offset-[6px] hover:decoration-paper focus-visible:ring-offset-[color:var(--color-band)]"
          : "text-ink underline decoration-[color:var(--color-hairline-strong)] underline-offset-[6px] hover:decoration-[color:var(--color-ink)] focus-visible:ring-offset-[color:var(--color-paper)]";
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
