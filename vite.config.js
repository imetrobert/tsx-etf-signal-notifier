import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Deployed to GitHub Pages at https://imetrobert.github.io/tsx-etf-signal-notifier/
export default defineConfig({
  plugins: [react()],
  base: '/tsx-etf-signal-notifier/',
})
