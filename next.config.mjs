/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    serverComponentsExternalPackages: ["node-telegram-bot-api", "telegram"]
  }
};

export default nextConfig;
