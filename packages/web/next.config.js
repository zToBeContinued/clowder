const withPWA = require('@ducanh2912/next-pwa').default;

const enablePwaInDev = process.env.ENABLE_PWA_IN_DEV === '1';

function resolveApiBaseUrl() {
  // Prefer explicit local port over NEXT_PUBLIC_API_URL: SSR rewrites should
  // hit localhost directly even when the env URL is a public domain (e.g. a
  // cloud tunnel kept around for webhooks / Host allowlist). Otherwise local
  // /uploads/* and same-origin fetches would round-trip through the tunnel.
  const apiPort = Number(process.env.API_SERVER_PORT);
  if (Number.isInteger(apiPort) && apiPort > 0) {
    return `http://127.0.0.1:${apiPort}`;
  }

  const frontendPort = Number(process.env.FRONTEND_PORT);
  if (Number.isInteger(frontendPort) && frontendPort > 0) {
    return `http://127.0.0.1:${frontendPort + 1}`;
  }

  const explicit = process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, '');
  if (explicit) return explicit;

  return 'http://127.0.0.1:3004';
}

const apiBaseUrl = resolveApiBaseUrl();
const distDir = process.env.NEXT_DIST_DIR ?? (process.env.NODE_ENV === 'development' ? '.next-dev' : '.next');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Only expose whether the server-side proxy is active. The bearer itself
  // must never enter a NEXT_PUBLIC_* variable or a browser bundle.
  env: {
    NEXT_PUBLIC_API_AUTH_PROXY_ENABLED: process.env.CLOWDER_API_BEARER_TOKEN?.trim() ? '1' : '0',
  },
  // Keep dev-server artifacts separate from `next build` output. Running build
  // while 3003 is open previously overwrote `.next/static`, leaving dev HTML
  // pointing at missing CSS/JS files and rendering the app as raw HTML.
  distDir,
  experimental: {
    proxyTimeout: 120_000,
    serverComponentsExternalPackages: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-attach'],
  },
  // 允许 Tailscale 网段设备访问 dev server 的 /_next/* 资源
  allowedDevOrigins: ['100.0.0.0/8'],
  async headers() {
    // F156 D-3: Strict CSP baseline.
    // Next.js hydration requires 'unsafe-inline' for scripts — nonce-based CSP
    // needs middleware (future work). Blocking 'unsafe-eval' prevents eval() injection.
    const isDev = process.env.NODE_ENV === 'development';
    const csp = [
      "frame-ancestors 'none'",
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
      "object-src 'none'",
    ].join('; ');
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: csp },
        ],
      },
    ];
  },
  webpack: (config, { dev }) => {
    if (dev) {
      // Next dev vendor chunks have repeatedly gone stale during HMR.
      // Keep production splitting intact; disable only local dev splitting.
      config.optimization.splitChunks = false;
    }
    // Suppress onnxruntime-web "Critical dependency" warnings — dynamic require() in
    // minified bundle is expected and cannot be statically analyzed by webpack.
    config.ignoreWarnings = [{ module: /onnxruntime-web/ }];
    return config;
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${apiBaseUrl}/api/:path*`,
      },
      {
        source: '/socket.io/:path*',
        destination: `${apiBaseUrl}/socket.io/:path*`,
      },
      {
        source: '/uploads/:path*',
        destination: `${apiBaseUrl}/uploads/:path*`,
      },
    ];
  },
};

const pwaOptions = {
  dest: 'public',
  disable: process.env.NODE_ENV === 'development' && !enablePwaInDev,
  reloadOnOnline: true,
  // Start URL is a static shell; precache it so PWA cold-open does not block on network.
  dynamicStartUrl: false,
  // Keep default page/document runtime caching and only override what we need.
  extendDefaultRuntimeCaching: true,
  workboxOptions: {
    disableDevLogs: true,
    runtimeCaching: [
      {
        // API calls: never cache — always fresh chat data
        urlPattern: /^https?:\/\/.*\/api\//,
        handler: 'NetworkOnly',
      },
      {
        // WebSocket upgrade requests: skip caching
        urlPattern: /^https?:\/\/.*\/socket\.io/,
        handler: 'NetworkOnly',
      },
      {
        // Static assets: cache for performance
        urlPattern: /\.(png|jpg|jpeg|svg|gif|ico|woff2?)$/,
        handler: 'CacheFirst',
        options: {
          cacheName: 'static-assets',
          expiration: { maxEntries: 60, maxAgeSeconds: 30 * 24 * 60 * 60 },
        },
      },
    ],
  },
};

module.exports =
  process.env.NODE_ENV === 'development' && !enablePwaInDev ? nextConfig : withPWA(pwaOptions)(nextConfig);
