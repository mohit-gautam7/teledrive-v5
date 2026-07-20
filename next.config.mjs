/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    serverComponentsExternalPackages: ["node-telegram-bot-api", "telegram"],
    instrumentationHook: true,
  }
};

export default nextConfig;
