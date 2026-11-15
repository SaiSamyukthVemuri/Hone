// Shown to the owner when the "someone responded" email could not be delivered, so a failed send is visible in Hone and never silent.
// A count only: it names no person and no address, and it states nothing that depends on the response itself.
export function DeclineEmailFailedNotice({ failed, atLeast = false }: { failed: number; atLeast?: boolean }) {
  if (!Number.isFinite(failed) || failed <= 0) return null;
  return (
    <p
      role="status"
      data-testid="decline-email-failed"
      className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950"
    >
      {failed === 1 && !atLeast ? "An email about a waitlist response" : `${atLeast ? `${failed}+` : failed} emails about waitlist responses`} could not be delivered. The
      responses are still listed here.
    </p>
  );
}
