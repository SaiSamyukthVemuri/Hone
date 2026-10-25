import { unstable_rethrow } from "next/navigation";

// RECORDS-SECTION-RECOVERY. The record-keeping loaders throw a fixed message
// when a read fails (DAT-002, the #981 pattern), and that must stay true: a
// failed read is never rendered as "no records". What this changes is how far
// the failure reaches. Uncaught, one section's throw replaced the whole Records
// screen (title, tab nav, every panel) with app/(app)/error.tsx, and an
// optional lot search took the sterile records list down with it.
//
// The caller decides what a failure renders; this only tells it the read did
// not happen. Next's own control-flow throws (redirect, notFound, dynamic
// usage) are rethrown untouched. The error itself is never returned or
// rendered: its message can carry PostgREST text, so only the fixed part name
// reaches the log.

export type RecordsSurface = "records" | "records_print";

export type RecoveredRead<T> = { ok: true; value: T } | { ok: false };

export async function recoverRecordsRead<T>(
  surface: RecordsSurface,
  part: string,
  read: () => Promise<T>,
): Promise<RecoveredRead<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    unstable_rethrow(error);
    try {
      console.error(
        JSON.stringify({
          event: "record_keeping_section_unavailable",
          surface,
          part,
        }),
      );
    } catch {
      // Logging must never turn a recovered failure back into a throw.
    }
    return { ok: false };
  }
}
