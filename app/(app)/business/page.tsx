import Link from "next/link";

import { BusinessSubnav } from "@/components/business-subnav";
import { FOCUS_RING, UI_TRANSITION, cx } from "@/components/ui/control-base";
import { SectionLabel } from "@/components/ui/section-label";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

// ===========================================================================
// BUSINESS — the owner domain's front door
// ===========================================================================
//
// WHAT THIS PAGE IS. A destination index for the owner's operating surfaces,
// and nothing else. Hone already has a place that answers "what needs me
// today" — that is the Dashboard. This answers "where do I go to see how the
// practice is doing", which is a different question and deliberately a
// smaller page.
//
// WHY IT EXISTS NOW AND NOT BEFORE. The Business tab used to point straight at
// /dashboard/capacity, and that was correct while capacity was the only owner
// surface: a hub standing in front of one destination is a click that buys
// nothing. Financials makes it two, so the word "Business" now has somewhere
// of its own to mean.
//
// WHY IT CARRIES NO FIGURES IN V1, WHICH IS A DELIBERATE PRODUCT CHOICE AND
// NOT AN OMISSION. Summarising either destination here would mean issuing that
// destination's briefing a second time:
//
//   * Capacity's briefing is a multi-read studio aggregate. Running it to
//     print one number on a page whose only purpose is to be left immediately
//     doubles the cost of reaching the surface that actually answers.
//   * Financials is windowed, and the window is the OWNER'S choice on that
//     screen (Day / Week / Month). Picking one here to have something to show
//     would invent a default the owner never asked for, and a money figure
//     over an unrequested period is exactly the kind of number that gets
//     quoted back later as fact.
//
// The product rule this follows: where an overview metric would compromise the
// Fact/UNKNOWN semantics the money surface is built on, omit it and let the
// card describe the destination instead. A card that states the question the
// surface answers is more useful than a figure that has to be re-derived, and
// it cannot be wrong.
//
// THE GATE IS ON THE PAGE, not merely on navigation. The Business tab is
// hidden from practitioners in the header and the mobile menu, but hiding is
// presentation, never authority — a practitioner who types /business reaches
// this file and meets the same refusal every sibling owner surface renders.
// The role comes from the practitioner row this request already resolved.
//
// READ-ONLY. No form, no action, no mutation, and no aggregate read at all.

export const metadata = { title: "Business" };

export default async function BusinessPage() {
  const { practitioner } = await getCurrentPractitionerWithStudio();

  if (practitioner.role !== "owner") {
    return (
      // `text-fg`, not `text-fg-muted`: muted on the sunken surface measures
      // 4.54:1, and this sentence is the page's entire content rather than a
      // caption beside something else. Matches /financials exactly.
      <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg">
        Only the studio owner can see business information.
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Business</h1>
        <p className="text-sm text-fg-muted">
          Capacity, money and the health of your practice.
        </p>
      </header>

      <BusinessSubnav />

      {/*
        ONE COLUMN ON A PHONE, TWO FROM `sm`. Cards are equal in weight
        because neither question is subordinate to the other: an owner with no
        room and an owner with no income have different problems and the page
        does not rank them.
      */}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <DestinationCard
          href="/dashboard/capacity"
          label="Capacity"
          question="Do I have room, and who needs rebooking?"
          detail="Active treatment clients, who has nothing booked, and how far ahead your treatment time is committed."
        />
        <DestinationCard
          href="/financials"
          label="Financials"
          question="What work happened, and what did the practice earn?"
          detail="Completed work, what was collected by card through Hone, refunds, and the visits with no payment recorded."
        />
      </ul>
    </div>
  );
}

/**
 * A destination, stated as the question it answers.
 *
 * The whole card is the target rather than a trailing "Open" link: a 44px
 * floor is met by the padding on every viewport, and an owner on a phone
 * should not have to hit a word. The heading is inside the link so a screen
 * reader announces the label and the question together as one destination.
 */
function DestinationCard({
  href,
  label,
  question,
  detail,
}: {
  href: string;
  label: string;
  question: string;
  detail: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className={cx(
          FOCUS_RING,
          UI_TRANSITION,
          "flex h-full flex-col gap-2 rounded-lg border border-line bg-surface p-4",
          "hover:border-line-strong hover:bg-surface-sunken",
        )}
      >
        <SectionLabel as="h2">{label}</SectionLabel>
        <p className="text-sm font-medium text-fg">{question}</p>
        <p className="text-sm text-fg-muted">{detail}</p>
      </Link>
    </li>
  );
}
