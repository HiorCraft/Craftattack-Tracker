"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Timelapse as TimelapseData, TimelapseMessage } from "@/lib/analytics";
import { num } from "@/lib/format";
import { BOARD_TONE, METRIC_TONE } from "@/lib/statTone";
import { Head } from "./Head";

const tf = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const SPEEDS = [
  { label: "1×", ms: 500 },
  { label: "3×", ms: 170 },
  { label: "8×", ms: 60 },
];

/**
 * Der Tag im Schnelldurchlauf. Köpfe: hellblau = auf dem Server, grau = auf dem Server, aber AFK (grün: Mob-Farm, gelb: Block-Farm),
 * lila Ring = live auf Twitch (mit farbigem Kern: dabei auf dem Server; mit blassem Kopf: nur Stream).
 */
export function Timelapse({ data }: { data: TimelapseData }) {
  const { frames, players } = data;
  const firstActive = Math.max(
    0,
    frames.findIndex((f) => f.online.length > 0),
  );
  const [i, setI] = useState(firstActive);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [log, setLog] = useState<{ at: number; m: TimelapseMessage }[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!playing) return;
    timer.current = setInterval(() => {
      setI((cur) => {
        if (cur >= frames.length - 1) {
          setPlaying(false);
          return cur;
        }
        const next = cur + 1;
        const f = frames[next];
        if (f.messages.length) setLog((l) => [...f.messages.map((m) => ({ at: f.at, m })), ...l].slice(0, 8));
        return next;
      });
    }, SPEEDS[speed].ms);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, speed, frames]);

  const f = frames[i];
  const online = useMemo(() => new Set(f?.online ?? []), [f]);
  const live = useMemo(() => new Set(f?.live ?? []), [f]);
  const afk = useMemo(() => new Set(f?.afk ?? []), [f]);
  const afkMobs = useMemo(() => new Set(f?.afkMobs ?? []), [f]);
  const afkBlocks = useMemo(() => new Set(f?.afkBlocks ?? []), [f]);
  const farming = f ? f.afkMobs.length + f.afkBlocks.length : 0;
  const liveOnServer = f ? f.live.filter((k) => online.has(k)).length : 0;

  if (!frames.length) return <p className="st-online__empty">Für diesen Tag liegen keine Daten vor.</p>;

  const togglePlay = () => {
    if (playing) return setPlaying(false);
    if (i >= frames.length - 1) {
      setI(0);
      setLog([]);
    }
    setPlaying(true);
  };

  return (
    <div className="zr">
      <div className="zr__bar">
        <span className="zr__clock num">{tf.format(new Date(f.at))}</span>
        <span className="tag" data-tone={METRIC_TONE.onlineCount}>
          {num(f.online.length)} online
        </span>
        {f.afk.length > 0 && (
          <span className="tag" data-tone="idle" title="Auf dem Server, aber laut Server AFK (ab 5 Minuten ohne Bewegung) · davon an einer AFK-Farm">
            {num(f.afk.length)} AFK{farming > 0 ? ` · ${num(farming)} farmen` : ""}
          </span>
        )}
        <span className="tag" data-tone={METRIC_TONE.liveCount} title="Live auf Twitch · davon auf dem Server">
          {num(f.live.length)} live{f.live.length > 0 ? ` · ${num(liveOnServer)} auf dem Server` : ""}
        </span>
        <span className="tag" data-tone={METRIC_TONE.viewers}>
          {f.viewers !== null ? `${num(f.viewers)} Zuschauer` : "– Zuschauer"}
        </span>
        <span className="tag" data-tone={BOARD_TONE.deaths}>
          {f.deaths !== null ? `${num(f.deaths)} Tode` : "– Tode"}
        </span>
        <span className="zr__controls">
          <button type="button" className="btn btn--small" data-tone="ink" onClick={togglePlay} aria-pressed={playing}>
            {playing ? "❚❚ Pause" : i >= frames.length - 1 ? "↻ Nochmal" : "▶ Abspielen"}
          </button>
          <span className="gb__seg" role="group" aria-label="Geschwindigkeit">
            {SPEEDS.map((sp, k) => (
              <button key={sp.label} type="button" aria-pressed={speed === k} onClick={() => setSpeed(k)}>
                {sp.label}
              </button>
            ))}
          </span>
        </span>
      </div>
      <input
        className="zr__pos"
        type="range"
        min={0}
        max={frames.length - 1}
        value={i}
        aria-label="Uhrzeit"
        aria-valuetext={tf.format(new Date(f.at))}
        onChange={(e) => {
          setPlaying(false);
          setI(Number(e.target.value));
        }}
      />
      <div className="zr__axis num" aria-hidden="true">
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h}>{String(h).padStart(2, "0")}</span>
        ))}
      </div>
      {players.length === 0 ? (
        <p className="st-online__empty">An diesem Tag war niemand online.</p>
      ) : (
        <>
          <ul className="legend zr__legend" aria-label="Legende">
            <li>
              <i style={{ background: "var(--presence)" }} /> auf dem Server
            </li>
            <li>
              <i className="legend__afk" /> auf dem Server, AFK
            </li>
            <li>
              <i className="legend__afk legend__afk--mobs" /> AFK, farmt Mobs
            </li>
            <li>
              <i className="legend__afk legend__afk--blocks" /> AFK, baut Blöcke ab
            </li>
            <li>
              <i className="zr__legend-live" /> live, auf dem Server
            </li>
            <li>
              <i className="zr__legend-live zr__legend-live--off" /> live, nicht auf dem Server
            </li>
          </ul>
          <ul className="zr__heads" aria-label="Spieler">
            {players.map((p, k) => {
              const isOn = online.has(k);
              const isLive = live.has(k);
              const isAfk = afk.has(k);
              const farm = afkMobs.has(k) ? "mobs" : afkBlocks.has(k) ? "blocks" : null;
              const afkText = farm === "mobs" ? "AFK, farmt Mobs" : farm === "blocks" ? "AFK, baut Blöcke ab" : "AFK";
              const state = isLive && isOn ? (isAfk ? `live, auf dem Server, ${afkText}` : "live, auf dem Server") : isLive ? "live, nicht auf dem Server" : isAfk ? `auf dem Server, ${afkText}` : isOn ? "auf dem Server" : "";
              return (
                <li key={p.id} data-on={isOn ? "true" : undefined} data-afk={isAfk ? (farm ?? "true") : undefined} data-live={isLive ? "true" : undefined}>
                  <Link href={`/spieler/${encodeURIComponent(p.id)}`}>
                    <Head id={p.id} uuid={p.uuid} name={`${p.name}${state ? ` · ${state}` : ""}`} size={40} className="" />
                    {isAfk && (
                      <span className={farm ? "zr__afk zr__afk--farm" : "zr__afk"} aria-hidden="true">
                        {farm === "mobs" ? "MOBS" : farm === "blocks" ? "BLÖCKE" : "AFK"}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <ol className="zr__log" aria-live="polite" aria-label="Meldungen">
        {log.length === 0 && !playing && f.messages.length > 0
          ? f.messages.map((m, k) => (
              <li key={k}>
                <span className="num muted">{tf.format(new Date(f.at))}</span> <Message m={m} />
              </li>
            ))
          : log.map((m, k) => (
              <li key={`${m.at}-${k}`}>
                <span className="num muted">{tf.format(new Date(m.at))}</span> <Message m={m.m} />
              </li>
            ))}
      </ol>
    </div>
  );
}

/** Eine Zeitraffer-Meldung: Kopf statt Name, bei Toden durch Spieler der Mörder als zweiter Kopf */
function Message({ m }: { m: TimelapseMessage }) {
  return (
    <span className="zr__msg">
      {m.player && <Head id={m.player.id} uuid={m.player.uuid} name={m.player.name} size={20} src={32} />}
      <span>{m.text}</span>
      {m.killer && (
        <>
          <span aria-hidden="true">⚔</span>
          <Head id={m.killer.id} uuid={m.killer.uuid} name={`Getötet von ${m.killer.name}`} size={20} src={32} />
        </>
      )}
    </span>
  );
}
