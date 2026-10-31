import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'

// Velora is called directly from the browser, so the built app is fully static. 0x and 1inch (disabled for
// now) need API keys: they go through this dev-server proxy so the keys (not VITE_-prefixed) never reach the bundle.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')

  const proxy: Record<string, ProxyOptions> = {
    '/api/0x': {
      target: 'https://api.0x.org',
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/api\/0x/, ''),
      headers: { '0x-api-key': env.ZEROX_API_KEY ?? '', '0x-version': 'v2' },
    },
    '/api/1inch': {
      target: 'https://api.1inch.dev',
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/api\/1inch/, ''),
      headers: { Authorization: `Bearer ${env.ONEINCH_API_KEY ?? ''}` },
    },
  }

  return {
    // relative asset paths: the build works from any folder or sub-path (GitHub Pages, IPFS…)
    base: './',
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
  }
})
