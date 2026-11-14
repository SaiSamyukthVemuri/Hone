import { RESTRICTED_COPY } from "@/lib/permissions/gated";

// The single restricted-state display. It takes no data, so a call site cannot leak a count, name, date or list through it.
export function RestrictedNote({ testId, className }: { testId?: string; className?: string }) {
  return (
    <p role="status" data-testid={testId ?? "restricted-note"} className={className ?? "text-sm text-neutral-500"}>
      {RESTRICTED_COPY}
    </p>
  );
}
