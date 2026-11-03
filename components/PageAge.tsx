import { connection } from "next/server";
import { DataAge } from "./DataAge";

/** Renderzeit dieser Anfrage (außerhalb der Komponente gelesen, damit sie als Wert hereinkommt) */
async function renderedAt() {
  await connection();
  return Date.now();
}

/** Zeitpunkt, zu dem diese Seite gerendert wurde (der Zwischenspeicher liefert sie bis zu einigen Minuten aus) */
export async function PageAge() {
  const at = await renderedAt();
  return <DataAge at={at} hint="Seiten werden kurz zwischengespeichert und im Hintergrund erneuert" />;
}
