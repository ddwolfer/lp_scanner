import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ root: __dirname, plugins: [react()], define: { __BUILD_TIME__: JSON.stringify(Date.now()) }, build: { outDir: 'dist', emptyOutDir: true }, server: { proxy: { '/api': 'http://localhost:3000' } } })
