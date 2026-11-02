"use client";

import { useRouter } from "next/navigation";
import { Delaunay } from "d3-delaunay";
import { useEffect, useRef, useState } from "react";
import { duration, headUrl, num } from "@/lib/format";
import type { LinkCounts, LinkKind } from "@/lib/connectionWeights";

export interface GraphNode {
  id: string;
  name: string;
  uuid: string;
  online: boolean;
  live: boolean;
}

/** Verbindung mit den Punkten nach der eingestellten Gewichtung */
export interface GraphEdge extends LinkCounts {
  weight: number;
  /** Art mit den meisten Punkten (Linienfarbe) */
  kind: LinkKind;
}

interface Node extends GraphNode {
  /** Position in Weltkoordinaten; gezeichnet wird über eine Ansicht, die das ganze Netz ins Canvas einpasst */
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  degree: number;
  img: HTMLImageElement;
}

interface Tip {
  x: number;
  y: number;
  name: string;
  live: boolean;
  lines: { name: string; text: string }[];
}

/** Text für eine Verbindung aus Sicht von `self` */
function describe(e: GraphEdge, self: string) {
  const mine = self === e.a;
  const raidsOut = mine ? e.raidsAB : e.raidsBA;
  const raidsIn = mine ? e.raidsBA : e.raidsAB;
  const msgsOut = mine ? e.msgsAB : e.msgsBA;
  const msgsIn = mine ? e.msgsBA : e.msgsAB;
  const parts: string[] = [];
  if (raidsOut) parts.push(`${num(raidsOut)}× geraidet`);
  if (raidsIn) parts.push(`${num(raidsIn)}× geraidet worden`);
  if (e.chats) parts.push(`${num(e.chats)}× geteilter Chat (${duration(e.chatSeconds)})${e.now ? ", gerade" : ""}`);
  if (msgsOut) parts.push(`${num(msgsOut)} Nachr. in dessen Chat`);
  if (msgsIn) parts.push(`${num(msgsIn)} Nachr. im eigenen Chat`);
  return parts.join(" · ");
}

/** Rand um das Netz im Canvas (Platz für Namen über den Köpfen) */
const PAD = 36;
const MAX_SCALE = 1.6;
/** Reichweite eines Kopfs für sein Gebiet (Bildschirm-Pixel): weit genug, dass nahe Köpfe ohne Lücke verbinden */
const REACH = 80;
/** Reichweite der Abstoßung in Weltkoordinaten */
const REPEL_RANGE = 420;

/**
 * Kräfte-Simulation auf Canvas. Knoten = Spieler (Kopf), Linien = Raids, geteilte Chats und Nachrichten im Chat
 * des anderen. Je mehr Punkte, desto dicker die Linie und desto stärker ziehen sich die beiden an.
 * Die Simulation läuft ohne Wände; danach wird das ganze Netz ins Canvas eingepasst, so nutzt es die Fläche aus.
 */
