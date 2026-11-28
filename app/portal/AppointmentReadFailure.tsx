export function AppointmentReadFailure() {
  return (
    <div role="status" data-testid="portal-appointments-unavailable" className="flex flex-col items-start gap-2">
      <p>We couldn’t load your appointments.</p>
      <a href="/portal?view=appointments" className="inline-flex min-h-11 items-center font-medium underline">
        Try again
      </a>
    </div>
  );
}
