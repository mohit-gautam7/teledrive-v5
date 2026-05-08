/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["node-telegram-bot-api", "telegram"]
  }
};

export default nextConfig;
