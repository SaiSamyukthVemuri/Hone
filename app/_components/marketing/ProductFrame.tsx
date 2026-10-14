import type { ReactNode } from "react";

// Product-visual chrome for the coded mockups (§12). Every product composition
// is wrapped so it carries the depth token and a VISIBLE, screen-reader-available
// disclosure that the preview is illustrative (addendum §8). No real client data
// ever renders inside these, only anonymized demo data.

/**
 * ProductFrame, the elevated card that holds a product composition, with the
 * illustrative-preview disclosure as a real <figcaption>.
 */
export function ProductFrame({
  children,
  label = "Illustrative product preview",
  className = "",
}: {
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <figure
      className={`relative overflow-hidden bg-white ${className}`}
      style={{
        borderRadius: "var(--mk-radius-frame)",
        boxShadow: "var(--mk-shadow-frame)",
        border: "1px solid var(--color-hairline)",
      }}
    >
      {children}
      {/* The disclosure is set as words in sentence case. The SMALL CAPS inside
          the previews stay: they reproduce the real app's own labels (the film
          shows the same "SETUP USED" and "AREAS TREATED"), whereas this line is
          the marketing site speaking, in the site's voice. */}
      <figcaption className="border-t border-[color:var(--color-hairline)] px-4 py-2 text-[0.8125rem] text-muted">
        {label}
      </figcaption>
    </figure>
  );
}

/**
 * BrowserFrame, a ProductFrame with a top bar carrying a static context label
 * such as a route. The label is context, not a real URL bar; keep it truthful
 * and generic. No window dots: they are template chrome that says "screenshot"
 * without saying anything about Hone.
 */
export function BrowserFrame({
  children,
  contextLabel = "hone.care",
  label,
  className = "",
}: {
  children: ReactNode;
  contextLabel?: string;
  label?: string;
  className?: string;
}) {
  return (
    <ProductFrame label={label} className={className}>
      <div
        className="flex items-center gap-2 border-b border-[color:var(--color-hairline)] px-4 py-3"
        style={{ background: "var(--color-warm)" }}
        aria-hidden="true"
      >
        <span className="text-[0.75rem] text-muted">{contextLabel}</span>
      </div>
      {children}
    </ProductFrame>
  );
}

/**
 * ProductAnnotation, a small mineral note pointing at part of a composition.
 * Purely descriptive marketing annotation.
 */
export function ProductAnnotation({ children }: { children: ReactNode }) {
  return (
    <p className="text-[0.8125rem] leading-[1.5] text-[color:var(--color-mineral-deep)]">
      <span aria-hidden="true" className="mr-1.5 font-semibold">
        →
      </span>
      {children}
    </p>
  );
}
