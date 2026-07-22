import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Deployed to GitHub Pages at https://invest.imetrobert.com (custom domain → base '/')
export default defineConfig({
  plugins: [react()],
  base: '/',
})
