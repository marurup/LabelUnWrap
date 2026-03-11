import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { execSync } from 'child_process'

function getGitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
    __GIT_HASH__: JSON.stringify(getGitHash()),
  },
  base: '/LabelUnWrap/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'manifest.json'],
      manifest: {
        name: 'LabelUnWrap',
        short_name: 'LabelUnwrap',
        description: 'Capture and unwrap cylindrical object labels into flat images',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/LabelUnWrap/',
        start_url: '/LabelUnWrap/',
        icons: [
          {
            src: 'icon.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
          {
            src: 'icon.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: '/LabelUnWrap/index.html',
        navigateFallbackDenylist: [/\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/opencv\.js@1\.2\.1\/opencv\.js$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opencv-cdn',
              expiration: {
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
  ],
})
