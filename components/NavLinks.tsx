"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";
import { HUBS, hubOf } from "@/lib/hubs";

function List({ path }: { path: string | null }) {
  const current = hubOf(path);
  return (
    <ul className="nav">
      {HUBS.map((h) => (
        <li key={h.key}>
          <Link href={h.tabs[0].href} aria-current={current?.hub.key === h.key ? "page" : undefined}>
            {h.label}
          </Link>
        </li>
      ))}
      <li>
        <a className="nav__ext" href="https://craftattack.one/stats/" target="_blank" rel="noopener">
          Original
        </a>
      </li>
      <li className="nav__theme">
        <ThemeToggle />
      </li>
    </ul>
  );
}

/** `static` rendert die Liste ohne aktiven Zustand (Suspense-Fallback fürs Prerendering). */
export function NavLinks({ static: isStatic = false }: { static?: boolean }) {
  if (isStatic) return <List path={null} />;
  return <ActiveList />;
}

function ActiveList() {
  const path = usePathname();
  return <List path={path} />;
}

/** Reiter des aktuellen Bereichs (nur, wenn er mehr als einen hat) */
export function HubTabs() {
  const path = usePathname();
  const current = hubOf(path);
  if (!current || current.hub.tabs.length < 2) return null;
  return (
    <nav className="subnav" aria-label={current.hub.label}>
      <ul className="wrap subnav__in">
        {current.hub.tabs.map((t) => (
          <li key={t.href}>
            <Link href={t.href} aria-current={t.href === current.tab.href ? "page" : undefined}>
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
