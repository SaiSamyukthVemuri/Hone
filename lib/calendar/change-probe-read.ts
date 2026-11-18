// SERVER. Reads the rows the calendar draws for one view, in the CALLER'S OWN session, and returns only their fingerprint.
//
// Studio and role RLS apply exactly as they do to the page, because this uses the same session client (never the admin
// client) and the same predicates as the page's loaders in lib/booking/queries.ts:
//   appointments        studio_id, starts_at in [start, end), paged by id (the page pages at 1000)
//   timed blocks        studio_id, starts_at < end and ends_at > start
//   break occurrences   studio_id, starts_at < end and ends_at > start, with the rule it belongs to
//   blockouts           studio_id only (the page loads every blockout of the studio, not a range)
// tests/lib/calendar/change-probe-read-parity.test.ts runs this and the page's loaders against a recording client and
// requires the same filters, so the two cannot drift apart silently. Narrow columns only: no names, notes or contents.
//
// Cost per probe: 4 selects (the appointment select repeats only past 1000 rows). The caller pays the session and
// membership reads on top of that, which the route's comments count.

import { createClient } from "@/lib/supabase/server";
import { dbErrorCode } from "@/lib/logging/error-class";
import { calendarFingerprint } from "./change-fingerprint";
import { calendarLoadRange, type CalendarView } from "./calendar-load-range";

const PAGE_SIZE = 1000;
/** A runaway read fails loudly instead of hashing a truncated list. 20,000 appointments in one month view is not a studio. */
const MAX_PAGES = 20;

export async function readCalendarFingerprint(input: {
  studioId: string;
  timezone: string;
  view: CalendarView;
  anchor: string;
}): Promise<string> {
  const { studioId, timezone, view, anchor } = input;
  const { startUtc, endUtc } = calendarLoadRange(view, anchor, timezone);
  const startIso = startUtc.toISOString();
  const endIso = endUtc.toISOString();
  const supabase = await createClient();

  const readAppointments = async () => {
    const rows: Array<{ id: string; updated_at: string | null }> = [];
    let afterId: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let query = supabase
        .from("appointments")
        .select("id, updated_at")
        .eq("studio_id", studioId)
        .gte("starts_at", startIso)
        .lt("starts_at", endIso);
      if (afterId !== null) query = query.gt("id", afterId);
      const { data, error } = await query.order("id").range(0, PAGE_SIZE - 1);
      if (error) throw new Error(`Failed to read appointments: ${dbErrorCode(error)}`);
      const got = (data ?? []) as Array<{ id: string; updated_at: string | null }>;
      rows.push(...got);
      if (got.length < PAGE_SIZE) return rows;
      afterId = got[got.length - 1].id;
    }
    throw new Error("Failed to read appointments: too many rows");
  };

  const readTimedBlocks = async () => {
    const { data, error } = await supabase
      .from("studio_timed_blocks")
      .select("id, starts_at, ends_at, category, practitioner_id, updated_at")
      .eq("studio_id", studioId)
      .lt("starts_at", endIso)
      .gt("ends_at", startIso)
      .order("starts_at");
    if (error) throw new Error(`Failed to read timed blocks: ${dbErrorCode(error)}`);
    return (data ?? []) as Array<{
      id: string;
      starts_at: string;
      ends_at: string;
      category: string;
      practitioner_id: string | null;
      updated_at: string | null;
    }>;
  };

  const readBlockouts = async () => {
    const { data, error } = await supabase
      .from("studio_blockouts")
      .select("id, starts_on, ends_on")
      .eq("studio_id", studioId)
      .order("starts_on");
    if (error) throw new Error(`Failed to read blockouts: ${dbErrorCode(error)}`);
    return (data ?? []) as Array<{ id: string; starts_on: string; ends_on: string }>;
  };

  type RuleRef = { id: string; label: string; updated_at: string | null };
  const readOccurrences = async () => {
    const { data, error } = await supabase
      .from("studio_recurring_break_occurrences")
      .select("id, starts_at, ends_at, rule:studio_recurring_break_rules(id, label, updated_at)")
      .eq("studio_id", studioId)
      .lt("starts_at", endIso)
      .gt("ends_at", startIso)
      .order("starts_at");
    if (error) throw new Error(`Failed to read break occurrences: ${dbErrorCode(error)}`);
    return ((data ?? []) as unknown as Array<{
      id: string;
      starts_at: string;
      ends_at: string;
      rule: RuleRef | RuleRef[] | null;
    }>).map((row) => ({ ...row, rule: Array.isArray(row.rule) ? (row.rule[0] ?? null) : row.rule }));
  };

  const [appointments, timedBlocks, blockouts, occurrences] = await Promise.all([
    readAppointments(),
    readTimedBlocks(),
    readBlockouts(),
    readOccurrences(),
  ]);
  return calendarFingerprint({ appointments, timedBlocks, blockouts, occurrences });
}
