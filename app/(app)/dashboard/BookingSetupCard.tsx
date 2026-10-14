import Link from "next/link";
import type {
  NewClientBlocker,
  NewClientReadiness,
  ReadinessAuthority,
} from "@/lib/booking/new-client-readiness";

// Owner-only dashboard surface: what is still missing before this studio can
// accept a NEW client.
//
// ===========================================================================
// ONB-03 — THIS CARD CONSUMES THE CANONICAL AUTHORITY
// ===========================================================================
//
// It used to read `computeBookingReadiness` (lib/booking/readiness.ts). That
// answers a NEIGHBOURING question — "may this studio publish a booking link" —
// over six structural items, and ONB-02's module header is explicit about the
// two things it does not ask: it "does not ask for a consultation specifically,
// and it has no consent input at all".
//
// THE FAILURE THAT MADE THIS WORTH CHANGING WAS THE CARD DISAPPEARING. `ready`
// renders null, so a studio whose only active service is an ordinary treatment,
// or that has no live treatment consent form, scored `ready` on the weaker
// definition and the card VANISHED — which is the strongest "setup complete"
// signal the Dashboard can send. Meanwhile /settings/launch listed the blocker
// and `publicBookAppointmentAction` refused the booking. The owner's primary
// surface disagreed with the rule the booking action enforces.
//
// The card now reads `NewClientReadiness`, the same authority /settings/launch
// consumes, so the two surfaces cannot diverge.
//
// ---------------------------------------------------------------------------
// WHY THE FULL CHECKLIST WITH TICKS IS GONE, AND WHY THAT IS NOT A REGRESSION
// ---------------------------------------------------------------------------
// The previous card listed every item including satisfied ones, each with a
// tick. The canonical authority exposes only PROVEN blockers; it deliberately
// does not report satisfied items, because `not_ready` can arrive with a
// non-empty `unavailable` — an authority it could not read at all.
//
// `NEW_CLIENT_BLOCKER_KEYS` would let this card reconstruct the full list and
// tick whatever is not a blocker. That would be WRONG, and quietly: a key
// absent from `blockers` may be absent because its authority was unreadable,
// not because it is satisfied. Ticking it asserts something nobody proved,
// which is exactly what the authority's own comment forbids — "present only
// when a blocker is proven; never derived from an absent authority".
//
// So this card shows what is missing, and says so when the list is incomplete.
//
// ---------------------------------------------------------------------------
// THREE STATES, BECAUSE THE AUTHORITY HAS THREE
// ---------------------------------------------------------------------------
//   ready     -> null. Unchanged contract: finished setup is not daily work,
//                and the decision stays in the component so a future caller
//                cannot reintroduce the banner by forgetting a guard.
//   not_ready -> the proven blockers, plus a note when `unavailable` means the
//                list is not exhaustive.
//   unknown   -> NEITHER of the above. Rendering null would claim ready on
//                evidence nobody has; rendering an empty blocker list would
//                read as "nothing to do". It says the check could not be
//                completed and sends the owner to the full launch view.
//
// The booking LINK is not here and was not before: it lives on
// /settings/booking and /settings/availability, where an established studio
// goes looking for it.
// ===========================================================================

type Props = {
  readiness: NewClientReadiness;
};

/** Owner-facing names for an authority this card could not read. */
const AUTHORITY_LABEL: Record<ReadinessAuthority, string> = {
  services: "services",
  availability: "availability",
  treatment_consent: "treatment consent",
  admission: "new-client admission",
};

export function BookingSetupCard({ readiness }: Props) {
  // READY IS THE ONLY STATE THAT RENDERS NOTHING, and the guard lives here
  // rather than at the call site so the contract holds for any caller.
  if (readiness.status === "ready") return null;

  if (readiness.status === "unknown") {
    return (
      <Shell heading="We could not check your booking setup">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {unreadableSentence(readiness.unavailable)} This is a problem reading
          your settings, not something you have left undone.
        </p>
        <LaunchLink label="Open setup" />
      </Shell>
    );
  }

  return (
    <Shell heading="Before you can take a new client">
      {readiness.unavailable.length > 0 && (
        // THE LIST IS NOT EXHAUSTIVE and the owner is told so, rather than
        // being left to read a short list as a complete one.
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {unreadableSentence(readiness.unavailable)} There may be more to do
          than the list below.
        </p>
      )}
      <ul className="flex flex-col gap-1.5" data-testid="booking-setup-blockers">
        {readiness.blockers.map((b) => (
          <BlockerRow key={b.key} blocker={b} />
        ))}
      </ul>
    </Shell>
  );
}

function Shell({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby="booking-setup-heading"
      data-testid="booking-setup-card"
      className="flex flex-col gap-5 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
    >
      <header className="flex flex-col gap-1">
        <h2 id="booking-setup-heading" className="text-lg font-medium">
          {heading}
        </h2>
      </header>
      {children}
    </section>
  );
}

/** "We could not read your services and treatment consent settings." */
function unreadableSentence(unavailable: ReadinessAuthority[]): string {
  const names = unavailable.map((a) => AUTHORITY_LABEL[a]);
  const joined =
    names.length <= 1
      ? (names[0] ?? "some")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `We could not read your ${joined} settings.`;
}

function LaunchLink({ label }: { label: string }) {
  return (
    <Link
      href="/settings/launch"
      className="self-start text-xs font-medium text-neutral-700 underline decoration-dotted underline-offset-2 dark:text-neutral-300"
    >
      {label}
    </Link>
  );
}

function BlockerRow({ blocker }: { blocker: NewClientBlocker }) {
  // EVERY ROW IS SOMETHING MISSING, so there is no ok/optional branching left:
  // the authority does not report satisfied items and this card does not invent
  // them. One mark, one label, one link to the place that fixes it.
  return (
    <li className="flex items-start gap-2 text-sm" data-testid={`blocker-${blocker.key}`}>
      <span
        aria-hidden
        className="mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full bg-amber-100 text-[11px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
      >
        ·
      </span>
      <span className="flex flex-1 flex-wrap items-baseline gap-x-2 text-neutral-900 dark:text-neutral-100">
        <span>{blocker.label}</span>
        <Link
          href={blocker.href}
          className="text-xs font-medium text-neutral-700 underline decoration-dotted underline-offset-2 dark:text-neutral-300"
        >
          Set up
        </Link>
      </span>
    </li>
  );
}
