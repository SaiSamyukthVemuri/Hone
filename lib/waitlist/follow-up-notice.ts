import type { CommandOutcome } from "./followups-owner";

// The closed code carried in `?fu=` after an owner follow-up command. Kept OUT of the "use server" actions file: such a file may export only
// async functions, and this is a plain function plus a type that the page and the section also import.
export type FollowUpNotice = "done" | "already" | "refused" | "failed";

export function noticeFor(outcome: CommandOutcome): FollowUpNotice {
  switch (outcome) {
    case "done":
      return "done";
    case "already":
      return "already";
    case "unavailable":
      return "failed";
    default:
      return "refused";
  }
}
