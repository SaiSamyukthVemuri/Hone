// The one subject shape for a per-event reference (lib/email/booking-reference.ts
// derives the reference; tests/lib/email/email-subject-sweep.test.ts decides
// which emails carry one). Pure: no imports, so a template can use it without
// gaining I/O or crypto.
export function withReference(subject: string, ref: string): string {
  return `${subject} · Ref ${ref.trim()}`;
}
