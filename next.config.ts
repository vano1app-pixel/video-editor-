import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ffmpeg-static / ffprobe-static resolve real binaries on disk; never bundle them.
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],
  // No body-size config here: uploads stream through the /api/upload route handler (not a server action) and are bounded by MAX_UPLOAD_MB.
};

export default nextConfig;