export function ConnectionGraph({
  nodes,
  edges,
  focus = null,
  colorOf = null,
  hrefOf = null,
  territoryOf = null,
  roleOf = null,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  focus?: string | null;
  /** Rahmenfarbe je Spieler als CSS-Variable (z. B. Gruppe); ersetzt dann die Live-Farbe */
  colorOf?: ((id: string) => string | null) | null;
  /** Ziel beim Anklicken (Standard: Profil des Spielers) */
  hrefOf?: ((id: string) => string) | null;
  /** Gebiet: weiche Fläche in dieser Farbe (CSS-Variable) hinter dem Kopf; Köpfe derselben Farbe verschmelzen zu einem Gebiet */
  territoryOf?: ((id: string) => string | null) | null;
  /** Rolle in der Gruppe als Rahmenform (Anführer mit Krone, Kern dick, Rand gestrichelt) */
  roleOf?: ((id: string) => "anfuehrer" | "kern" | "mitglied" | "rand" | null) | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  /** Positionen über Änderungen der Einstellungen hinweg: Das Netz ordnet sich nur neu, statt neu zu beginnen */
  const positions = useRef(new Map<string, { x: number; y: number }>());
  /** Hervorgehobener Spieler; als Ref, damit ein Wechsel die Simulation nicht neu startet */
  const focusRef = useRef(focus);
  useEffect(() => {
    focusRef.current = focus;
  }, [focus]);
  const colorRef = useRef(colorOf);
  const hrefRef = useRef(hrefOf);
  const territoryRef = useRef(territoryOf);
  const roleRef = useRef(roleOf);
  useEffect(() => {
    colorRef.current = colorOf;
    hrefRef.current = hrefOf;
    territoryRef.current = territoryOf;
    roleRef.current = roleOf;
  }, [colorOf, hrefOf, territoryOf, roleOf]);
  const router = useRouter();
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = () => canvas.width / dpr;
    const H = () => canvas.height / dpr;
    const resize = () => {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
    };
    resize();

    const weight = new Map<string, number>();
    const degree = new Map<string, number>();
    for (const e of edges) {
      for (const id of [e.a, e.b]) {
        weight.set(id, (weight.get(id) ?? 0) + e.weight);
        degree.set(id, (degree.get(id) ?? 0) + 1);
      }
    }
    // Bekannte Knoten behalten ihren Platz. Neue starten neben einem bekannten Nachbarn, sonst auf einer Spirale
    // (gleichmäßig verteilt, ohne dass zwei Knoten aufeinander liegen).
    const saved = positions.current;
    const known = nodes.some((n) => saved.has(n.id));
    const near = (id: string) => {
      for (const e of edges) {
        const other = e.a === id ? e.b : e.b === id ? e.a : null;
        const p = other && saved.get(other);
        if (p) return { x: p.x + (Math.random() - 0.5) * 60, y: p.y + (Math.random() - 0.5) * 60 };
      }
      return null;
    };
    const ns: Node[] = nodes.map((n, i) => {
      const a = i * 2.39996;
      const rad = 24 * Math.sqrt(i + 1);
      const pos = saved.get(n.id) ?? near(n.id) ?? { x: Math.cos(a) * rad, y: Math.sin(a) * rad };
      const img = new Image();
      img.src = headUrl(n.uuid, 64, n.id);
      const w = weight.get(n.id) ?? 0;
      return { ...n, ...pos, vx: 0, vy: 0, r: 11 + Math.min(13, Math.sqrt(w) * 2), degree: degree.get(n.id) ?? 1, img };
    });
    const byId = new Map(ns.map((n) => [n.id, n]));
    const es = edges.map((e) => ({ ...e, A: byId.get(e.a)!, B: byId.get(e.b)! })).filter((e) => e.A && e.B);
    const maxW = Math.max(1, ...es.map((e) => e.weight));
    const neighbours = new Map<Node, Set<Node>>();
    for (const e of es) {
      if (!neighbours.has(e.A)) neighbours.set(e.A, new Set());
      if (!neighbours.has(e.B)) neighbours.set(e.B, new Set());
      neighbours.get(e.A)!.add(e.B);
      neighbours.get(e.B)!.add(e.A);
    }

    // Ansicht: Welt -> Bildschirm. Folgt dem Netz weich, damit nichts springt.
    const view = { s: 1, x: 0, y: 0 };
    let viewReady = false;
    const fit = (smooth: boolean) => {
      if (!ns.length) return;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const n of ns) {
        x0 = Math.min(x0, n.x - n.r);
        y0 = Math.min(y0, n.y - n.r);
        x1 = Math.max(x1, n.x + n.r);
        y1 = Math.max(y1, n.y + n.r);
      }
      const s = Math.min(MAX_SCALE, (W() - PAD * 2) / Math.max(1, x1 - x0), (H() - PAD * 2) / Math.max(1, y1 - y0));
      const tx = W() / 2 - ((x0 + x1) / 2) * s;
      const ty = H() / 2 + 6 - ((y0 + y1) / 2) * s;
      const k = smooth && viewReady ? 0.12 : 1;
      view.s += (s - view.s) * k;
      view.x += (tx - view.x) * k;
      view.y += (ty - view.y) * k;
      viewReady = true;
    };
    const sx = (n: Node) => n.x * view.s + view.x;
    const sy = (n: Node) => n.y * view.s + view.y;
    /** Kopfgröße auf dem Bildschirm: schrumpft mit dem Netz (Handy), damit Köpfe nicht überlappen; mindestens 9 px */
    const sr = (n: Node) => Math.max(4.5, n.r * Math.min(1, view.s * 1.3));

    let drag: Node | null = null;
    /** Gebiete: Flächen (halbdurchsichtig drübergelegt) und Grenzlinien, je als eigene Ebene, nur nach Bewegung neu */
    let fillLayer: HTMLCanvasElement | null = null;
    let lineLayer: HTMLCanvasElement | null = null;
    let frame = 0;
    let terrSum = NaN;
    const layer = (c: HTMLCanvasElement | null) => {
      const cv = c && c.width === canvas.width && c.height === canvas.height ? c : document.createElement("canvas");
      cv.width = canvas.width;
      cv.height = canvas.height;
      return cv;
    };
    /**
     * Voronoi-Gebiete: jeder Kopf bekommt die Fläche, die ihm näher ist als jedem anderen, begrenzt auf einen Kreis
     * von REACH Pixeln (weich auslaufend). Flächen einer Gruppe verschmelzen; zwischen verschiedenen Gruppen eine
     * dünne Grenzlinie. Vektorgrafik, also glatt statt pixelig.
     */
    const paintTerritories = (territory: (id: string) => string | null, color: (n: string) => string) => {
      const pts = ns.map((n) => ({ x: sx(n), y: sy(n), key: territory(n.id) })).filter((p): p is { x: number; y: number; key: string } => p.key !== null);
      fillLayer = layer(fillLayer);
      lineLayer = layer(lineLayer);
      const f = fillLayer.getContext("2d");
      const l = lineLayer.getContext("2d");
      if (!f || !l) return;
      for (const c of [f, l]) {
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, canvas.width, canvas.height);
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      if (pts.length === 0) return;
      const vor = Delaunay.from(pts, (p) => p.x, (p) => p.y).voronoi([-REACH, -REACH, W() + REACH, H() + REACH]);
      // Flächen deckend zeichnen (die Ebene wird später halbdurchsichtig gelegt, so entstehen keine Nähte)
      pts.forEach((p, i) => {
        f.save();
        f.beginPath();
        vor.renderCell(i, f);
        f.clip();
        const g = f.createRadialGradient(p.x, p.y, 0, p.x, p.y, REACH);
        const c = color(p.key);
        g.addColorStop(0, c);
        g.addColorStop(0.7, c);
        g.addColorStop(1, "rgba(0,0,0,0)");
        f.fillStyle = g;
        f.beginPath();
        f.arc(p.x, p.y, REACH, 0, Math.PI * 2);
        f.fill();
        f.restore();
      });
      // Grenzen: gemeinsame Kante zweier Zellen verschiedener Gruppen, nur soweit eine der Flächen reicht
      l.strokeStyle = color("--line");
      l.globalAlpha = 0.35;
      l.lineWidth = 1.2;
      const poly = pts.map((_, i) => vor.cellPolygon(i));
      const keyOf = (pt: number[]) => `${Math.round(pt[0] * 100)}|${Math.round(pt[1] * 100)}`;
      for (let i = 0; i < pts.length; i++) {
        for (const j of vor.delaunay.neighbors(i)) {
          if (j <= i || pts[i].key === pts[j].key || !poly[i] || !poly[j]) continue;
          const mine = new Set(poly[j].map(keyOf));
          const shared = poly[i].slice(0, -1).filter((pt) => mine.has(keyOf(pt)));
          if (shared.length < 2) continue;
          l.save();
          l.beginPath();
          l.arc(pts[i].x, pts[i].y, REACH * 0.92, 0, Math.PI * 2);
          l.moveTo(pts[j].x + REACH * 0.92, pts[j].y);
          l.arc(pts[j].x, pts[j].y, REACH * 0.92, 0, Math.PI * 2);
          l.clip();
          l.beginPath();
          l.moveTo(shared[0][0], shared[0][1]);
          l.lineTo(shared[1][0], shared[1][1]);
          l.stroke();
          l.restore();
        }
      }
    };
    let hover: Node | null = null;
    /** Zuletzt angetippter Kopf (Touch) */
    let tapped: Node | null = null;
    let running = true;
    // Mit bekannten Positionen nur sanft nachordnen
    let alpha = known ? 0.5 : 1;
    let moved = false;

    const step = () => {
      // Abstoßung zwischen allen Knoten (wie d3 manyBody), Anziehung entlang der Linien, sanfter Zug zur Mitte
      for (let i = 0; i < ns.length; i++) {
        const a = ns[i];
        for (let j = i + 1; j < ns.length; j++) {
          const b = ns[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 1;
          }
          // Reichweite begrenzt: Sonst drückt das große Netz kleine, abgetrennte Gruppen weit an den Rand
          if (d2 < REPEL_RANGE * REPEL_RANGE) {
            const f = (-(700 + (a.r + b.r) * 16) * alpha) / d2;
            a.vx -= dx * f;
            a.vy -= dy * f;
            b.vx += dx * f;
            b.vy += dy * f;
          }
          // Köpfe überlappen nicht
          const min = a.r + b.r + 22;
          if (d2 < min * min) {
            const d = Math.sqrt(d2);
            const push = ((min - d) / d) * 0.5;
            a.x += dx * push * 0.5;
            a.y += dy * push * 0.5;
            b.x -= dx * push * 0.5;
            b.y -= dy * push * 0.5;
          }
        }
      }
      for (const e of es) {
        const s = Math.sqrt(e.weight / maxW);
        const len = 150 - s * 80 + e.A.r + e.B.r;
        const strength = (0.25 + 0.75 * s) / Math.min(e.A.degree, e.B.degree);
        const dx = e.B.x + e.B.vx - e.A.x - e.A.vx;
        const dy = e.B.y + e.B.vy - e.A.y - e.A.vy;
        const d = Math.hypot(dx, dy) || 1;
        const f = ((d - len) / d) * alpha * strength * 0.5;
        e.B.vx -= dx * f;
        e.B.vy -= dy * f;
        e.A.vx += dx * f;
        e.A.vy += dy * f;
      }
      // Senkrecht stärker zur Mitte ziehen als waagerecht: Das Netz bekommt das Seitenverhältnis des Canvas
      const aspect = Math.max(0.4, Math.min(2.5, W() / H()));
      for (const n of ns) {
        n.vx -= n.x * 0.02 * alpha;
        n.vy -= n.y * 0.02 * aspect * aspect * alpha;
        if (n === drag) {
          n.vx = n.vy = 0;
          continue;
        }
        n.vx *= 0.6;
        n.vy *= 0.6;
        n.x += n.vx;
        n.y += n.vy;
      }
      alpha = Math.max(0, alpha - 0.0035);
    };
    const draw = () => {
      // Farben jedes Mal frisch lesen, damit der Theme-Wechsel sofort greift
      const css = getComputedStyle(document.documentElement);
      const color = (n: string) => css.getPropertyValue(n).trim();
      const ink = color("--ink");
      const paper = color("--paper");
      const line = color("--line");
      const kindColor = { raid: color("--twitch"), shared: color("--diamond"), msgs: color("--gold") };
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W(), H());
      const base = es.length > 150 ? 0.4 : 0.55;
      // Überfahrener Kopf, sonst der im Auswahlfeld hervorgehobene Spieler
      const hl = hover ?? (focusRef.current ? (byId.get(focusRef.current) ?? null) : null);
      // Gebiete (siehe paintTerritories): nur nach Bewegung neu, höchstens jedes zweite Bild; sonst die fertigen Ebenen
      const territory = territoryRef.current;
      if (territory) {
        frame++;
        let sum = 0;
        for (const n of ns) sum += Math.round(sx(n)) * 7 + Math.round(sy(n)) * 13;
        const stale = !fillLayer || fillLayer.width !== canvas.width || fillLayer.height !== canvas.height;
        if (stale || (sum !== terrSum && frame % 2 === 0)) {
          paintTerritories(territory, color);
          terrSum = sum;
        }
        if (fillLayer && lineLayer) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalAlpha = 0.24;
          ctx.drawImage(fillLayer, 0, 0);
          ctx.globalAlpha = 1;
          ctx.drawImage(lineLayer, 0, 0);
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
      }
      for (const e of es) {
        const active = hl && (e.A === hl || e.B === hl);
        ctx.strokeStyle = e.now ? color("--grass") : kindColor[e.kind];
        ctx.globalAlpha = hl ? (active ? 0.95 : 0.05) : base;
        ctx.lineWidth = 1.2 + Math.sqrt(e.weight / maxW) * 7;
        ctx.beginPath();
        ctx.moveTo(sx(e.A), sy(e.A));
        ctx.lineTo(sx(e.B), sy(e.B));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.font = `700 12px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = "center";
      const labels: Node[] = [];
      for (const n of ns) {
        const dim = hl && n !== hl && !neighbours.get(hl)?.has(n);
        const x = sx(n);
        const y = sy(n);
        const r = sr(n);
        const role = roleRef.current?.(n.id) ?? null;
        ctx.globalAlpha = dim ? 0.2 : role === "rand" ? 0.8 : 1;
        // Rahmen: lila, wenn gerade live
        const own = colorRef.current?.(n.id);
        ctx.fillStyle = own ? color(own) : n.live ? color("--twitch") : paper;
        // Gruppenfarbe als breiterer Rahmen, damit sie auch bei kleinen Köpfen erkennbar ist; Rolle als Rahmenform
        const f = own ? 5 : role === "anfuehrer" || role === "kern" ? 4 : 3;
        ctx.fillRect(x - r - f, y - r - f, r * 2 + f * 2, r * 2 + f * 2);
        ctx.strokeStyle = line;
        ctx.lineWidth = role === "anfuehrer" || role === "kern" ? 4 : 2;
        if (role === "rand") ctx.setLineDash([4, 3]);
        ctx.strokeRect(x - r - f, y - r - f, r * 2 + f * 2, r * 2 + f * 2);
        ctx.setLineDash([]);
        if (role === "anfuehrer") {
          // Krone über dem Kopf
          const w = Math.max(8, r * 0.9);
          const top = y - r - f - 4;
          ctx.fillStyle = color("--gold");
          ctx.beginPath();
          ctx.moveTo(x - w, top);
          ctx.lineTo(x - w, top - w * 0.7);
          ctx.lineTo(x - w / 2, top - w * 0.35);
          ctx.lineTo(x, top - w * 0.85);
          ctx.lineTo(x + w / 2, top - w * 0.35);
          ctx.lineTo(x + w, top - w * 0.7);
          ctx.lineTo(x + w, top);
          ctx.closePath();
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.imageSmoothingEnabled = false;
        if (n.img.complete && n.img.naturalWidth) ctx.drawImage(n.img, x - r, y - r, r * 2, r * 2);
        else {
          ctx.fillStyle = color("--ender");
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
        if (n.online) {
          ctx.fillStyle = color("--grass");
          ctx.fillRect(x + r - 3, y + r - 3, 8, 8);
          ctx.strokeRect(x + r - 3, y + r - 3, 8, 8);
        }
        // Namen nur beim überfahrenen bzw. hervorgehobenen Kopf, sonst verdecken sie das Netz (Name steht im Tooltip)
        if (n === hl) labels.push(n);
      }
      // Name zuletzt, damit keine Linie oder kein Kopf darüber liegt
      ctx.globalAlpha = 1;
      for (const n of labels) {
        const y = sy(n) - sr(n) - 8;
        ctx.fillStyle = ink;
        ctx.strokeStyle = paper;
        ctx.lineWidth = 3;
        ctx.strokeText(n.name, sx(n), y);
        ctx.fillText(n.name, sx(n), y);
      }
      if (!ns.length) {
        ctx.fillStyle = ink;
        ctx.font = `14px ${getComputedStyle(document.body).fontFamily}`;
        ctx.textAlign = "left";
        ctx.fillText("In diesem Zeitraum gab es keine Raids, geteilten Chats oder Nachrichten.", 20, 30);
      }
    };
    // Vorlauf ohne Zeichnen: Das Netz erscheint gleich halbwegs geordnet statt als Knäuel
    if (!known) for (let i = 0; i < 120; i++) step();
    const loop = () => {
      if (!running) return;
      if (alpha > 0 || drag) step();
      if (!drag) fit(true);
      draw();
      requestAnimationFrame(loop);
    };
    const point = (ev: PointerEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [ev.clientX - r.left, ev.clientY - r.top];
    };
    const find = ([x, y]: [number, number]) => {
      // Oben liegende (zuletzt gezeichnete) Köpfe zuerst
      for (let i = ns.length - 1; i >= 0; i--) {
        const n = ns[i];
        const r = sr(n) + 4;
        if (Math.abs(sx(n) - x) <= r && Math.abs(sy(n) - y) <= r) return n;
      }
      return null;
    };
    const showTip = (n: Node | null) => {
      if (!n) return setTip(null);
      const lines = es
        .filter((e) => e.A === n || e.B === n)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 6)
        .map((e) => ({ name: (e.A === n ? e.B : e.A).name, text: describe(e, n.id) }));
      setTip({ x: sx(n), y: sy(n) - sr(n) - 12, name: n.name, live: n.live, lines });
    };
    const onDown = (ev: PointerEvent) => {
      drag = find(point(ev));
      moved = false;
      if (drag) canvas.setPointerCapture(ev.pointerId);
    };
    const onMove = (ev: PointerEvent) => {
      const p = point(ev);
      if (drag) {
        moved = true;
        drag.x = (p[0] - view.x) / view.s;
        drag.y = (p[1] - view.y) / view.s;
        alpha = Math.max(alpha, 0.3);
      }
      const h = drag ?? find(p);
      if (h !== hover) {
        hover = h;
        showTip(h);
      } else if (drag) showTip(drag);
      canvas.style.cursor = drag ? "grabbing" : hover ? "pointer" : "default";
    };
    const onUp = (ev: PointerEvent) => {
      const was = drag;
      drag = null;
      if (!was || moved || find(point(ev)) !== was) return;
      // Touch hat kein Überfahren: erstes Tippen zeigt Name und Verbindungen, zweites öffnet das Profil
      if (ev.pointerType !== "mouse" && tapped !== was) {
        tapped = was;
        hover = was;
        showTip(was);
        return;
      }
      router.push(hrefRef.current?.(was.id) ?? `/spieler/${encodeURIComponent(was.id)}`);
    };
    const onLeave = () => {
      if (drag) return;
      hover = null;
      setTip(null);
    };
    const onResize = () => {
      resize();
      fit(false);
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    window.addEventListener("resize", onResize);
    loop();
    return () => {
      running = false;
      for (const n of ns) saved.set(n.id, { x: n.x, y: n.y });
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("resize", onResize);
    };
  }, [nodes, edges, router]);

  return (
    <div className="conn__stage">
      <canvas
        ref={ref}
        className="conn__canvas"
        aria-label="Netz der Spieler: Raids, geteilte Chats und Nachrichten im Chat des anderen"
      />
      {tip && (
        <div className="conn__tip" style={{ left: tip.x, top: tip.y }} role="status">
          <b>
            {tip.name}
            {tip.live && <span className="muted"> · live</span>}
          </b>
          {tip.lines.map((l) => (
            <span key={l.name} className="conn__tipline">
              {l.name}: {l.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
