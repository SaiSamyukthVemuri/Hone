// A failed WRITE to the Google Calendar connection store. Supabase returns { data: null, error } instead of throwing, so before this a lost
// rotated refresh token, a mark-reconnect that did not stick, or a calendar choice that was not saved all looked like success. Carries the
// step only (never a message or a code), so a caller can log `google_calendar_error:<site>:<step>` without leaking row text.
export class ConnectionWriteError extends Error {
  readonly step: string;
  constructor(step: string) {
    super(`calendar_connection_write_error:${step}`);
    this.name = "ConnectionWriteError";
    this.step = step;
  }
}
