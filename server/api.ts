// server/api.ts — /api 路由。唯一寫入是頭寸登錄與關閉（SPEC §9.3）
import type { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { getDates, getOverview, getPool, listPositions, createPosition, closePosition, addJournal, exportPositions } from './queries.js'
import { loadScoring } from '../config/chain.js'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
const PositionSchema = z.object({ pool_id: z.string().min(3), label: z.string().min(1), range_lower: z.number().positive(), range_upper: z.number().positive(), deposit_usd: z.number().positive(), opened_at: z.string().min(10), notes: z.string().optional() })
const JournalSchema = z.object({ kind: z.enum(['open', 'note', 'adjust', 'collect', 'close', 'review']), text: z.string().default(''), data: z.unknown().optional(),
  images: z.array(z.object({ name: z.string().max(200), dataUrl: z.string().regex(/^data:image\/(png|jpeg|webp|gif);base64,/) })).max(10).optional() })
const IMG_DIR = 'data/positions'
const CloseSchema = z.object({ closed_at: z.string().min(10), fees_final_usd: z.number().min(0), value_final_usd: z.number().min(0) })
export function registerApi(app: FastifyInstance, db: Database.Database) {
  app.get('/api/dates', async () => getDates(db))
  app.get('/api/config', async () => loadScoring())
  app.get<{ Querystring: { date?: string } }>('/api/overview', async (req) => {
    const date = req.query.date ?? getDates(db)[0]
    return { date, rows: date ? getOverview(db, date) : [] }
  })
  app.get<{ Params: { id: string } }>('/api/pool/:id', async (req, reply) => {
    const r = getPool(db, req.params.id.toLowerCase()); if (!r) return reply.code(404).send({ error: 'pool not found' }); return r
  })
  app.get('/api/positions', async () => listPositions(db))
  app.post('/api/positions', async (req, reply) => {
    const p = PositionSchema.safeParse(req.body); if (!p.success) return reply.code(400).send({ error: p.error.flatten() })
    return { id: createPosition(db, p.data) }
  })
  app.patch<{ Params: { id: string } }>('/api/positions/:id/close', async (req, reply) => {
    const p = CloseSchema.safeParse(req.body); if (!p.success) return reply.code(400).send({ error: p.error.flatten() })
    closePosition(db, Number(req.params.id), p.data); return { ok: true }
  })
  app.post<{ Params: { id: string } }>('/api/positions/:id/journal', async (req, reply) => {
    const p = JournalSchema.safeParse(req.body); if (!p.success) return reply.code(400).send({ error: p.error.flatten() })
    const posId = Number(req.params.id)
    if (!p.data.text.trim() && !p.data.images?.length) return reply.code(400).send({ error: 'text or images required' })
    // 圖片存檔：data/positions/<tokenId|manual-id>/<timestamp>-<n>.<ext>，journal.data.images 記相對路徑（DECISIONS D33）
    const pos = db.prepare(`SELECT json_extract(notes, '$.tokenId') tokenId FROM positions WHERE id=?`).get(posId) as { tokenId: string | null } | undefined
    if (!pos) return reply.code(404).send({ error: 'position not found' })
    const key = pos.tokenId ?? `manual-${posId}`; const saved: string[] = []
    for (const [i, img] of (p.data.images ?? []).entries()) {
      const m = img.dataUrl.match(/^data:image\/(png|jpeg|webp|gif);base64,(.*)$/)!; const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
      const rel = `${key}/${Date.now()}-${i}.${ext}`; mkdirSync(path.join(IMG_DIR, key), { recursive: true })
      writeFileSync(path.join(IMG_DIR, rel), Buffer.from(m[2], 'base64')); saved.push(rel)
    }
    const data = { ...(typeof p.data.data === 'object' && p.data.data ? p.data.data as object : {}), ...(saved.length ? { images: saved } : {}) }
    const id = addJournal(db, posId, p.data.kind, p.data.text, Object.keys(data).length ? data : undefined); exportPositions(db, IMG_DIR); return { id, images: saved }
  })
  app.get<{ Params: { '*': string } }>('/api/journal-image/*', async (req, reply) => {
    const rel = req.params['*']; if (rel.includes('..')) return reply.code(400).send({ error: 'bad path' })
    const f = path.join(IMG_DIR, rel); if (!existsSync(f)) return reply.code(404).send({ error: 'not found' })
    const ext = path.extname(f).slice(1); reply.type(`image/${ext === 'jpg' ? 'jpeg' : ext}`); return readFileSync(f)
  })
  app.get('/api/scan-runs', async () => db.prepare('SELECT id, started_at, finished_at, ok, pools_scanned, api_calls, substr(error,1,200) error FROM scan_runs ORDER BY id DESC LIMIT 14').all())
}
