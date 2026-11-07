// HON-46 M2 — arm the packet for ONE print, and only after the print is audited.
//
// The document is hidden in print media unless it carries data-print-armed
// (page.tsx PRINT_CSS). The audited Print button arms it; this module makes that
// ONE-SHOT: the arm is removed on `afterprint`, with a timeout fallback for
// browsers that do not fire it, and on every failure path. So a second
// Ctrl/Cmd+P or Save as PDF in the same view prints only the notice, and the
// owner must press Print again, which audits again (Insurance E-1, Privacy B-1).
//
// This GATES the browser's own print; it does not prevent copying, a screenshot
// or a browser that ignores print CSS (Privacy F-4). It is never "every print is
// audited". Pure, with every side effect injected, so it is unit-tested directly.

export const ARM_FALLBACK_MS = 60_000;

export type ArmDeps = {
  /** The server action that records the print (fail closed). */
  record: () => Promise<{ ok: boolean }>;
  arm: () => void;
  disarm: () => void;
  print: () => void;
  /** Subscribe to `afterprint`; returns the unsubscribe. */
  onAfterPrint: (cb: () => void) => () => void;
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

/**
 * `reason` tells the caller WHICH step failed, so the message is true: a refused
 * audit means nothing was recorded; a print failure means the print WAS recorded
 * and only the browser dialog could not open (Insurance F-5).
 */
export type PrintOutcome = { ok: true } | { ok: false; reason: "audit_failed" | "print_failed" };

export async function printWithAudit(deps: ArmDeps): Promise<PrintOutcome> {
  const recorded = await deps.record().catch(() => ({ ok: false }));
  if (!recorded.ok) {
    deps.disarm();
    return { ok: false, reason: "audit_failed" };
  }

  let done = false;
  let unsubscribe: () => void = () => {};
  let timer: unknown = null;
  const finish = () => {
    if (done) return;
    done = true;
    unsubscribe();
    if (timer !== null) deps.clearTimer(timer);
    deps.disarm();
  };

  deps.arm();
  unsubscribe = deps.onAfterPrint(finish);
  timer = deps.setTimer(finish, ARM_FALLBACK_MS);
  try {
    deps.print();
  } catch {
    finish();
    return { ok: false, reason: "print_failed" };
  }
  return { ok: true };
}
