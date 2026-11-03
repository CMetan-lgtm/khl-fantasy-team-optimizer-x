import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets `npm run dev` serve the UI tests at http://127.0.0.1:3000 (their default base URL).
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
