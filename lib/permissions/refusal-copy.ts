// Read-only chart mode: a practitioner who may VIEW the records (clin.view_records) but not EDIT them (clin.edit_records) is told so in
// words that differ from the "cannot see this at all" refusal, so the message never claims the chart is hidden when it is only locked.
export const VIEW_REFUSAL = "Not available to your role.";
export const EDIT_RECORDS_REFUSAL = "You can view this chart but not change it.";
