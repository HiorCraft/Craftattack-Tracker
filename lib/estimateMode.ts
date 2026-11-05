/**
 * Schätzungs-Ausgabe: eigener Build mit `CA_ESTIMATE=1` (next.config.ts setzt basePath `/schaetzung` und eigenes
 * Build-Verzeichnis). Sie liest die Sichten im Schema `approx` (scripts/estimate.mjs), in denen Datenlücken gefüllt
 * sind. Beide Werte werden beim Build eingesetzt und gelten in Server- und Browser-Code.
 */
export const ESTIMATE = process.env.NEXT_PUBLIC_CA_ESTIMATE === "1";
/** URL-Präfix dieses Builds ("" in der normalen Website) */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
/** Wo die Schätzung liegt (für Links aus der normalen Website) */
export const ESTIMATE_PATH = "/schaetzung";
