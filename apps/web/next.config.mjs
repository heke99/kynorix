/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@kynorix/contracts'],
  poweredByHeader: false,
  experimental: {
    optimizePackageImports: ['@kynorix/contracts'],
  },
};

export default nextConfig;
