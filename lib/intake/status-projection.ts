// The ONE reader of the intake STATUS of clients (0334). It calls the definer projection public.intake_status_for_clients, which returns
// (client_id, status, created_at) of each client's newest non-deleted form to an active practitioner holding clin.view_intake_status or
// clin.view_intake, and ZERO rows to anyone else. It never returns `responses`: a status-only reader must not read client_intake_forms
// directly, because that table's SELECT policy now needs clin.view_intake (0334). Callers decide restricted-versus-none from their own
// permission check (the projection cannot tell them; an empty result is "nothing visible to you").

export type IntakeStatusProjectionRow = { client_id: string; status: string; created_at: string };
type RpcResult = { data: unknown; error: { message?: string | null } | null };
export type IntakeStatusRpc = {
  rpc: (fn: string, args: Record<string, unknown>) => { range: (from: number, to: number) => PromiseLike<RpcResult> };
};

export const INTAKE_STATUS_RPC = "intake_status_for_clients";
const CHUNK = 500; // client ids per call
const BLOCK = 1000; // rows per page (the API's own row ceiling); the function orders by client_id, so offset paging is stable
const MAX_BLOCKS = 50; // past this the read fails honestly (null) rather than undercount

/** Current intake status per client for the studio (all clients when `clientIds` is omitted); null when the read failed or hit the ceiling. */
export async function readIntakeStatusProjection(
  db: IntakeStatusRpc,
  studioId: string,
  clientIds?: readonly string[],
): Promise<IntakeStatusProjectionRow[] | null> {
  if (clientIds && clientIds.length === 0) return [];
  const chunks: Array<readonly string[] | null> = clientIds ? [] : [null];
  if (clientIds) for (let i = 0; i < clientIds.length; i += CHUNK) chunks.push(clientIds.slice(i, i + CHUNK));
  const out: IntakeStatusProjectionRow[] = [];
  for (const ids of chunks) {
    let done = false;
    for (let block = 0; block < MAX_BLOCKS && !done; block += 1) {
      const res = await db
        .rpc(INTAKE_STATUS_RPC, { p_studio_id: studioId, p_client_ids: ids ? [...ids] : null })
        .range(block * BLOCK, block * BLOCK + BLOCK - 1);
      if (res.error) return null;
      const rows = (res.data ?? []) as IntakeStatusProjectionRow[];
      out.push(...rows);
      if (rows.length < BLOCK) done = true;
    }
    if (!done) return null;
  }
  return out;
}
