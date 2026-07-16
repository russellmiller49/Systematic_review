import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
  // NOTE: pdfjs-dist is deliberately NOT in serverExternalPackages — externalizing the
  // whole package breaks the client viewer's `new URL("pdfjs-dist/build/pdf.worker...")`
  // asset reference in the SSR compilation. The one server-side consumer
  // (src/server/services/fulltext-pages) escapes bundling with a webpackIgnore'd
  // dynamic import instead, which Node resolves from node_modules at runtime.
};

export default nextConfig;
