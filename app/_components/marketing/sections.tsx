import Link from "next/link";
import type { ReactNode } from "react";
import {
  Container,
  Section,
  Eyebrow,
  Title,
  Subtitle,
  Lede,
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
// each row: a designed desktop table, not floating cards.
// Cell padding follows the MKT-03 rhythm: 20px rows on a phone, 28px on a
// desktop, where a 36px row read as more paper than content.
const featureCell =
  "flex flex-col border-b border-[color:var(--color-hairline)] py-5 sm:px-6 lg:px-9 lg:py-7 " +
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

/** The connected workflow as an ordered list (2 columns from `sm`, 1 on a
 *  phone). The numbers are real — a visit happens in this order — so the list
 *  is an <ol>, and the visible "01" beside each title is the same fact drawn,
 *  hidden from assistive tech to avoid announcing it twice. One hairline per
 *  step, no fixed title height: the grid is as tall as what it says, which is
 *  what lets it sit level with the column beside it. */
export function WorkflowGrid({
  steps,
}: {
  steps: { n: string; title: string; body: string }[];
}) {
  return (
    <ol className="grid grid-cols-1 gap-x-[clamp(2rem,3.5vw,3.5rem)] gap-y-5 sm:grid-cols-2 sm:gap-y-7">
      {steps.map((s) => (
        <li
          key={s.n}
          className="grid grid-cols-[2.25rem_minmax(0,1fr)] border-t border-[color:var(--color-hairline-strong)] pt-4"
        >
          <span
            aria-hidden="true"
            className="pt-[0.2rem] text-[0.875rem] font-semibold tabular-nums text-mineral"
          >
            {s.n}
          </span>
          <div>
            <h3
              className="text-[1.125rem] font-semibold leading-[1.25] tracking-[-0.015em] text-ink sm:text-[1.25rem]"
              style={{ fontFamily: "var(--font-marketing-sans)" }}
            >
              {s.title}
            </h3>
            <p className="mt-1.5 text-[1rem] leading-[1.5] text-muted sm:text-[1.0625rem]">
              {s.body}
            </p>
          </div>
        </li>
      ))}
    </ol>
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
    <Section tone="paper">
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
