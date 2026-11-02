import Link from "next/link";
import { Suspense } from "react";
import { HubTabs, NavLinks } from "./NavLinks";

export function SiteHeader() {
  return (
    <header className="site-head" data-tone="ender">
      <div className="wrap site-head__in">
        <Link className="logo" href="/" aria-label="CraftAttack Tracker Startseite">
          <img className="logo__mark" src="/img/ca14-mark.webp" alt="" width={45} height={36} decoding="async" />
          <span>
            Craft<wbr />Attack
          </span>
          <span className="logo__sub">Tracker</span>
        </Link>
        <nav aria-label="Hauptnavigation">
          <Suspense fallback={<NavLinks static />}>
            <NavLinks />
          </Suspense>
        </nav>
      </div>
      <Suspense fallback={null}>
        <HubTabs />
      </Suspense>
    </header>
  );
}
