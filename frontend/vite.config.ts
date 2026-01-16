import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Docker sets VITE_API_URL=http://backend:8000, otherwise use localhost
const apiTarget = process.env.VITE_API_URL || 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': apiTarget,
      '/auth': apiTarget
    }
  }
})
