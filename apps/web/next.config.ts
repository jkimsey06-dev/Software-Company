import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@sc/shared", "@sc/ai"],
  poweredByHeader: false,
};

export default nextConfig;
