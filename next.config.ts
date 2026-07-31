import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ffmpeg-static / ffprobe-static resolve real binaries on disk; never bundle them.
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],
  experimental: {
    serverActions: {
      // Uploads go through a route handler, not server actions, but keep headroom.
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
