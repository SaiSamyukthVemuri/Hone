// What the session charting page shows for the Current / New switch, decided in one place so the kill switch can be
// tested end to end. `readMetadata` is called ONLY when the switch is available, so a hidden switch costs no extra
// read, and a stored "new" can never leak through a closed gate. A failed read means Current.
import { resolveChartingView, type ChartingView } from "@/lib/charting/view-preference";

export async function chartingViewForPage(o: {
  studioId: string | null | undefined;
  rawGate: string | undefined | null;
  readMetadata: () => Promise<unknown>;
}): Promise<{ toggleVisible: boolean; view: ChartingView }> {
  if (!resolveChartingView(undefined, o.studioId, o.rawGate).toggleVisible) {
    return { toggleVisible: false, view: "current" };
  }
  let metadata: unknown;
  try {
    metadata = await o.readMetadata();
  } catch {
    metadata = undefined;
  }
  return { toggleVisible: true, view: resolveChartingView(metadata, o.studioId, o.rawGate).view };
}
