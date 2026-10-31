// HON-48 Q7: a short, non-reversible fingerprint of the schedule a calendar screen is
// showing, computed on the server from rows the page already read. The client compares
// it across refreshes ONLY to notice that the 60 s / focus fallback found a change no
// live signal announced (a degraded-signal event). It is not a security token, is
// derived from schedule-visible fields only, and is never sent anywhere.

type Row = Record<string, unknown>;

// Every column 0271's UPDATE triggers announce is here (tests/lib/calendar/schedule-fingerprint.test.ts
// derives that list from the migration and fails on a gap), so a label-only edit whose live
// signal was missed still shows up as a degraded-signal event.
export const FIELDS = {
  appointments: ["id", "practitioner_id", "client_id", "service_id", "starts_at", "ends_at", "duration_minutes", "status", "notes", "blocked_ends_at", "buffer_minutes_snapshot"],
  timedBlocks: ["id", "practitioner_id", "starts_at", "ends_at", "category", "private_note"],
  blockouts: ["id", "starts_on", "ends_on", "reason"],
  recurringOccurrences: ["id", "starts_at", "ends_at"],
} as const;

function part(rows: ReadonlyArray<Row> | null | undefined, fields: readonly string[]): string {
  return (rows ?? [])
    .map((r) => fields.map((f) => String(r[f] ?? "")).join("|"))
    .sort()
    .join("\n");
}

// FNV-1a, 32 bit.
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function scheduleFingerprint(input: {
  appointments?: ReadonlyArray<Row> | null;
  timedBlocks?: ReadonlyArray<Row> | null;
  blockouts?: ReadonlyArray<Row> | null;
  recurringOccurrences?: ReadonlyArray<Row> | null;
}): string {
  return fnv1a(
    [
      part(input.appointments, FIELDS.appointments),
      part(input.timedBlocks, FIELDS.timedBlocks),
      part(input.blockouts, FIELDS.blockouts),
      part(input.recurringOccurrences, FIELDS.recurringOccurrences),
    ].join("\u0001"),
  );
}
