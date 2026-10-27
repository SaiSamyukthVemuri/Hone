// HON-44 (a): a shared clinical record shows its ORIGINAL author. When the
// author cannot be resolved (a legacy row, a blank name, a failed roster read)
// the honest label is "Unknown author", never the viewer ("You"), which would
// attribute a colleague's record to whoever is looking at it.
export const UNKNOWN_AUTHOR = "Unknown author";

export function authorLabel(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : UNKNOWN_AUTHOR;
}
