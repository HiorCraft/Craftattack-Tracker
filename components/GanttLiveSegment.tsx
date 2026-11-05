"use client";

import { useState } from "react";
import type { CSSProperties, MouseEvent, PointerEvent } from "react";

interface Props {
  vodId: string | null;
  startOffset: number | null;
  start: number;
  end: number;
  style: CSSProperties;
  edge?: string;
  tip: string;
}

function vodUrl(vodId: string, offset: number) {
  const seconds = Math.max(0, Math.floor(offset));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `https://www.twitch.tv/videos/${encodeURIComponent(vodId)}?t=${hours}h${minutes}m${remainder}s`;
}

export function GanttLiveSegment({ vodId, startOffset, start, end, style, edge, tip }: Props) {
  const [cursorRatio, setCursorRatio] = useState<number | null>(null);
  if (!vodId || startOffset === null) {
    return <span className="gantt__live tip" style={style} data-edge={edge} data-tip={tip} tabIndex={0} />;
  }

  const offsetAtRatio = (ratio: number) => startOffset + ((end - start) / 1000) * ratio;
  const cursorOffset = cursorRatio === null ? null : offsetAtRatio(cursorRatio);
  const cursorTime = cursorOffset === null ? null : new Date(cursorOffset * 1000).toISOString().slice(11, 19);
  const href = vodUrl(vodId, cursorOffset ?? startOffset);
  const trackPointer = (event: PointerEvent<HTMLAnchorElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width === 0) return;
    setCursorRatio(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)));
  };
  const openAtClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = event.detail === 0 || bounds.width === 0 ? 0 : Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    window.open(vodUrl(vodId, offsetAtRatio(ratio)), "_blank", "noopener,noreferrer");
  };
  const currentTip = cursorTime ? `${tip} · VOD ${cursorTime}` : tip;

  return (
    <a
      className="gantt__live tip"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${currentTip}, im VOD öffnen`}
      title={cursorTime ? `Im VOD bei ${cursorTime} öffnen` : "Im VOD an dieser Stelle öffnen"}
      style={style}
      data-edge={edge}
      data-tip={currentTip}
      onPointerMove={trackPointer}
      onPointerLeave={() => setCursorRatio(null)}
      onClick={openAtClick}
    >
      {cursorRatio !== null && <span className="gantt__live-cursor" aria-hidden="true" style={{ left: `${cursorRatio * 100}%` }} />}
    </a>
  );
}