// Daily Prep Brief V1 (PR #241). The first agentic-style workflow in
// Hone, and deliberately RULES-BASED ONLY: no AI, no model call, no
// provider integration, no chatbot, no autonomous action. This pure
// module turns facts the Dashboard already loads (today's
// appointments, the Before Today preview pipeline, the linked-session
// charting state, and intake status) into a deterministic,
// priority-ordered prep list the practitioner reads before the day.
//
// It obeys the agentic safety plan (docs/22): assistant not decider,
// flag not diagnose, summarize recorded history (do not invent),
// prepare the practitioner (do not prescribe). It reads no sensitive
// surface (no exposure incidents, no payment internals, no Stripe
// ids, no raw tokens, no audit JSON) and writes nothing. Every item
// links to an existing, safe, studio-scoped client route; nothing is
// sent, charged, or mutated. Recorded-history wording only.

export type DailyPrepIntake =
  | "reviewed"
  | "submitted"
  | "in_progress"
  | "none";

export type DailyPrepCharting = "needs" | "started" | "charted" | "none";

// Per-appointment facts, all already in the Dashboard's scope. The
// note fields are the practitioner's OWN recorded notes; the brief
// passes them through verbatim and never authors clinical content.
export type DailyPrepInput = {
  appointmentId: string;
  clientId: string;
  clientName: string;
  // Pre-formatted studio-local time, e.g. "9:00 AM". Passed in so this
  // module stays timezone-free and deterministic.
  timeLabel: string;
  status: string;
  serviceName: string | null;
  hasHistory: boolean;
  nextVisitNote: string | null;
  cautionNote: string | null;
  // "27.12 MHz · Ballet F3 · Thermolysis"; recorded setup, or null.
  setupLine: string | null;
  // Granular missing-record reminders, already safe-worded by
  // buildBeforeToday (e.g. "Aftercare/risks not marked on the last
  // session"). Shortened for the compact brief by this module.
  reminders: ReadonlyArray<string>;
  intake: DailyPrepIntake;
  charting: DailyPrepCharting;
};

// 1 = most worth reviewing first, 6 = lowest. See buildDailyPrepBrief.
export type DailyPrepPriority = 1 | 2 | 3 | 4 | 5 | 6;

export type DailyPrepBriefItem = {
  id: string;
  appointmentId: string;
  clientId: string;
  time: string;
  // Client name.
  title: string;
  // "Returning client" / "No prior treatment history yet", plus the
  // service name when recorded.
  subtitle: string;
  // Existing, safe, studio-scoped client route.
  href: string;
  // Short chips: returning/new, plus service.
  tags: string[];
  // Short, recorded-history reminder lines, ordered.
  reminders: string[];
  priority: DailyPrepPriority;
};

export type DailyPrepBrief = {
  items: DailyPrepBriefItem[];
  hasItems: boolean;
};

const UPCOMING_EXCLUDED = new Set(["completed", "no_show", "cancelled"]);

// Shorten a granular buildBeforeToday reminder into a compact, safe
// chip. Unmatched reminders pass through unchanged (already
// safe-worded). The source strings are the canonical reminders; this
// only abbreviates them for the brief.
function shortenReminder(reminder: string): string {
  const r = reminder.toLowerCase();
  if (r.includes("probe lot")) return "Probe lot missing";
  if (r.includes("aftercare")) return "Aftercare not marked";
  if (r.includes("treatment area not recorded")) {
    return "Treatment area not recorded";
  }
  if (r.includes("date of birth")) return "Date of birth missing from record";
  if (r.includes("phone")) return "Phone missing from record";
  if (r.includes("address")) return "Address missing from record";
  return reminder;
}

function intakeReminder(intake: DailyPrepIntake): string | null {
  switch (intake) {
    case "in_progress":
      return "Intake incomplete";
    case "submitted":
      return "Intake awaiting review";
    case "none":
      return "No intake on file";
    case "reviewed":
      return null;
  }
}

