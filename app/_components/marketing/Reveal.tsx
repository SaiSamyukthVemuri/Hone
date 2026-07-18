import type { CSSProperties, ElementType, ReactNode } from "react";

// Layout wrapper. Marketing content renders statically visible, there is no
// scroll-gated entrance animation (a previous intersection-observer reveal could
// leave sections stuck at opacity 0). The `delay`/`immediate` props are accepted
// for call-site compatibility but no longer affect rendering.
export function Reveal({
  children,
  as = "div",
  className = "",
  id,
  style,
}: {
  children: ReactNode;
  as?: "div" | "section" | "li" | "article" | "header";
  className?: string;
  /** Accepted for compatibility; no longer animates. */
  delay?: number;
  /** Accepted for compatibility; no longer animates. */
  immediate?: boolean;
  id?: string;
  style?: CSSProperties;
}) {
  const Tag = as as ElementType;
  return (
    <Tag id={id} className={className} style={style}>
      {children}
    </Tag>
  );
}
