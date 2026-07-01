/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep these server-only packages external to the Next bundle.
  serverExternalPackages: ["@prisma/client", "mysql2", "bullmq", "ioredis", "playwright", "pino"],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
