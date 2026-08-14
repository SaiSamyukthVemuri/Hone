import type { WelcomeEmailResult } from "@/lib/email/send-welcome";
import type { AdminActionOutcome } from "@/lib/audit/admin-actions";

// Truthful audit outcome for each welcome-email send result. The audit `outcome`
// column is a closed set (started/succeeded/failed/blocked, migration 0113), so
// a genuine send is `succeeded`, a real send failure is `failed`, and the two
// "nothing was sent" cases (env not configured / another attempt already owns the
// claim) are `blocked` (the send was prevented / a no-op). The EXACT result is
// preserved verbatim in metadata.welcome_email_result, so no truth is lost.
export function auditOutcomeFor(status: WelcomeEmailResult): AdminActionOutcome {
  switch (status) {
    case "sent":
      return "succeeded";
    case "failed":
      return "failed";
    case "not_configured": // env gate, nothing sent
    case "already_in_progress": // no-op, a live attempt owns the claim
      return "blocked";
  }
}
