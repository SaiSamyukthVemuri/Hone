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
import { JsonLd, Breadcrumbs } from "../../_components/marketing/JsonLd";
import { articleLd } from "@/lib/marketing/jsonld";
import { getResourceArticle } from "@/lib/marketing/resources";
import { marketingMetadata } from "@/lib/marketing/metadata";

export const metadata: Metadata = marketingMetadata(
  "/resources/electrolysis-treatment-record-checklist",
);

const article = getResourceArticle(
  "/resources/electrolysis-treatment-record-checklist",
)!;

const SECTIONS: { h: string; intro: string; items: string[] }[] = [
  {
    h: "1. Client and appointment basics",
    intro: "Enough to identify the record unambiguously and connect it to the right person and visit.",
    items: [
      "Client name and date of birth",
      "Contact details",
      "Date of the appointment and the practitioner who performed it",
      "The service or treatment provided",
    ],
  },
  {
    h: "2. Consent and intake",
    intro: "Evidence that the client understood and agreed to treatment, and that you reviewed their history.",
    items: [
      "Signed consent on file for the treatment and, where relevant, photos",
      "Health intake reviewed, with any contraindications or precautions noted",
      "Anything the client reported that changes how you treat (e.g. medication, sensitivity)",
    ],
  },
  {
    h: "3. Machine settings",
    intro: "The technical detail that lets you reproduce — or deliberately adjust — what you did.",
    items: [
      "Mode: thermolysis, blend, or galvanic",
      "Modality and energy level",
      "Machine frequency",
      "Per-pass readings where your method records them",
    ],
  },
  {
    h: "4. Probe and consumables",
    intro: "What touched the client, in enough detail to trace it later.",
    items: [
      "Probe brand, material, and size",
      "Probe lot or batch number",
      "Sterile-item and disinfectant lots used, with expiry",
    ],
  },
  {
    h: "5. Treatment areas",
    intro: "Where you worked, on which side, and for how long.",
    items: [
      "Each treatment area worked",
      "Laterality (left, right, both sides, midline, or not applicable)",
      "Minutes performed per area",
    ],
  },
  {
    h: "6. Client response",
    intro: "How the skin and the client tolerated the session — the record that protects continuity and safety.",
    items: [
      "Tolerance for each area",
      "Any skin or client reaction, and whether it settled",
      "Whether numbing was used",
    ],
  },
  {
    h: "7. Plan for the next visit",
    intro: "The note that turns a one-off record into a course of treatment.",
    items: [
      "Suggested spacing before the next appointment",
      "Settings or areas to adjust next time",
      "Cautions to watch",
    ],
  },
  {
    h: "8. Follow-up",
    intro: "Closing the loop after the client leaves.",
    items: ["Aftercare instructions given", "Postcare communication sent, if any"],
  },
];

export default function ChecklistArticlePage() {
  return (
    <MarketingSurface>
      <SiteHeader />
      <Breadcrumbs
        items={[
          { name: "Home", path: "/" },
          { name: "Resources", path: "/resources" },
          { name: "Treatment record checklist", path: article.slug },
        ]}
      />
      <main className="overflow-x-hidden">
        <article>
          <Container size="prose" className="pb-6 pt-6 lg:pt-8">
            <Reveal>
              <Eyebrow>Guide</Eyebrow>
              <Display className="mt-4">{article.title}</Display>
              <ArticleByline article={article} />
              <p className="mt-8 text-[1.0625rem] leading-[1.7] text-ink">
                A good electrolysis treatment record does two jobs: it protects the client, and
                it lets the next session build on this one. Below is a practical checklist of
                what a thorough record typically captures. Treat it as a starting point and
                adapt it to how you work and to the requirements where you practise.
              </p>
            </Reveal>
          </Container>

          <Container size="prose" className="pb-8">
            {SECTIONS.map((s, i) => (
              <Reveal as="section" key={s.h} delay={(i % 3) * 40} className="mt-10 first:mt-2">
                <Subtitle as="h2" className="text-[1.25rem]">
                  {s.h}
                </Subtitle>
                <p className="mt-2 text-[0.9375rem] leading-[1.7] text-muted">{s.intro}</p>
                <ul className="mt-3 space-y-2">
                  {s.items.map((it) => (
                    <li key={it} className="flex gap-3 text-[0.9375rem] leading-[1.6] text-ink">
                      <span aria-hidden="true" className="mt-1 text-mineral">
                        ✓
                      </span>
                      <span>{it}</span>
                    </li>
                  ))}
                </ul>
              </Reveal>
            ))}

            <Reveal className="mt-10">
              <Subtitle as="h2" className="text-[1.25rem]">
                Keeping it consistent
              </Subtitle>
              <p className="mt-2 text-[0.9375rem] leading-[1.7] text-muted">
                The hardest part of record-keeping isn&apos;t knowing what to capture — it&apos;s
                capturing it the same way every time, at the point of care. Structured charting
                helps: when settings, probe lot, areas, and response are their own fields rather
                than a free-text note, the record stays legible and the detail carries forward.
                That is exactly what{" "}
                <Link
                  href="/features/charting-records"
                  className="font-medium text-mineral underline underline-offset-4"
                >
                  charting and records in Hone
                </Link>{" "}
                is built to do.
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
              href: "/resources/moving-an-electrolysis-practice-from-paper-records",
              label: "Moving from paper records",
              blurb: "How to bring history over and start charting digitally without losing continuity.",
            },
            {
              href: "/features/charting-records",
              label: "Charting and records",
              blurb: "See how Hone captures every item on this checklist as structured data.",
            },
            {
              href: "/features/treatment-memory",
              label: "Treatment memory",
              blurb: "How a good record becomes the Before Today briefing at the next visit.",
            },
          ]}
        />

        <WalkthroughCTA
          title="See structured charting in Hone."
          body="We'll walk through charting a session so every item here is captured cleanly — and reply within one business day."
        />
      </main>
      <SiteFooter />
      <SafeAnalytics />
      <JsonLd data={articleLd(article)} />
    </MarketingSurface>
  );
}
