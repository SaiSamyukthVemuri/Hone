// The Leave dialog's copy for the unsaved-changes guard. With one dirty form the wording is the original; with several, ONE dialog
// covers them all, so it says so and counts them instead of speaking as the first form (Insurance final418 C1, #1369).
export function leaveDialogCopy(dirtyCount: number): { title: string; description: string } {
  if (dirtyCount > 1) {
    return {
      title: "Leave without saving?",
      description: `You have unsaved changes in ${dirtyCount} blocks on this page. If you leave, all of them will be lost.`,
    };
  }
  return {
    title: "Leave without saving?",
    description: "You have unsaved changes. If you leave, they will be lost.",
  };
}
