// HON-7 (b). The ONE seam between the app and the 0325 database commands for the decline follow-up. Everything above this file (the
// recipient form, the owner section, the post-commit email call) is written against these types; everything below it is the frozen contract.
//
// TODO(0325 contract): this file is an INTERFACE ONLY. Each method below names what the app needs and returns a CLOSED outcome. When
// willow/0325-draft/CONTRACT.md is forwarded, the implementation maps each method to its command (name, arguments, return shape) and nothing
// else changes. Do not guess a command name, argument or column here, and do not add an implementation that calls the database before then.
//
// Rules the implementation must keep, whatever the shapes turn out to be:
//   * Every owner method re-derives ownership in the database; the app never passes "I am the owner" as an argument.
//   * Answers (the recipient's two texts) are returned ONLY by `listFollowUps`, to an owner, and never appear in a log, a bell, an email or an
//     error. The email and the bell stay generic.
//   * A failed or unreadable read is `unavailable`, never an empty list.

export type NoTimesWorkOutcome =
  | { kind: "saved" }
  | { kind: "invalid" } // a required answer is missing, too long or has forbidden characters (the database re-validates)
  | { kind: "unavailable" } // not live, wrong capability, or the command refused
  | { kind: "error" };

export type NoLongerNeedOutcome = { kind: "saved" } | { kind: "unavailable" } | { kind: "error" };

export type FollowUpStatus = "open" | "handled" | "booked_manually" | "booked_elsewhere";

/** One recipient's response, as an OWNER sees it. */
export type FollowUpRow = {
  id: string;
  /** The recipient's name as the studio already holds it on the waitlist entry; the answers below are what the person wrote. */
  name: string;
  kind: "no_times_work" | "no_longer_needed";
  why: string | null;
  better: string | null;
  respondedAt: string;
  status: FollowUpStatus;
  /** Counts of this decline's outbox rows, for the email status line. null when they could not be read. */
  emailRows: { held: number; sending: number; sent: number; failed: number; cancelled: number } | null;
};

export type ListFollowUpsOutcome = { kind: "ok"; rows: FollowUpRow[] } | { kind: "not_owner" } | { kind: "unavailable" };

export type FollowUpCommandOutcome =
  | { kind: "done" }
  | { kind: "already" } // it was already in that state; a retry is not an error
  | { kind: "not_owner" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export interface DeclineFollowUpAdapter {
  /** Recipient: "None of these times work" with both answers. */
  submitNoTimesWork(args: { rawToken: string; why: string; better: string }): Promise<NoTimesWorkOutcome>;
  /** Recipient: "I no longer need an appointment". */
  submitNoLongerNeeded(args: { rawToken: string }): Promise<NoLongerNeedOutcome>;
  /** Owner: the open and recent follow-ups for the studio. */
  listFollowUps(args: { studioId: string }): Promise<ListFollowUpsOutcome>;
  /** Owner: mark a response handled. */
  markHandled(args: { followUpId: string }): Promise<FollowUpCommandOutcome>;
  /** Owner: record that the person was booked by hand from the follow-up. */
  bookManually(args: { followUpId: string }): Promise<FollowUpCommandOutcome>;
  /** Owner: record that the person booked elsewhere. */
  bookedElsewhere(args: { followUpId: string }): Promise<FollowUpCommandOutcome>;
}
