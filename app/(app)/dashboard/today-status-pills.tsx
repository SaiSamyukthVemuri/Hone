import type { CardOnFileStatus } from "@/lib/payment-methods/card-on-file";

// Two compact, PURE status pills for the Today row. They live in their own file
// (rather than inline in the async page) so a test can render the real markup
// through react-dom/server and assert on OUTPUT — in particular that an
// `unavailable` card read can never phrase itself as "No card".

/**
 * "In the room now." Deliberately the strongest pill on the row: solid fill
 * where every other pill is a tint, so the practitioner can find the current
 * client in one glance. BLUE, not red/amber — this is not an alarm and not a
 * task, it is a location. (Red is allergies, amber is attention: see the colour
 * convention at the top of the dashboard page.)
 */
export function CurrentPill() {
  return (
    <span
      data-testid="today-current-pill"
      className="inline-flex items-center rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white dark:bg-blue-500 dark:text-white"
    >
      Current
    </span>
  );
}

// One phrase per state, in one place. `unavailable` says what is true — that
// Hone could not read the card status — and never borrows the wording of an
// answer it does not have.
const CARD_ON_FILE_LABEL: Record<CardOnFileStatus, string> = {
  card_on_file: "Card on file",
  no_card: "No card",
  unavailable: "Card status unavailable",
};

const CARD_ON_FILE_CLASS: Record<CardOnFileStatus, string> = {
  // Good / done: calm green, same tint idiom as the other row chips.
  card_on_file:
    "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  // Actionable and easy to miss otherwise: amber, per the dashboard convention.
  no_card: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  // Not a client state at all, so it must not look like one: neutral, quiet,
  // and never amber.
  unavailable:
    "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
};

export function CardOnFilePill({ status }: { status: CardOnFileStatus | null }) {
  // A studio with no card-on-file route asks no card question, so there is no
  // pill — not a fourth state, the absence of the question.
  if (status === null) return null;
  return (
    <span
      data-testid="today-card-status"
      data-card-status={status}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${CARD_ON_FILE_CLASS[status]}`}
    >
      {CARD_ON_FILE_LABEL[status]}
    </span>
  );
}
