import { unarchiveClientAction } from "./[id]/actions";
import { UnarchiveClientForm } from "./UnarchiveClientForm";

// The archived-row Unarchive control, kept in its own module so UI-04's contract
// (PendingButton, no className, the action and its hidden field unchanged) is
// pinned against exactly this form.
export function UnarchiveRowControl({ client }: { client: { id: string } }) {
  return (
    <UnarchiveClientForm action={unarchiveClientAction} clientId={client.id} variant="primary" size="sm">
      Unarchive
    </UnarchiveClientForm>
  );
}
