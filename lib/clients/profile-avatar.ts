// The client profile header avatar (PB). It is INITIALS ONLY and has no photo path at all: no portrait
// pointer, no signed URL, no identification-photo object. The ID-photo feature (held 0275) plugs in
// later, from Photos' files, behind its own database-off switch; this layout must work without it and
// without any 0275 object existing. Decorative: the full name is always printed beside it. Self-contained
// on purpose, so this PR depends on no other unmerged branch.
export function clientAvatarInitials(name: string | null | undefined): string {
  // Words that start with a letter or digit only: "(synthetic)" or "-" never becomes an initial.
  const words = (name ?? "").trim().split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
}
