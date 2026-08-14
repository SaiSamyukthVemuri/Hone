// ONE combined Today workflow, replacing the Today roster + Daily Prep Brief pair.
//
// WHY THIS EXISTS
// ---------------
// Chloe: "Today and the Daily Prep Brief are redundant." They were. Every
// appointment rendered TWICE on the same screen: once chronologically in
// Today, once again a few hundred pixels lower in the priority-sorted brief,
// and the two lists disagreed about the same facts:
//
//   * the note. `compactBeforeToday` collapses a briefing into
//     `rememberLine = watchLines[0] ?? plan`, so the Today card's "Remember:"
//     line showed the CAUTION whenever one existed. The brief then showed that
//     same caution text again as "Caution noted:", plus the plan as
//     "For next visit:". Same words, two labels, two places.
//   * the setup line, as "Latest setup:" and again as "Last recorded:".
//   * intake, as a pill and again as an "Intake incomplete" reminder line.
//   * charting, as a next-action chip and again as a "Charting needed" line.
//   * the missing records, as "Records: 3 reminders" and again itemised.
//
// This module is the single derivation. It is PURE and DETERMINISTIC: no I/O,
// no clock, no model, no mutation. It reads only facts the dashboard has
// already loaded, so combining the two surfaces adds NO database query.
//
// THE JOIN KEY IS `appointmentId`, never `clientId`. A client can have two
// appointments in one day (a consultation and a treatment, or a rebook after a
// gap); those must stay two cards with their own status, session and actions.
// Joining by client would silently merge them and lose one.
//
// ORDER IS THE INPUT ORDER: the dashboard's chronological query. Daily Prep's
// priority sort is retained ONLY as an in-card attention signal; it must never
// reorder the day, because the day is a sequence she works through in time.

export type TodayIntake = "reviewed" | "submitted" | "in_progress" | "none";
export type TodayCharting = "needs" | "started" | "charted" | "none";

// 1 = most worth reviewing first, 6 = lowest. Carried over from the Daily Prep
// Brief, where it ordered the list. Here it only marks a card.
export type TodayPriority = 1 | 2 | 3 | 4 | 5 | 6;

// Per-appointment facts, all already in the dashboard's scope. The note fields
// are the practitioner's OWN recorded notes; this module passes them through
// verbatim and never authors clinical content.
export type TodayWorkflowInput = {
  appointmentId: string;
  clientId: string;
  clientName: string;
  // Pre-formatted studio-local time, so this module stays timezone-free.
  timeLabel: string;
  status: string;
  serviceName: string | null;
  hasHistory: boolean;
  // The structured plan note (session.next_session_note).
  nextVisitNote: string | null;
  // The first recorded watch line.
  cautionNote: string | null;
  // "27.12 MHz · Ballet F3 · Thermolysis"; recorded setup, or null.
  setupLine: string | null;
  // Granular missing-record reminders, already safe-worded by buildBeforeToday.
  reminders: ReadonlyArray<string>;
  intake: TodayIntake;
  charting: TodayCharting;
};

export type TodayWorkflowItem = {
  // Identity. `id` is the appointment id: one appointment, one card.
  id: string;
  appointmentId: string;
  clientId: string;
  clientName: string;
  timeLabel: string;
  status: string;
  serviceName: string | null;

  // Preparation: each fact resolved ONCE, and never re-labelled elsewhere.
  hasHistory: boolean;
  // The plan note. Rendered once under "Remember".
  remember: string | null;
  // The watch line. Rendered once under "Caution", visually distinct.
  caution: string | null;
  // Rendered once under "Latest setup".
  setup: string | null;
  // Specific, shortened, deduplicated missing-record reminders. NEVER
  // accompanied by a generic "Records: N reminders" count.
  missingRecords: string[];

  // Workflow status. Each is presented once, by its own control.
  intake: TodayIntake;
  charting: TodayCharting;

  // Attention only: must not reorder the day.
  priority: TodayPriority;
};

export type TodayWorkflow = {
  items: TodayWorkflowItem[];
  hasItems: boolean;
};

const UPCOMING_EXCLUDED = new Set(["completed", "no_show", "cancelled"]);

// Shorten a granular buildBeforeToday reminder into a compact, safe chip.
// Unmatched reminders pass through unchanged (already safe-worded).
export function shortenReminder(reminder: string): string {
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

// The highest-priority reason this appointment is worth preparing for. Lower
// number = more notable. Unchanged from the Daily Prep Brief, except that it
// no longer sorts anything.
function priorityFor(input: TodayWorkflowInput): TodayPriority {
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

function trimmedOrNull(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return v === "" ? null : v;
}

function buildItem(input: TodayWorkflowInput): TodayWorkflowItem {
  // The plan note and the watch note are DISTINCT facts with distinct
  // labels. They are deliberately NOT collapsed into one "Remember" string the
  // way `compactBeforeToday.rememberLine` did: that collapse is exactly what
  // made the same caution text appear twice under two different labels.
  const caution = trimmedOrNull(input.cautionNote);
  const remember = trimmedOrNull(input.nextVisitNote);

  // Setup is shown only when there IS history; "Latest setup" against a client
  // with no charted history is noise, and the no-history state says it already.
  const setup = input.hasHistory ? trimmedOrNull(input.setupLine) : null;

  // Specific reminders only, order-preserving and deduplicated after
  // shortening (two different long reminders can shorten to the same chip).
  const seen = new Set<string>();
  const missingRecords: string[] = [];
  for (const r of input.reminders) {
    const short = shortenReminder(r);
    if (seen.has(short)) continue;
    seen.add(short);
    missingRecords.push(short);
  }

  return {
    id: input.appointmentId,
    appointmentId: input.appointmentId,
    clientId: input.clientId,
    clientName: input.clientName,
    timeLabel: input.timeLabel,
    status: input.status,
    serviceName: input.serviceName,
    hasHistory: input.hasHistory,
    remember,
    caution,
    setup,
    missingRecords,
    intake: input.intake,
    charting: input.charting,
    priority: priorityFor(input),
  };
}

// Pure and deterministic. EXACTLY one item per input appointment, in the input
// order. Never sorts, never groups, never mutates its inputs.
export function buildTodayWorkflow(
  inputs: ReadonlyArray<TodayWorkflowInput>,
): TodayWorkflow {
  const items = inputs.map(buildItem);
  return { items, hasItems: items.length > 0 };
}

// Look up one appointment's workflow item. Keyed by APPOINTMENT id so two
// appointments for the same client never collide.
export function todayWorkflowByAppointment(
  workflow: TodayWorkflow,
): ReadonlyMap<string, TodayWorkflowItem> {
  return new Map(workflow.items.map((i) => [i.appointmentId, i]));
}
