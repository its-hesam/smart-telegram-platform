/** @type {import('next').NextConfig} */
const config = { poweredByHeader: false, distDir: process.env.DEMO_PREVIEW === 'true' ? '.next-demo' : '.next' };
export default config;
