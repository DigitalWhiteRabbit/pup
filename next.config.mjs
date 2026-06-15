/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  experimental: {
    instrumentationHook: true,
    optimizePackageImports: ["lucide-react", "date-fns"],
    // KB-vector: the local embedder (@xenova/transformers) loads the native
    // onnxruntime-node backend (ships prebuilt *.node binaries) and sharp.
    // Keep them external so webpack doesn't try to bundle the native binaries
    // into server route bundles — they're require()'d at runtime instead.
    serverComponentsExternalPackages: [
      "@xenova/transformers",
      "onnxruntime-node",
      "sharp",
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=()",
          },
          { key: "X-DNS-Prefetch-Control", value: "on" },
        ],
      },
    ];
  },
};

export default nextConfig;
