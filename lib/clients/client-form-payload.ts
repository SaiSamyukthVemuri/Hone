// The FormData ClientForm submits. Pure, so the HON-58 "save anyway" rule is
// testable without a DOM: the confirmation names exactly one existing client
// and is only sent when the practitioner chose "Save as a new client anyway"
// for that client's warning.
export function buildClientFormData(
  values: Readonly<Record<string, string>>,
  hiddenFields?: Readonly<Record<string, string>>,
  confirmPossibleDuplicateId?: string | null,
): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  if (hiddenFields) {
    for (const [k, v] of Object.entries(hiddenFields)) fd.set(k, v);
  }
  if (confirmPossibleDuplicateId) {
    fd.set("confirm_possible_duplicate", confirmPossibleDuplicateId);
  }
  return fd;
}
