// The FormData ClientForm submits. Pure, so the HON-58 "save anyway" rule is
// testable without a DOM: one confirmation per warned client, sent only when
// the practitioner chose "Save as a new client anyway" for that warning.
export function buildClientFormData(
  values: Readonly<Record<string, string>>,
  hiddenFields?: Readonly<Record<string, string>>,
  confirmPossibleDuplicateIds?: ReadonlyArray<string> | null,
): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  if (hiddenFields) {
    for (const [k, v] of Object.entries(hiddenFields)) fd.set(k, v);
  }
  for (const id of confirmPossibleDuplicateIds ?? []) {
    if (id) fd.append("confirm_possible_duplicate", id);
  }
  return fd;
}
