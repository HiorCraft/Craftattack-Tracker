import Link from "next/link";
import { Icon } from "./Icons";
import { SOCIALS } from "@/lib/site";
import { HUBS } from "@/lib/hubs";
import { ESTIMATE } from "@/lib/estimateMode";

export function SiteFooter() {
  return (
    <footer className="site-foot" data-tone="ender">
      <div className="wrap site-foot__in">
        <div>
          <img className="site-foot__logo" src="/img/ca14-logo-320.webp" alt="" width={320} height={320} loading="lazy" decoding="async" />
          <p className="site-foot__brand">
            Craft
            <wbr />
            Attack Tracker
          </p>
          <p>
            Inoffizielles Fan-Projekt. Zahlen kommen von{" "}
            <a href="https://craftattack.one/api/stats" target="_blank" rel="noopener">
              craftattack.one
            </a>
            , der Rest wird hier daraus abgeleitet.
          </p>
        </div>
        <ul className="site-foot__nav">
          {/* Nur die Bereiche, nicht jeder Reiter – die stehen schon in der Kopfnavigation */}
          {HUBS.map((h) => (
            <li key={h.key}>
              <Link href={h.tabs[0].href}>{h.label}</Link>
            </li>
          ))}
          <li>
            <Link href="/so-funktionierts">So funktioniert’s</Link>
          </li>
          <li>
            <Link href="/impressum">Impressum</Link>
          </li>
          <li>
            <Link href="/datenschutz">Datenschutz</Link>
          </li>
          {/* Die Schätzung (/schaetzung) ist abgeschaltet; nur ihr eigener Build verlinkt zurück */}
          {ESTIMATE && (
            <li>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a href="/">Echte Daten</a>
            </li>
          )}
        </ul>
        <div className="site-foot__legal">
          {SOCIALS.some((s) => s.href) && (
            <ul className="site-foot__social" aria-label="Links">
              {SOCIALS.filter((s) => s.href).map((s) => {
                const I = Icon[s.key];
                return (
                  <li key={s.key}>
                    <a href={s.href} target="_blank" rel="noopener" aria-label={s.label} title={s.label}>
                      <I aria-hidden="true" />
                      <span>{s.label}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
          <p>
            Wie die Daten gesammelt werden: <Link href="/so-funktionierts">So funktioniert’s</Link>.
          </p>
          <p>
            Gebaut von{" "}
            <a href="https://hiorcraft.dev" target="_blank" rel="noopener">
              HiorCraft
            </a>{" "}
            und{" "}
            <a href="https://github.com/CommandD1" target="_blank" rel="noopener">
              CommandD1
            </a>{" "}
            mit <span className="heart">♥</span> und Unterstützung durch KI (Claude). Nicht mit
            CraftAttack oder den Creatorn verbunden.
          </p>
        </div>
      </div>
    </footer>
  );
}
