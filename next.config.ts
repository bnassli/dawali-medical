import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Scanned purchase invoices are uploaded through a server action (I1, ADR-035; max 10 MB).
    serverActions: { bodySizeLimit: "11mb" },
  },
};

export default nextConfig;
