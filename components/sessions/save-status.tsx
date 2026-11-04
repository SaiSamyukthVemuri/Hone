import { Button } from "@/components/ui/button";
import { isUnfinished, type SaveState } from "@/lib/sessions/save-state";

const LABEL: Record<SaveState["status"], string> = {
  unsaved: "Unsaved changes",
  saving: "Saving…",
  saved: "Saved",
  failed: "Couldn't save",
};

export function SaveStatus({
  state,
  onRetry,
}: {
  state: SaveState;
  onRetry?: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="save-status"
      data-state={state.status}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <span
        className={
          isUnfinished(state)
            ? "font-medium text-neutral-900 dark:text-neutral-100"
            : "text-neutral-600 dark:text-neutral-400"
        }
      >
        {LABEL[state.status]}
      </span>
      {state.status === "failed" && onRetry && (
        <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
