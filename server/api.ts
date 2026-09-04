// server/api.ts — /api 路由。唯一寫入是頭寸登錄與關閉（SPEC §9.3）
import type { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { getDates, getOverview, getPool, listPositions, createPosition, closePosition, addJournal, exportPositions } from './queries.js'
import { loadScoring } from '../config/chain.js'
const PositionSchema = z.object({ pool_id: z.string().min(3), label: z.string().min(1), range_lower: z.number().positive(), range_upper: z.number().positive(), deposit_usd: z.number().positive(), opened_at: z.string().min(10), notes: z.string().optional() })
const JournalSchema = z.object({ kind: z.enum(['open', 'note', 'adjust', 'collect', 'close', 'review']), text: z.string().min(1), data: z.unknown().optional() })
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
    const id = addJournal(db, Number(req.params.id), p.data.kind, p.data.text, p.data.data); exportPositions(db, 'data/positions'); return { id }
  })
  app.get('/api/scan-runs', async () => db.prepare('SELECT id, started_at, finished_at, ok, pools_scanned, api_calls, substr(error,1,200) error FROM scan_runs ORDER BY id DESC LIMIT 14').all())
}
