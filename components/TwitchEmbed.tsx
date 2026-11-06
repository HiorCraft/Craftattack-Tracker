import { headers } from "next/headers";
import { TwitchGate } from "./TwitchGate";

/**
 * Twitch-Player + Live-Chat. Twitch verlangt den Hostnamen der einbettenden Seite als `parent`,
 * deshalb lesen wir ihn aus dem Request.
 */
export async function TwitchEmbed({ login, name }: { login: string; name: string }) {
  const host = (await headers()).get("host") ?? "localhost";
  const parent = host.split(":")[0];
  const q = `parent=${encodeURIComponent(parent)}`;
  return (
    <section className="block block--tight" data-tone="ink" aria-labelledby="tw-h">
      <div className="wrap">
        <div className="section-head" style={{ marginBottom: 16 }}>
          <h2 className="t-2" id="tw-h" style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span className="dot dot--live" style={{ width: 14, height: 14 }} /> Live-Stream
          </h2>
          <a className="btn btn--small" data-tone="twitch" href={`https://www.twitch.tv/${encodeURIComponent(login)}`} target="_blank" rel="noopener">
            Auf Twitch öffnen
          </a>
        </div>
        <TwitchGate
          name={name}
          playerSrc={`https://player.twitch.tv/?channel=${encodeURIComponent(login)}&${q}&muted=true&autoplay=true`}
          chatSrc={`https://www.twitch.tv/embed/${encodeURIComponent(login)}/chat?${q}&darkpopout`}
        />
        <p className="muted" style={{ marginTop: 12, fontSize: ".9375rem" }}>
          Player startet stumm. Chat-Nachrichten schreiben geht nur eingeloggt direkt auf Twitch.
        </p>
      </div>
    </section>
  );
}
