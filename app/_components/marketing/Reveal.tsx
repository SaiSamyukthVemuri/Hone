"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ElementType, ReactNode } from "react";

// Marketing reveal: opacity + a small translateY on first intersection, with an
// optional stagger `delay`. Uses the `[data-mreveal]` hooks in globals.css,
// which collapse to the final state under prefers-reduced-motion. Distinct from
// the app's `[data-reveal]` so the two never interfere.
export function Reveal({
  children,
  as = "div",
  className = "",
  delay = 0,
  immediate = false,
  id,
  style,
}: {
  children: ReactNode;
  as?: "div" | "section" | "li" | "article" | "header";
  className?: string;
  /** Stagger in ms. */
  delay?: number;
  /**
   * Render visible from the first paint (server-rendered), skipping the
   * intersection-gated fade. Use for above-the-fold hero content so the H1
   * paints immediately — never gate LCP or primary content behind hydration.
   */
  immediate?: boolean;
  id?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(immediate);

  useEffect(() => {
    if (immediate) return;
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            obs.disconnect();
            break;
          }
        }
      },
      { threshold: 0.05, rootMargin: "0px 0px -10% 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [immediate]);

  const Tag = as as ElementType;
  return (
    <Tag
      ref={ref}
      id={id}
      data-mreveal={visible ? "1" : "0"}
      className={className}
      style={{ ...style, ["--mk-delay" as string]: `${delay}ms` }}
    >
      {children}
    </Tag>
  );
}
