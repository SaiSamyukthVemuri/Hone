import { PendingButton } from "@/components/pending-button";
import { unarchiveClientAction } from "./[id]/actions";

// The archived-row Unarchive control, kept in its own module so UI-04's contract
// (PendingButton, no className, the action and its hidden field unchanged) is
// pinned against exactly this form.
export function UnarchiveRowControl({ client }: { client: { id: string } }) {
  return (
    <form action={unarchiveClientAction}>
      <input type="hidden" name="client_id" value={client.id} />
      <PendingButton variant="primary" size="sm">
        Unarchive
      </PendingButton>
    </form>
  );
}
