import type { SVGProps } from "react";
import type { BoardKey, EventType } from "@/lib/types";

type P = SVGProps<SVGSVGElement>;
const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "square", strokeLinejoin: "miter" } as const;

export const Icon = {
  clock: (p: P) => (
    <svg {...base} {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  ),
  diamond: (p: P) => (
    <svg {...base} {...p}>
      <path d="M3 9l4-5h10l4 5-9 11z" />
      <path d="M3 9h18M9 4l3 16 3-16" />
    </svg>
  ),
  skull: (p: P) => (
    <svg {...base} {...p}>
      <path d="M12 3a8 8 0 0 1 8 8v2l-2 2v3h-3v2H9v-2H6v-3l-2-2v-2a8 8 0 0 1 8-8z" />
      <circle cx="9" cy="11" r="1.5" fill="currentColor" />
      <circle cx="15" cy="11" r="1.5" fill="currentColor" />
      <path d="M11 15h2" />
    </svg>
  ),
  pickaxe: (p: P) => (
    <svg {...base} {...p}>
      <path d="M3 21l9-9" />
      <path d="M9 6c3-2 7-2 10 1-1 3-1 7 1 10" />
      <path d="M12 12l3-3" />
    </svg>
  ),
  sword: (p: P) => (
    <svg {...base} {...p}>
      <path d="M4 20l3-3M7 17l10-10 3-1-1 3L9 19z" />
      <path d="M5 15l4 4" />
    </svg>
  ),
  boots: (p: P) => (
    <svg {...base} {...p}>
      <path d="M6 3h6v8l6 3v4H6z" />
      <path d="M6 14h6" />
    </svg>
  ),
  login: (p: P) => (
    <svg {...base} {...p}>
      <path d="M10 17l5-5-5-5M15 12H3" />
      <path d="M13 4h6v16h-6" />
    </svg>
  ),
  logout: (p: P) => (
    <svg {...base} {...p}>
      <path d="M17 17l5-5-5-5M22 12H10" />
      <path d="M11 4H5v16h6" />
    </svg>
  ),
  twitch: (p: P) => (
    <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
      <path d="M4 2 2 6v14h5v3h3l3-3h4l5-5V2H4zm16 12-3 3h-5l-3 3v-3H6V4h14v10zM14 7h2v5h-2V7zm-5 0h2v5H9V7z" />
    </svg>
  ),
  tag: (p: P) => (
    <svg {...base} {...p}>
      <path d="M3 3h9l9 9-9 9-9-9z" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
    </svg>
  ),
  gift: (p: P) => (
    <svg {...base} {...p}>
      <path d="M3 10h18v11H3zM2 6h20v4H2zM12 6v15" />
      <path d="M12 6H8.5a2.5 2.5 0 1 1 2.5-2.5V6zm0 0h3.5a2.5 2.5 0 1 0-2.5-2.5V6z" />
    </svg>
  ),
  raid: (p: P) => (
    <svg {...base} {...p}>
      <circle cx="7" cy="8" r="3" />
      <path d="M2 20c0-3 2-5 5-5s5 2 5 5M13 8h8m-3-3 3 3-3 3" />
    </svg>
  ),
  server: (p: P) => (
    <svg {...base} {...p}>
      <rect x="3" y="4" width="18" height="6" />
      <rect x="3" y="14" width="18" height="6" />
      <path d="M7 7h.01M7 17h.01" />
    </svg>
  ),
  eye: (p: P) => (
    <svg {...base} {...p}>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  bolt: (p: P) => (
    <svg {...base} {...p}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
    </svg>
  ),
  discord: (p: P) => (
    <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
      <path d="M19.5 5.3A17 17 0 0 0 15.4 4l-.5 1a16 16 0 0 0-5.8 0l-.5-1a17 17 0 0 0-4.1 1.3C1.9 9.2 1.2 13 1.5 16.7A17 17 0 0 0 6.6 19l1-1.6a11 11 0 0 1-1.7-.8l.4-.3a12 12 0 0 0 11.4 0l.4.3-1.7.8 1 1.6a17 17 0 0 0 5.1-2.3c.4-4.3-.7-8-3-11.4ZM8.7 14.4c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z" />
    </svg>
  ),
  github: (p: P) => (
    <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
      <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.4-1.1-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.2-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .9-.3 2.8 1a9.5 9.5 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.8-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2Z" />
    </svg>
  ),
  trophy: (p: P) => (
    <svg {...base} {...p}>
      <path d="M7 3h10v5a5 5 0 0 1-10 0z" />
      <path d="M7 5H3v2a4 4 0 0 0 4 4M17 5h4v2a4 4 0 0 1-4 4" />
      <path d="M12 13v4M8 21h8M9 17h6v4H9z" />
    </svg>
  ),
  flag: (p: P) => (
    <svg {...base} {...p}>
      <path d="M5 21V4h12l-2 4 2 4H5" />
    </svg>
  ),
  users: (p: P) => (
    <svg {...base} {...p}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2 20c0-4 3-6 7-6s7 2 7 6" />
      <path d="M16 4a3.5 3.5 0 0 1 0 7M18 14c3 .5 4 2.5 4 6" />
    </svg>
  ),
};

export const BOARD_ICON: Record<BoardKey, keyof typeof Icon> = {
  playtimeSeconds: "clock",
  diamonds: "diamond",
  deaths: "skull",
  blocksBroken: "pickaxe",
  mobsKilled: "sword",
  distance: "boots",
};

export const EVENT_ICON: Record<EventType, keyof typeof Icon> = {
  join: "login",
  leave: "logout",
  afk_start: "clock",
  afk_mobs_start: "sword",
  afk_mobs_end: "sword",
  afk_blocks_start: "pickaxe",
  afk_blocks_end: "pickaxe",
  afk_end: "boots",
  death: "skull",
  diamonds: "diamond",
  blocksBroken: "pickaxe",
  mobsKilled: "sword",
  distance: "boots",
  stream_start: "twitch",
  stream_end: "twitch",
  stream_title: "tag",
  subscription: "gift",
  subscription_gift: "gift",
  follower_burst: "users",
  raid: "raid",
  server_online: "server",
  server_offline: "server",
  tracker_start: "bolt",
  first_join: "users",
  rank: "trophy",
  milestone: "flag",
  record: "bolt",
};
