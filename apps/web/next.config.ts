import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@sc/shared", "@sc/ai"],
  poweredByHeader: false,
  async headers() {
    // Signed-in pages hold customer data: never cached, never framed.
    const private_ = [
      { key: "Cache-Control", value: "no-store" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Content-Type-Options", value: "nosniff" },
    ];
    return ["/dashboard/:path*", "/login", "/auth/:path*"].map((source) => ({ source, headers: private_ }));
  },
};

export default nextConfig;
