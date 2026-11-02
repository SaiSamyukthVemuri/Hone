"use server";

import { createClient } from "@/lib/supabase/server";
import { getReceptionistWithStudio } from "@/lib/desk/guard";
import {
  parseDeskDirectoryInput,
  readDeskDirectory,
  type DeskDirectoryInput,
  type DeskDirectoryPage,
  type DeskRpc,
} from "@/lib/desk/read";

// The desk directory's search and paging, as a server action. The typed term travels in the POST
// body of the action request, never in a URL (Privacy R5): not in the address bar, not in history,
// not in a Referer, not in a navigation breadcrumb or a span URL. The response carries one page of
// the projected rows. Every failure is the same fixed state: no term, name, email or phone is ever
// in a message, a log line or a thrown error.

export type DeskDirectoryState =
  | { status: "idle" }
  | { status: "ok"; input: DeskDirectoryInput; data: DeskDirectoryPage }
  | { status: "too_short"; input: DeskDirectoryInput }
  | { status: "unavailable" };

export async function searchDeskClientsAction(
  _previous: DeskDirectoryState,
  formData: FormData,
): Promise<DeskDirectoryState> {
  try {
    // A server action cannot rely on a layout or page guard: it resolves identity itself.
    const identity = await getReceptionistWithStudio();
    const input = parseDeskDirectoryInput({
      q: formData.get("q"),
      filters: formData.getAll("filter"),
      sort: formData.get("sort"),
      page: formData.get("page"),
    });
    // One character is not a search (the database requires 2): say so, do not call it and do not
    // report the service as unavailable.
    if (input.q.length === 1) return { status: "too_short", input };
    const supabase = (await createClient()) as unknown as DeskRpc;
    const data = await readDeskDirectory(supabase, identity.studioId, input);
    return { status: "ok", input, data };
  } catch {
    return { status: "unavailable" };
  }
}