function chartingReminder(charting: DailyPrepCharting): string | null {
  switch (charting) {
    case "needs":
      return "Charting needed";
    case "started":
      return "Charting in progress";
    case "charted":
    case "none":
      return null;
  }
}

// The highest-priority reason this appointment is worth preparing for.
// Lower number = reviewed first. Order matches docs/22 / the spec:
//   1 upcoming with a next-visit or caution note (recorded memory)
//   2 upcoming with intake not reviewed (intake work)
//   3 completed needing charting
//   4 a missing-record reminder exists
//   5 a new client with no prior memory
//   6 already charted / nothing notable
function priorityFor(input: DailyPrepInput): DailyPrepPriority {
  const upcoming = !UPCOMING_EXCLUDED.has(input.status);
  if (upcoming && (input.nextVisitNote?.trim() || input.cautionNote?.trim())) {
    return 1;
  }
  if (upcoming && input.intake !== "reviewed") return 2;
  if (input.charting === "needs") return 3;
  if (input.reminders.length > 0) return 4;
  if (!input.hasHistory) return 5;
  return 6;
}

function buildItem(input: DailyPrepInput): DailyPrepBriefItem {
  const reminders: string[] = [];

  // Recorded memory first, IN FULL.
  //
  // These three lines used to be capped at 90 characters. Chloe reads them off
  // the dashboard before a client sits down, and a note cut mid-sentence is
  // worse than no note — she had to open the client to find out what her own
  // instruction actually said. The Today roster card was already un-capped for
  // exactly this reason; the brief renders the SAME note a few hundred pixels
  // lower on the SAME screen, so leaving it clipped here just moved the
  // complaint. Nothing upstream truncates (before-today-previews passes the
  // strings through verbatim), and the card wraps with `break-words` +
  // `whitespace-pre-wrap`, so long or multi-line notes grow the row instead of
  // being lost.
  if (input.nextVisitNote?.trim()) {
    reminders.push(`For next visit: ${input.nextVisitNote.trim()}`);
  }
  if (input.cautionNote?.trim()) {
    reminders.push(`Caution noted: ${input.cautionNote.trim()}`);
  }
  if (input.hasHistory && input.setupLine?.trim()) {
    reminders.push(`Last recorded: ${input.setupLine.trim()}`);
  }

  // Intake and charting attention.
  const intake = intakeReminder(input.intake);
  if (intake) reminders.push(intake);
  const charting = chartingReminder(input.charting);
  if (charting) reminders.push(charting);

  // Missing-record reminders (deduped, shortened).
  const seen = new Set(reminders);
  for (const r of input.reminders) {
    const short = shortenReminder(r);
    if (!seen.has(short)) {
      seen.add(short);
      reminders.push(short);
    }
  }

  const returning = input.hasHistory;
  const relationship = returning
    ? "Returning client"
    : "No prior treatment history yet";
  const subtitle = input.serviceName
    ? `${relationship} · ${input.serviceName}`
    : relationship;
  const tags = [returning ? "Returning client" : "New client"];
  if (input.serviceName) tags.push(input.serviceName);

  return {
    id: input.appointmentId,
    appointmentId: input.appointmentId,
    clientId: input.clientId,
    time: input.timeLabel,
    title: input.clientName,
    subtitle,
    href: `/clients/${input.clientId}`,
    tags,
    reminders,
    priority: priorityFor(input),
  };
}

// Pure, deterministic. One item per visible appointment, ordered by
// priority then by the order the appointments came in (already
// chronological from the dashboard query). No I/O, no model, no
// mutation.
export function buildDailyPrepBrief(
  inputs: ReadonlyArray<DailyPrepInput>,
): DailyPrepBrief {
  const items = inputs
    .map((input, index) => ({ item: buildItem(input), index }))
    .sort((a, b) =>
      a.item.priority !== b.item.priority
        ? a.item.priority - b.item.priority
        : a.index - b.index,
    )
    .map(({ item }) => item);

  return { items, hasItems: items.length > 0 };
}
