import type { Metadata, Viewport } from 'next';
import { Space_Grotesk } from 'next/font/google';
import { AppShell } from '@/components/AppShell';

import { ChunkLoadRefreshGuard } from '@/components/ChunkLoadRefreshGuard';
import { GuideOverlay } from '@/components/GuideOverlay';
import { SessionBootstrap } from '@/components/SessionBootstrap';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ToastContainer } from '@/components/ToastContainer';
import { ConfirmProvider } from '@/components/useConfirm';
import '@xterm/xterm/css/xterm.css';
import './theme-tokens.css';
import './globals.css';
import './console-shell.css';
import './console-controls.css';

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-raft-ui',
});

const visualThemeBootstrapScript = `
(() => {
  const storageKey = 'clowder:visual-theme';
  const migrationKey = 'clowder:visual-theme-default:v4';
  const validThemes = new Set(['claude', 'slockv1', 'slock', 'kami']);
  const defaultTheme = 'slock';
  try {
    // Honor any stored valid theme; default-version bumps must never reset a user's explicit choice.
    // The migration key is still written for backward compatibility with older builds.
    const stored = window.localStorage.getItem(storageKey);
    const normalizedStored = stored === 'tesla' ? 'slockv1' : stored;
    const nextTheme = validThemes.has(normalizedStored) ? normalizedStored : defaultTheme;
    document.documentElement.dataset.visualTheme = nextTheme;
    window.localStorage.setItem(storageKey, nextTheme);
    window.localStorage.setItem(migrationKey, '1');
  } catch {
    document.documentElement.dataset.visualTheme = defaultTheme;
  }
})();
`;

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Matches the default slock/slockv1 cream surface so the PWA chrome blends with the UI
  themeColor: '#fff9ec',
};

export const metadata: Metadata = {
  title: 'Clowder AI',
  description: 'Your AI team collaboration space',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/icons/favicon.svg', type: 'image/svg+xml' },
      { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/icons/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Clowder AI',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-visual-theme="slock" suppressHydrationWarning>
      <body className={`${spaceGrotesk.variable} min-h-screen`}>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: 主题引导脚本是本地常量(非用户输入),必须内联同步执行以防明暗主题闪烁(FOUC),Next.js 标准手法 */}
        <script dangerouslySetInnerHTML={{ __html: visualThemeBootstrapScript }} />
        <ChunkLoadRefreshGuard />
        <SessionBootstrap />
        <ThemeProvider>
          <ConfirmProvider>
            <AppShell>{children}</AppShell>
          </ConfirmProvider>
          <GuideOverlay />
          <ToastContainer />
        </ThemeProvider>
      </body>
    </html>
  );
}
