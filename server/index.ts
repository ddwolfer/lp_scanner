// server/index.ts — Fastify 唯讀 JSON API + 靜態檔。只綁區網（SPEC §10.4），無登入，無 tunnel
import 'dotenv/config'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { openDb } from '../db/index.js'
import { registerApi } from './api.js'
const root = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(root, '..', 'web', 'dist')
const db = openDb(path.join(root, '..', 'db', 'lp.sqlite'))
const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 30 * 1024 * 1024 })   // 日誌截圖 base64
registerApi(app, db)
if (existsSync(dist)) {
  // index.html 一律不快取（每次部署後使用者重新整理就拿到新版）；/assets/* 檔名帶 hash，可長期快取
  await app.register(fastifyStatic, { root: dist, prefix: '/', setHeaders: (res, filePath) => { res.setHeader('Cache-Control', filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable') } })
  const index = () => readFileSync(path.join(dist, 'index.html'), 'utf8')
  app.get('/', async (_req, reply) => reply.header('Cache-Control', 'no-cache').type('text/html').send(index()))
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' })
    reply.header('Cache-Control', 'no-cache').type('text/html').send(index())
  })
} else console.log('web/dist 不存在，先跑 pnpm web:build（開發時用 pnpm web:dev 走 proxy）')
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })
console.log(`lp-scanner dashboard: http://0.0.0.0:${port}`)
