"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  children: React.ReactNode;
  className?: string;
  as?: "section" | "div" | "header" | "footer";
};

// Wraps a block with a 250ms opacity fade-in triggered the first time
// it enters the viewport. CSS handles prefers-reduced-motion (see globals.css).
export function Reveal({ children, className = "", as = "section" }: Props) {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // If the section is already in view (or near it) on mount, paint it visible.
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

  // Polymorphic tag; the runtime type matches the static union but TS would
  // otherwise complain about the ref type per individual element.
  const Tag = as as React.ElementType;
  return (
    <Tag
      ref={ref}
      data-reveal={visible ? "1" : "0"}
      className={className}
    >
      {children}
    </Tag>
  );
}
