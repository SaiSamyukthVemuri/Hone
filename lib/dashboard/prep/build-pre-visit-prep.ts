// THE ONE PLACE a Dashboard row's preparation is derived.
//
// Every input is something the page ALREADY holds:
//
//   * `load`   — one entry of the batched, appointment-bounded prep read
//                (lib/sessions/last-treatment-loader.ts). Two queries, two
//                waves, for the whole day.
//   * `client` — the appointment's OWN `client:clients(...)` row, a MANY-TO-ONE
//                embed on the roster select. It is not a collection: an
//                appointment has exactly one client, so the row either came
//                back or it did not. That is what makes it witness-grade.
//
// So this adds NO query and NO wave. It replaced a second historical pipeline
// that cost four more queries and three more waves, had no appointment bound,
// no void filter and no own-appointment exclusion, and discarded the `error` on
// every one of its reads.
//
// THE RULE, ONCE, FOR EVERY FACT BELOW
// ------------------------------------
// A value we read becomes a fact. A value we did not read becomes NOTHING.
// There is no third branch in this file that turns an absent value into copy —
// that is precisely the `?? "Not recorded"` shape the rebuild exists to delete,
// and it must not reappear here or at the render site.
//
// Pure. No I/O. Client-safe.

import type { AppointmentPrepLoad } from "@/lib/sessions/last-treatment-loader";
import {
  directRecordReminder,
  type DirectRecordReminder,
} from "@/lib/dashboard/prep/direct-record-reminder";
import type { PreVisitPrep } from "@/lib/dashboard/prep/pre-visit-prep";

/**
 * The appointment's own client row, projected to the scalars that license a
 * record reminder. Carries `id` because the id IS the proof the row was read.
 *
 * `null` when the embed did not come back — and then NO reminder is produced,
 * which is the correct behaviour: an unread client row is not an incomplete
 * client record. The old pipeline read this from a separate, error-discarding
 * query and turned one missing parent row into three field-level accusations.
 */
export type PrepClientRecord = {
  id: string;
  date_of_birth: string | null;
  phone: string | null;
  address: string | null;
};

/**
 * The chip wording.
 *
 * NONE OF THESE CARRY A SUPERLATIVE. "Aftercare not marked" is licensed by a
 * scalar on a row we hold; "Aftercare not marked ON THE LAST SESSION" would
 * additionally assert that this row is the last session — a claim about a
 * selection made over a collection, which no witness proves.
 */
const PROBE_LOT_COPY = "Probe lot missing";
const AFTERCARE_COPY = "Aftercare not marked";
const DOB_COPY = "Date of birth missing from record";
const PHONE_COPY = "Phone missing from record";
const ADDRESS_COPY = "Address missing from record";

export function buildPreVisitPrep(input: {
  load: AppointmentPrepLoad | null;
  client: PrepClientRecord | null;
  /** Already-compacted previous-visit identity, or null when none was observed. */
  compactSummary: string | null;
}): PreVisitPrep {
  const { load, client, compactSummary } = input;

  const reminders: DirectRecordReminder[] = [];
  const push = (r: DirectRecordReminder | null) => {
    if (r) reminders.push(r);
  };

  const treatment = load?.treatment ?? null;

  if (treatment) {
    // PROBE LOT — witness: a settings block that WAS returned, whose own
    // `probe_lot_number` column is null or blank.
    //
    // Direction-safe by construction: a block that was not returned cannot
    // manufacture a null lot, so a short read can only SUPPRESS this chip. That
    // is an omission, which is allowed; the inverse never happens.
    for (const block of treatment.blocks) {
      const r = directRecordReminder(
        { row: block, field: "probe_lot_number" },
        PROBE_LOT_COPY,
        "session_blocks.probe_lot_number",
      );
      if (r) {
        push(r);
        break; // One chip, however many areas are short a lot.
      }
    }

    // AFTERCARE — witness: the selected SESSION row itself. The scalar is on the
    // row we selected and read, so this is case (A), not a collection question.
    push(
      directRecordReminder(
        { row: treatment.session, field: "aftercare_and_risks_explained_at" },
        AFTERCARE_COPY,
        "sessions.aftercare_and_risks_explained_at",
      ),
    );
  }

  // CLIENT RECORD — witness: the appointment's own to-one client embed.
  //
  // When `client` is null the embed did not come back and NOTHING is claimed.
  // The reminder disappears rather than firing against a record we never saw.
  if (client) {
    push(
      directRecordReminder(
        { row: client, field: "date_of_birth" },
        DOB_COPY,
        "clients.date_of_birth",
      ),
    );
    push(
      directRecordReminder({ row: client, field: "phone" }, PHONE_COPY, "clients.phone"),
    );
    push(
      directRecordReminder(
        { row: client, field: "address" },
        ADDRESS_COPY,
        "clients.address",
      ),
    );
  }

  const prep: PreVisitPrep = { directRecordReminders: reminders };

  // REMEMBER — the newest recorded "for next visit" note in the appointment's
  // own window. Resolved by the loader BEFORE and independently of the block
  // read, so it survives both "nothing charted" and a failed block read. It is
  // the single most valuable prep fact on the page and the only one already
  // engineered to survive every failure; it must never be gated on a treatment
  // existing.
  const plan = load?.narrative.plan;
  const planText = plan?.text?.trim();
  if (plan && planText) {
    prep.remember = {
      sessionId: plan.sessionId,
      startedAt: plan.startedAt,
      text: planText,
    };
  }

  // CAUTION — observed on a block that came back, in the shared watch-line
  // grammar. Independent of Remember: a visit can carry one, both or neither,
  // and collapsing them into a single line is what once printed the same
  // caution twice under two labels.
  const caution = load?.observed.caution;
  if (caution) {
    prep.caution = {
      sessionId: caution.sessionId,
      startedAt: caution.startedAt,
      text: caution.text,
    };
  }

  // LATEST SETUP — observed on a block that came back. Absent means we did not
  // see one; the row then says nothing at all about setup, where it used to say
  // "Latest setup: Not recorded".
  const setup = load?.observed.latestSetup;
  if (setup) {
    prep.latestSetup = {
      sessionId: setup.sessionId,
      startedAt: setup.startedAt,
      line: setup.line,
      areaLabel: setup.areaLabel,
    };
  }

  if (treatment && compactSummary) {
    prep.lastTreatment = { compactSummary };
  }

  // The loader's three-state contract, narrowed to an OBSERVED operational
  // fact. `unavailable` is set only when a read actually errored or a bounded
  // window came back full — never when a read simply found nothing.
  if (load?.unavailable) {
    prep.loadFailure = { reason: "read_error" };
  }

  return prep;
}
