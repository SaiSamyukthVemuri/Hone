import Link from "next/link";
import type { ReactNode } from "react";
import { Container, Section, Eyebrow, Title, Subtitle, Lede, CTAButton } from "./primitives";
import { Reveal } from "./Reveal";
import { WALKTHROUGH, ANALYTICS_EVENTS } from "@/lib/marketing/content";

// Shared marketing sections reused across the pillar and feature pages. These
// are structural (no fixed body prose) so pages keep unique, original copy.

/** Closing walkthrough CTA band. */
export function WalkthroughCTA({
  title,
  body,
}: {
  title: string;
  body: ReactNode;
}) {
  return (
    <Section tone="band">
      <Container className="text-center">
        <Reveal>
          <Title className="mx-auto max-w-2xl text-paper">{title}</Title>
          <Lede onBand className="mx-auto mt-5 max-w-xl">
            {body}
          </Lede>
          <div className="mt-8 flex justify-center">
            <CTAButton href={WALKTHROUGH.href} event={ANALYTICS_EVENTS.primaryCtaClick}>
              {WALKTHROUGH.primaryLabel}
            </CTAButton>
          </div>
        </Reveal>
      </Container>
    </Section>
  );
}

/** A grid of descriptive internal links (no "click here"; §25). */
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
      <Container>
        <Reveal>
          <Eyebrow>{eyebrow}</Eyebrow>
          <Title className="mt-4 max-w-2xl">{title}</Title>
        </Reveal>
        <div className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {links.map((l, i) => (
            <Reveal as="div" key={l.href} delay={(i % 3) * 60}>
              <Link href={l.href} className="group block">
                <Subtitle as="h3" className="text-[1.125rem] group-hover:text-mineral">
                  {l.label}
                </Subtitle>
                <p className="mt-2 text-[0.9375rem] leading-[1.6] text-muted">{l.blurb}</p>
                <span className="mt-3 inline-block text-[0.875rem] font-medium text-mineral">
                  Read more →
                </span>
              </Link>
            </Reveal>
          ))}
        </div>
      </Container>
    </Section>
  );
}
