import type { Metadata } from "next";
import Link from "next/link";
import { SafeAnalytics } from "../../_components/SafeAnalytics";
import { SiteHeader } from "../../_components/marketing/SiteHeader";
import { SkipLink } from "@/app/_components/marketing/SkipLink";
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
import { JsonLd, Breadcrumbs } from "../../_components/marketing/JsonLd";
import { articleLd } from "@/lib/marketing/jsonld";
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
      "You rarely need to migrate everything. Start with active clients, the people you expect to see again, and the treatment history that changes how you treat them next time.",
      "For inactive clients, it is often enough to keep the paper file for your retention period rather than re-key it.",
    ],
  },
  {
    h: "2. Get the data into a consistent shape",
    body: [
      "Digital tools need consistency. Before you import anything, put the history you are bringing over into one consistent structure, such as a spreadsheet with one row per client (or per past session) and clear columns.",
      "Even a rough, consistent spreadsheet is far easier to work with than a stack of cards in different handwriting.",
    ],
  },
  {
    h: "3. Keep imported history separate from new charting",
    body: [
      "Imported history is a snapshot of what happened elsewhere, recorded differently from a session you chart live. Keep the two separate and labelled, so it is always clear what was recorded at the time and what was brought over later.",
    ],
  },
  {
    h: "4. Start charting new sessions digitally from day one",
    body: [
      "Most of the benefit comes from what you record from now on. From your first digital appointment, chart the full session at the point of care: settings, probe lot, areas, response and a plan for next time.",
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
      "Chart during the appointment or straight after it, while the details are fresh. A tool that is quick to use at the point of care makes that habit realistic.",
    ],
  },
];

export default function MovingFromPaperArticlePage() {
  return (
    <MarketingSurface>
      <SkipLink />
      <SiteHeader />
      <Breadcrumbs
        items={[
          { name: "Home", path: "/" },
          { name: "Resources", path: "/resources" },
          { name: "Moving from paper records", path: article.slug },
        ]}
      />
      <main id="main-content" className="scroll-mt-16">
        <article>
          <Container size="prose" className="pb-6 pt-4 lg:pt-5">
            <Reveal immediate>
              <Eyebrow>Guide</Eyebrow>
              <Display className="mt-2.5">{article.title}</Display>
              <ArticleByline article={article} />
              <p className="mt-8 text-[1.0625rem] leading-[1.7] text-ink">
                A paper treatment card is hard to read, hard to search and in only one place at a
                time. Moving to digital records is mostly about continuity: keeping the history
                you have while making the records you take from now on easier to use. These six
                steps cover the move.
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
                During guided onboarding, standard client import brings your history over from a
                spreadsheet, paper cards or another tool, and it appears in each client&apos;s{" "}
                <Link
                  href="/features/treatment-memory"
                  className="font-medium text-mineral underline underline-offset-4"
                >
                  Before Today briefing
                </Link>{" "}
                labelled as imported and kept apart from what you chart live. New sessions are
                charted in Hone from the first appointment.
              </p>
              <ArticleDisclaimer />
              <ArticleCorrections />
            </Reveal>
          </Container>
        </article>

        <RelatedLinks
          title="Related reading"
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
          title="Moving off paper with Hone"
          body="We reply within one business day to set a time, then walk through import and how new charting works."
        />
      </main>
      <SiteFooter />
      <SafeAnalytics />
      <JsonLd data={articleLd(article)} />
    </MarketingSurface>
  );
}
