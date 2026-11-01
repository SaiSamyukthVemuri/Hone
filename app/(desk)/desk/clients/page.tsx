import { createClient } from "@/lib/supabase/server";
import { requireReceptionistWithStudio } from "@/lib/desk/guard";
import { parseDeskDirectoryInput, readDeskDirectory, type DeskRpc } from "@/lib/desk/read";
import { DeskDirectory } from "./DeskDirectory";

// The restricted clients directory. The first page (no search term) is rendered here; every search,
// filter, sort and page after that goes through the server action, so a typed term is never in a
// URL (Privacy R5). This page takes no searchParams at all. There is no client profile page and no
// archived view (Privacy Q4, Q5): overview only.

export default async function DeskClientsPage() {
  const identity = await requireReceptionistWithStudio();
  const input = parseDeskDirectoryInput({});
  let initial = null;
  try {
    const supabase = (await createClient()) as unknown as DeskRpc;
    initial = await readDeskDirectory(supabase, identity.studioId, input);
  } catch {
    initial = null;
  }
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
        <p className="mt-1 text-sm text-neutral-500">Find a client to book or confirm contact details.</p>
      </div>
      <DeskDirectory initial={initial} />
    </div>
  );
}
