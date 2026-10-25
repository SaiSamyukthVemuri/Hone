import os from "node:os";
import path from "node:path";

// SCH-001. Where the lane's fake Resend transport appends its capture ledger
// (lib/email/e2e-fake-resend.ts, recordFakeResendSend). Self-contained, like
// twilio-egress-config.ts, so local-env can import it without a cycle. One file
// per worktree and port, so two worktrees never mix records. It MUST live under
// the OS temp dir with a .jsonl suffix: the transport refuses any other path.
export function resendLedgerPath(worktree: string, port: number | string): string {
  return path.join(os.tmpdir(), "hone-e2e-resend", `${path.basename(worktree)}-${port}.jsonl`);
}
