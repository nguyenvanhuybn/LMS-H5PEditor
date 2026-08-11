import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const h5pEngineInternalUrl = (process.env.H5P_ENGINE_INTERNAL_URL || "http://localhost:3001").replace(/\/$/, "");
const isVercel = process.env.VERCEL === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Vercel packages Next.js with its own deployment adapter. Standalone output
  // is retained for the Docker image, where the minimal server is required.
  ...(isVercel ? {} : { output: "standalone" }),
  reactStrictMode: true,
  turbopack: {
    root: projectRoot,
  },
  experimental: {
    // Cài content type từ H5P Hub là một request im lặng rất lâu: engine tải
    // gói .h5p kèm toàn bộ dependency rồi mới trả JSON. Mặc định proxy của
    // Next huỷ upstream sau 30s, khiến editor nhận 500 "Unable to interpret
    // response". Nới lên 10 phút cho các content type lớn.
    proxyTimeout: 600_000,
    // Next buffer body của request được proxy, mặc định cắt ở 10MB và request
    // sẽ treo vô hạn. Khớp với H5P_MAX_UPLOAD_MB của engine để upload file .h5p
    // và video/audio trong editor không bị treo.
    proxyClientMaxBodySize: "100mb",
  },
  async rewrites() {
    return [
      {
        source: "/h5p-engine/:path*",
        destination: `${h5pEngineInternalUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
