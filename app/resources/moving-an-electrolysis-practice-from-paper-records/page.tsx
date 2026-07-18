import type { Metadata } from "next";
import Link from "next/link";
import { SafeAnalytics } from "../../_components/SafeAnalytics";
import { SiteHeader } from "../../_components/marketing/SiteHeader";
import { SiteFooter } from "../../_components/marketing/SiteFooter";
import {
  MarketingSurface,
  Container,
  Eyebrow,
  Display,
  Subtitle,
} from "../../_components/marketing/primitives";
import { Reveal } from "../../_components/marketing/Reveal";
import {
  ArticleByline,
  ArticleDisclaimer,
  ArticleCorrections,
} from "../../_components/marketing/article";
import { WalkthroughCTA, RelatedLinks } from "../../_components/marketing/sections";
import { getResourceArticle } from "@/lib/marketing/resources";
import { marketingMetadata } from "@/lib/marketing/metadata";

export const metadata: Metadata = marketingMetadata(
  "/resources/moving-an-electrolysis-practice-from-paper-records",
);

const article = getResourceArticle(
  "/resources/moving-an-electrolysis-practice-from-paper-records",
)!;

const STEPS: { h: string; body: string[] }[] = [
  {
    h: "1. Decide what to bring over",
    body: [
      "You rarely need to migrate everything. Start with active clients — the people you expect to see again — and the treatment history that changes how you treat them next time.",
      "For inactive clients, it is often enough to keep the paper file for your retention period rather than re-key it.",
    ],
  },
  {
    h: "2. Get the data into a consistent shape",
    body: [
      "Digital tools need consistency. Put the history you are bringing over into a simple, consistent structure — a spreadsheet with one row per client (or per past session) and clear columns — before you import anything.",
      "Even a rough, consistent spreadsheet is far easier to work with than a stack of cards in different handwriting.",
    ],
  },
  {
    h: "3. Keep imported history separate from new charting",
    body: [
      "Imported history is a snapshot of what happened elsewhere; it is not the same as a session you charted live. Keeping the two clearly separated — and labelled — protects the integrity of your new records and avoids confusion about what was actually recorded at the time.",
    ],
  },
  {
    h: "4. Start charting new sessions digitally from day one",
    body: [
      "The value of moving off paper comes from what you record going forward. From your first digital appointment, chart the full session — settings, probe lot, areas, response, and a plan for next time — at the point of care.",
      "Within a few visits, the digital record becomes the one you actually reach for.",
    ],
  },
  {
    h: "5. Retain your paper records appropriately",
    body: [
      "Moving to digital does not automatically mean you can discard the paper. Retention periods for treatment records vary by jurisdiction, so keep your originals as required and store them securely until you are certain your obligations are met.",
    ],
  },
  {
    h: "6. Build the point-of-care habit",
    body: [
      "The practices that succeed with digital records are the ones that chart during or right after the appointment, not at the end of the week. A tool that is quick to use at the point of care makes that habit realistic.",
    ],
  },
];

export default function MovingFromPaperArticlePage() {
  return (
    <MarketingSurface>
      <SiteHeader />
      <main className="overflow-x-hidden">
        <article>
          <Container size="prose" className="pb-6 pt-14 lg:pt-20">
            <Reveal>
              <Eyebrow>Guide</Eyebrow>
              <Display className="mt-4">{article.title}</Display>
              <ArticleByline article={article} />
              <p className="mt-8 text-[1.0625rem] leading-[1.7] text-ink">
                Paper treatment cards work right up until they don&apos;t: a card is hard to
                read, hard to search, and only in one place at a time. Moving to digital records
                is mostly about continuity — keeping the history you have while making the
                records you take from now on cleaner and easier to use. Here is a practical way
                to do it without losing anything.
              </p>
            </Reveal>
          </Container>

          <Container size="prose" className="pb-8">
            {STEPS.map((s, i) => (
              <Reveal as="section" key={s.h} delay={(i % 3) * 40} className="mt-10 first:mt-2">
                <Subtitle as="h2" className="text-[1.25rem]">
                  {s.h}
                </Subtitle>
                {s.body.map((p, j) => (
                  <p key={j} className="mt-3 text-[0.9375rem] leading-[1.7] text-muted">
                    {p}
                  </p>
                ))}
              </Reveal>
            ))}

            <Reveal className="mt-10">
              <Subtitle as="h2" className="text-[1.25rem]">
                How Hone handles the move
              </Subtitle>
              <p className="mt-3 text-[0.9375rem] leading-[1.7] text-muted">
                Hone is built for exactly this transition. During guided onboarding, standard
                client import brings your history over from a spreadsheet, paper cards, or
                another tool — and it appears in each client&apos;s{" "}
                <Link
                  href="/features/treatment-memory"
                  className="font-medium text-mineral underline underline-offset-4"
                >
                  Before Today briefing
                </Link>{" "}
                clearly labelled as imported, never mixed with what you chart live. From there,
                new sessions are charted digitally from day one.
              </p>
              <ArticleDisclaimer />
              <ArticleCorrections />
            </Reveal>
          </Container>
        </article>

        <RelatedLinks
          eyebrow="Related"
          title="Keep reading."
          links={[
            {
              href: "/resources/electrolysis-treatment-record-checklist",
              label: "Treatment record checklist",
              blurb: "What to capture in every electrolysis treatment record once you're digital.",
            },
            {
              href: "/features/treatment-memory",
              label: "Treatment memory",
              blurb: "How imported history and new charting come together in the Before Today briefing.",
            },
            {
              href: "/electrolysis-software",
              label: "Electrolysis practice software",
              blurb: "See the whole workflow you're moving your practice onto.",
            },
          ]}
        />

        <WalkthroughCTA
          title="Thinking about moving off paper?"
          body="We'll walk through import and how new charting works, on your real records — and reply within one business day."
        />
      </main>
      <SiteFooter />
      <SafeAnalytics />
    </MarketingSurface>
  );
}
