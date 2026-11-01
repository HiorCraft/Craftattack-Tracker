import Link from "next/link";
import type { Clip } from "@/lib/clips";
import { ago, num } from "@/lib/format";
import { Head } from "./Head";

/** Clips als Kacheln mit Vorschaubild; Klick öffnet den Clip auf Twitch */
export function ClipGrid({ clips, showPlayer = true }: { clips: Clip[]; showPlayer?: boolean }) {
  if (!clips.length) return <p className="muted">Noch keine Clips.</p>;
  return (
    <ul className="clips">
      {clips.map((c) => (
        <li key={c.id} className="box clip" data-tone="white">
          <a className="clip__thumb" href={c.url} target="_blank" rel="noopener" title={`„${c.title}“ auf Twitch ansehen`}>
            {c.thumbnail ? <img src={c.thumbnail} alt="" width={480} height={272} loading="lazy" decoding="async" /> : <span className="clip__nothumb" />}
            <span className="clip__len num">{c.seconds} s</span>
            <span className="clip__views num">{num(c.views)} Aufrufe</span>
          </a>
          <div className="clip__body">
            <a className="clip__title" href={c.url} target="_blank" rel="noopener">
              {c.title}
            </a>
            <p className="muted clip__meta">
              {showPlayer && (
                <Link href={`/spieler/${encodeURIComponent(c.player)}`} className="clip__who">
                  <Head id={c.player} uuid={c.uuid} name={c.name} size={18} src={32} decorative /> {c.name}
                </Link>
              )}{" "}
              {ago(c.at)}
              {c.creator ? ` · geclippt von ${c.creator}` : ""}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
