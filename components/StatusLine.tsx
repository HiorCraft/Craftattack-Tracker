import type { TrackerState } from "@/lib/types";
import { ago } from "@/lib/format";

export function StatusLine({ state }: { state: TrackerState }) {
  const s = state.latest;
  let dot = "dot--warn";
  let text = "Warte auf die erste Abfrage";
  if (s) {
    if (state.lastError) {
      dot = "dot--warn";
      text = `Verbindung hakt gerade (${state.lastError}), Stand ${ago(state.lastOk)}`;
    } else if (s.serverOnline) {
      dot = "";
      text = `Server online · aktualisiert ${ago(s.updatedAt)}`;
    } else {
      dot = "dot--off";
      text = `Server offline · letzter Stand ${ago(s.updatedAt)}`;
    }
  } else if (state.lastError) {
    text = `Keine Verbindung: ${state.lastError}`;
  }
  return (
    <p className="st-status">
      <span className={`dot ${dot}`} aria-hidden="true" />
      <span>{text}</span>
      <span className="tag" data-tone="ink">
        {state.polls} Abfragen
      </span>
    </p>
  );
}
