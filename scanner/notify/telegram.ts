// scanner/notify/telegram.ts — 只推送 sendMessage，不設 webhook、不 getUpdates（SPEC §10.5）
export async function sendTelegram(text: string, env: { token?: string; chatId?: string; topicId?: string }, fetchImpl: typeof fetch = fetch): Promise<'sent' | 'not_configured'> {
  if (!env.token || !env.chatId) return 'not_configured'
  const r = await fetchImpl(`https://api.telegram.org/bot${env.token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.chatId, text, disable_web_page_preview: true, ...(env.topicId ? { message_thread_id: Number(env.topicId) } : {}) }) })
  if (!r.ok) throw new Error(`telegram HTTP ${r.status}`)
  return 'sent'
}
