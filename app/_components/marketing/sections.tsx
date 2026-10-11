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
        <Lede onBand className="mx-auto mt-4 max-w-xl">
          {body}
        </Lede>
        <div className="mt-7 flex justify-center">
          <CTAButton
            href={WALKTHROUGH.href}
            onBand
            event={ANALYTICS_EVENTS.primaryCtaClick}
            className="max-sm:w-full"
          >
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
              <p className="mb-1.5 text-[0.875rem] font-medium text-mineral">{it.eyebrow}</p>
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
                className="mt-auto inline-flex min-h-11 items-center self-start pt-2 text-[0.9375rem] font-medium text-mineral underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)]"
              >
                {it.link.label}
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

/** Descriptive internal links (no "click here"; §25), as a ruled list rather
 *  than a wall of white cards. Each entry is one link whose name is its title;
 *  the hairline above it is the only frame, and nothing is appended to the
 *  label (no "Read more", no arrow) — the title already says where it goes. */
export function RelatedLinks({
  eyebrow,
  title,
  links,
}: {
  eyebrow?: string;
  title: string;
  links: { href: string; label: string; blurb: string }[];
}) {
  return (
    <Section tone="paper">
      <Container>
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <Title className={`${eyebrow ? "mt-3 " : ""}max-w-2xl`}>{title}</Title>
        <ul className="mt-8 grid gap-x-[clamp(2rem,4vw,4rem)] sm:grid-cols-2 lg:grid-cols-3">
          {links.map((l) => (
            <li key={l.href} className="border-t border-[color:var(--color-hairline-strong)]">
              <Link
                href={l.href}
                className="group flex h-full flex-col py-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)]"
              >
                <Subtitle
                  as="h3"
                  className="text-ink underline decoration-[color:var(--color-hairline-strong)] underline-offset-[6px] transition-colors duration-[var(--hone-duration-ui)] group-hover:text-mineral group-hover:decoration-[color:var(--color-mineral)]"
                >
                  {l.label}
                </Subtitle>
                <p className="mt-2 max-w-[40ch] text-[0.9375rem] leading-[1.55] text-muted">
                  {l.blurb}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </Container>
    </Section>
  );
}

/** A spec sheet: a heading over ruled rows, each a short topic on the left and
 *  what Hone actually does on the right. It replaces stacks of thin bands that
 *  each held one heading and two lines — the same information, without a
 *  background change and a 128px gap between every two sentences.
 *
 *  LAYOUT ONLY, ON PURPOSE. A row's words are written in the page as ordinary
 *  JSX children (a `<SpecRowHead>` and a `<SpecRowBody>`), never as props, so
 *  the copy guards that read page source — the append-only qualifier in
 *  particular — keep seeing every heading and sentence as its own element. */
export function SpecRows({ children }: { children: ReactNode }) {
  return <div className="mt-8 border-t border-[color:var(--color-hairline-strong)]">{children}</div>;
}

export function SpecRow({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-x-[clamp(2rem,5vw,5rem)] gap-y-2 border-b border-[color:var(--color-hairline)] py-6 sm:py-7 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.7fr)]">
      {children}
    </div>
  );
}

/** The row's topic: an H3 in the left column. */
export function SpecRowHead({ children }: { children: ReactNode }) {
  return (
    <Subtitle as="h3" className="lg:pt-0.5">
      {children}
    </Subtitle>
  );
}

/** The row's substance: a first sentence in ink, then detail in muted text. */
export function SpecRowBody({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-[64ch] text-[1.0625rem] leading-[1.6] text-muted [&>p+p]:mt-3 [&>p:first-child]:text-ink">
      {children}
    </div>
  );
}
