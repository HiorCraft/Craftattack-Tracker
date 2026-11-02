import type { NextConfig } from "next";

/** Schätzungs-Ausgabe (siehe lib/estimateMode.ts): gleiche App unter /schaetzung, eigenes Build-Verzeichnis */
const estimate = process.env.CA_ESTIMATE === "1";

const nextConfig: NextConfig = {
  cacheComponents: true,
  cacheMaxMemorySize: 16 * 1024 * 1024,
  serverExternalPackages: ["pg"],
  partialPrefetching: true,
  experimental: {
    cpus: 1,
  },
  // Frühere interne Seiten und die alte Netz-Adresse leben jetzt unter „Community“
  async redirects() {
    return [
      { source: "/intern/netz", destination: "/naehe", permanent: false },
      { source: "/intern/gruppen", destination: "/gruppen", permanent: false },
      { source: "/intern/gruppen/:id", destination: "/gruppen/:id", permanent: false },
      { source: "/intern/zuschauerwanderung", destination: "/zuschauer", permanent: false },
      { source: "/netz", destination: "/verbindungen", permanent: false },
    ];
  },
  ...(estimate ? { basePath: "/schaetzung", distDir: ".next-schaetzung" } : {}),
  env: {
    NEXT_PUBLIC_CA_ESTIMATE: estimate ? "1" : "",
    NEXT_PUBLIC_BASE_PATH: estimate ? "/schaetzung" : "",
  },
};

export default nextConfig;
