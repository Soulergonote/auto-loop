import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Velora and KyberSwap are called directly from the browser, so the built app is fully static.
export default defineConfig({
  // relative asset paths: the build works from any folder or sub-path (GitHub Pages, IPFS…)
  base: './',
  plugins: [react()],
})
