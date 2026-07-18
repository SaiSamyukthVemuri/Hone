import Link from "next/link";
import type { ReactNode } from "react";
import {
  Container,
  Section,
  Eyebrow,
  Title,
  Subtitle,
  Lede,
  Hairline,
  CTAButton,
} from "./primitives";
import { WALKTHROUGH, ANALYTICS_EVENTS } from "@/lib/marketing/content";

// Shared marketing sections + desktop grid primitives. Structural only (no fixed
// prose) so pages keep unique copy. All content renders statically visible.

/** Closing walkthrough CTA band. */
export function WalkthroughCTA({ title, body }: { title: string; body: ReactNode }) {
  return (
    <Section tone="band">
      <Container className="text-center">
        <Title className="mx-auto max-w-2xl text-paper">{title}</Title>
        <Lede onBand className="mx-auto mt-5 max-w-xl">
          {body}
        </Lede>
        <div className="mt-8 flex justify-center">
          <CTAButton href={WALKTHROUGH.href} event={ANALYTICS_EVENTS.primaryCtaClick}>
            {WALKTHROUGH.primaryLabel}
          </CTAButton>
        </div>
      </Container>
    </Section>
  );
}

// A ruled desktop feature matrix (title + body). Edge-aligned columns, row and
// column dividers at lg, and a shared title min-height so bodies align across
// each row — a designed desktop table, not floating cards.
const featureCell =
  "flex flex-col border-b border-[color:var(--color-hairline)] py-7 lg:py-9 sm:px-6 lg:px-9 " +
  "lg:[&:nth-child(3n+1)]:pl-0 lg:[&:nth-child(3n)]:pr-0 " +
  "lg:[&:not(:nth-child(3n+1))]:border-l lg:[&:not(:nth-child(3n+1))]:border-[color:var(--color-hairline)]";

export type MatrixItem = {
  eyebrow?: string;
  title: string;
  body?: string;
  link?: { href: string; label: string };
};

export function FeatureMatrix({ items }: { items: MatrixItem[] }) {
  return (
    <div className="mt-8 border-t border-[color:var(--color-hairline-strong)]">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => (
          <div key={it.title} className={featureCell}>
            {it.eyebrow ? (
              <p className="mb-2 text-[0.75rem] font-semibold uppercase tracking-[0.12em] text-mineral">
                {it.eyebrow}
              </p>
            ) : null}
            <Subtitle as="h3" className={it.body ? "lg:min-h-[3.4rem]" : ""}>
              {it.title}
            </Subtitle>
            {it.body ? (
              <p className="mt-2 max-w-[42ch] text-[1.0625rem] leading-[1.55] text-muted">
                {it.body}
              </p>
            ) : null}
            {it.link ? (
              <Link
                href={it.link.href}
                className="mt-auto inline-block pt-4 text-[0.875rem] font-medium text-mineral underline underline-offset-4"
              >
                {it.link.label} →
              </Link>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Numbered workflow grid (3x2). Aligned numbers, dividers, and bodies. */
export function WorkflowGrid({
  steps,
}: {
  steps: { n: string; title: string; body: string }[];
}) {
  return (
    <div className="mt-10 grid grid-cols-1 gap-x-[clamp(2.5rem,4vw,4.5rem)] gap-y-10 sm:grid-cols-2 lg:mt-12 lg:grid-cols-3">
      {steps.map((s) => (
        <div key={s.n} className="flex flex-col">
          <div className="flex items-baseline gap-3">
            <span className="text-[0.9375rem] font-semibold text-mineral">{s.n}</span>
            <Subtitle as="h3" className="text-[1.0625rem] lg:min-h-[2.5rem] lg:text-[1.125rem]">
              {s.title}
            </Subtitle>
          </div>
          <Hairline className="my-3.5" />
          <p className="text-[1.0625rem] leading-[1.55] text-muted">{s.body}</p>
        </div>
      ))}
    </div>
  );
}

/** A grid of descriptive internal links (no "click here"; §25). Cards align at
 *  top and the "Read more" affordance pins to the bottom so links line up. */
export function RelatedLinks({
  eyebrow = "Keep exploring",
  title,
  links,
}: {
  eyebrow?: string;
  title: string;
  links: { href: string; label: string; blurb: string }[];
}) {
  return (
    <Section tone="paper" className="!py-[clamp(3.5rem,5vw,5.5rem)]">
      <Container size="wide">
        <Eyebrow>{eyebrow}</Eyebrow>
        <Title className="mt-3 max-w-2xl">{title}</Title>
        <div className="mt-9 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="group flex h-full flex-col rounded-[12px] border border-[color:var(--color-hairline)] bg-white p-6 transition-colors hover:border-[color:var(--color-hairline-strong)]"
            >
              <Subtitle as="h3" className="text-[1.125rem] group-hover:text-mineral">
                {l.label}
              </Subtitle>
              <p className="mt-2 text-[0.9375rem] leading-[1.55] text-muted">{l.blurb}</p>
              <span className="mt-auto pt-4 text-[0.875rem] font-medium text-mineral">
                Read more →
              </span>
            </Link>
          ))}
        </div>
      </Container>
    </Section>
  );
}
