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
  id,
  style,
}: {
  children: ReactNode;
  as?: "div" | "section" | "li" | "article" | "header";
  className?: string;
  /** Stagger in ms. */
  delay?: number;
  id?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
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
  }, []);

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
