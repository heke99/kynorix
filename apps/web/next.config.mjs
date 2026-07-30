/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@zoryqon/contracts'],
  poweredByHeader: false,
  experimental: {
    optimizePackageImports: ['@zoryqon/contracts'],
  },
};

export default nextConfig;
