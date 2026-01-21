import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In Docker, backend is at http://backend:8000
// Outside Docker (local dev), it's at http://localhost:8000
const apiTarget = process.env.DOCKER ? 'http://backend:8000' : 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        secure: false,
        ws: true
      },
      '/auth': {
        target: apiTarget,
        changeOrigin: true,
        secure: false
      }
    }
  }
})
