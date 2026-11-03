/**
 * Discussions WhatsApp du dashboard — AUCUN vrai WhatsApp : un faux service (port 4261) joue le rôle du service Baileys,
 * vérifie la signature HMAC et fournit /v1/events et /v1/send. Aucune base réelle : base du `.env` = base de TEST.
 * `node tests/whatsapp-chat.test.js` démarre sa propre API (port 4262).
 */
import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'

import { config } from '../src/config/env.js'
import { closePool, execute, query } from '../src/config/database.js'
import { JEKO_OFF, startApi } from './lib/start-api.js'

if (config.isProduction) {
  console.error('Refus : ces tests écrivent en base, jamais avec NODE_ENV=production.')
  process.exit(1)
}

const SECRET = 'c'.repeat(48)
let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (s) => createHash('sha256').update(s).digest('hex')

/* ─────────────── Faux service ─────────────── */
const svc = { events: [], seq: 0, sent: [], calls: [], nonces: new Set(), mode: 'ok', sendMode: 'ok', lastSeqOverride: null, pending: 0 }
const pousser = (e) => { svc.seq += 1; svc.events.push({ ...e, seq: svc.seq, at: Date.now() }); return svc.seq }
const service = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString()
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (svc.mode === 'down') return req.socket.destroy()
    const h = req.headers
    const path = req.url.split('?')[0]
    const base = [h['x-bh-timestamp'], h['x-bh-nonce'], req.method, path, sha(raw), h['x-bh-actor'] ?? ''].join('\n')
    const ok = createHmac('sha256', SECRET).update(base).digest('hex') === h['x-bh-signature'] && !svc.nonces.has(h['x-bh-nonce'])
    svc.calls.push({ method: req.method, path, ok })
    if (!ok) return json(401, { error: { code: 'UNAUTHORIZED' } })
    svc.nonces.add(h['x-bh-nonce'])
    if (req.method === 'GET' && path === '/v1/events') {
      const u = new URL(req.url, 'http://x')
      const after = Number(u.searchParams.get('after')) || 0
      const limit = Number(u.searchParams.get('limit')) || 100
      return json(200, { events: svc.events.filter((e) => e.seq > after).slice(0, limit), lastSeq: svc.lastSeqOverride ?? svc.seq, firstSeq: 1, gap: false })
    }
    if (req.method === 'POST' && path === '/v1/send') {
      const body = JSON.parse(raw)
      if (svc.sendMode === 'notconnected') return json(409, { error: { code: 'NOT_CONNECTED' } })
      if (svc.sendMode === 'ratelimit') return json(429, { error: { code: 'RATE_LIMITED' } })
      if (svc.sendMode === 'slow') await wait(300)
      svc.sent.push({ to: body.to, text: body.text, kind: body.kind, reference: body.reference })
      return json(202, { messageId: `CHATMSG${svc.sent.length}`, status: 'sent_to_whatsapp', delivered: null })
    }
    return json(404, { error: { code: 'NOT_FOUND' } })
  })
})
await new Promise((r) => service.listen(4261, '127.0.0.1', r))

const ENV = {
  ...JEKO_OFF,
  WHATSAPP_ENABLED: 'true',
  WHATSAPP_PROVIDER: 'qr',
  WHATSAPP_QR_SERVICE_URL: 'http://127.0.0.1:4261',
  WHATSAPP_QR_SERVICE_SECRET: SECRET,
  WHATSAPP_QR_TIMEOUT_MS: '1500',
  WHATSAPP_CHAT_SYNC_SECONDS: '60', // pas de relecture automatique pendant le test : on pilote à la main
}
let apiTest = await startApi(4262, ENV, { capture: true })
const BASE = apiTest.base
const api = async (method, path, { body, token } = {}) => {
  const r = await fetch(`${BASE}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const texte = await r.text()
  let j = null
  try { j = JSON.parse(texte) } catch { /* vide */ }
  return { status: r.status, body: j, texte }
}

const stamp = String(Date.now()).slice(-7)
const num = (suffixe) => `22507${stamp}${suffixe}` // 13 chiffres : 225 + 07 + 7 + 1
const A = num(1), B = num(2), C = num(3), D = num(4), E = num(5), F = num(6)
const local = (n) => n.slice(3)
const mdp = 'MotDePasseTest-2026'
const mailAgent = `wa.chat.agent.${stamp}@example.com`
const T0 = Date.now() - 600000
let tick = 0
const ts = () => T0 + (tick += 1000)
const evt = (over) => ({ type: 'message', id: `WAID${Math.random().toString(36).slice(2, 10).toUpperCase()}`, direction: 'in', jid: `${A}@s.whatsapp.net`, phone: A, pushName: null, text: 'Bonjour', mediaType: null, ts: ts(), origin: 'client', ...over })
const sync = () => api('POST', '/admin/whatsapp/chat/sync', { token: admin })
let admin = null
const nettoyer = async () => {
  await execute('DELETE FROM whatsapp_conversations WHERE phone IN (?, ?, ?, ?, ?, ?)', [A, B, C, D, E, F]).catch(() => {})
  await execute('DELETE FROM whatsapp_conversations WHERE jid LIKE ?', ['9988%@lid']).catch(() => {})
  await execute('DELETE FROM customers WHERE phone_key IN (?, ?, ?)', [local(B), local(D), local(E)]).catch(() => {})
  await execute('DELETE FROM users WHERE email = ?', [mailAgent]).catch(() => {})
}
const etatSync = async () => Number((await query('SELECT last_seq FROM whatsapp_sync_state WHERE id = 1'))[0]?.last_seq)
const avantSeq = await etatSync()

try {
  await nettoyer()
  admin = (await api('POST', '/admin/auth/login', { body: { email: config.admin.email, password: config.admin.password } })).body?.data?.token
  check('connexion administratrice', Boolean(admin))
  // Le journal du faux service repart de zéro : on aligne le curseur du backend pour ne rien dépendre d'un test précédent.
  await execute('UPDATE whatsapp_sync_state SET last_seq = 0 WHERE id = 1')

  section('Droits')
  const cree = await api('POST', '/admin/auth/users', { token: admin, body: { name: 'Agent Chat Test', email: mailAgent, password: mdp, role: 'staff', permissions: ['messaging', 'customers', 'appointments'] } })
  const tAgent = (await api('POST', '/admin/auth/login', { body: { email: mailAgent, password: mdp } })).body?.data?.token
  check('agent de test créé', cree.status === 201 && Boolean(tAgent))
  const appelsAvant = svc.calls.length
  for (const [m, p, b] of [['GET', '/admin/whatsapp/chat/conversations'], ['GET', '/admin/whatsapp/chat/updates'], ['GET', '/admin/whatsapp/chat/summary'], ['POST', '/admin/whatsapp/chat/sync', {}], ['POST', '/admin/whatsapp/chat/conversations', { phone: A, text: 'x' }], ['POST', '/admin/whatsapp/chat/conversations/1/messages', { text: 'x' }], ['POST', '/admin/whatsapp/chat/messages/1/retry', {}], ['POST', '/admin/whatsapp/chat/conversations/1/read', {}]]) {
    const r = await api(m, p, { token: tAgent, body: b })
    check(`agent : ${m} ${p.replace('/admin/whatsapp/chat', '')} refusé (403)`, r.status === 403, String(r.status))
  }
  check('sans jeton : 401', (await api('GET', '/admin/whatsapp/chat/conversations')).status === 401)
  check('aucun appel n’a atteint le service pour un agent', svc.calls.length === appelsAvant)

  section('Réception de messages')
  // B et D sont des clientes enregistrées (D a refusé WhatsApp) ; A et C sont inconnues.
  await execute("INSERT INTO customers (phone, phone_key, first_name, last_name, whatsapp_opt_in) VALUES (?, ?, 'Awa', 'Koné', 1), (?, ?, 'Dina', 'Diallo', 0), (?, ?, 'Eve', 'Traoré', 1)", [`0${local(B)}`.slice(-10), local(B), local(D), local(D), local(E), local(E)])
  const [clienteB] = await query('SELECT id FROM customers WHERE phone_key = ?', [local(B)])
  const e1 = evt({ id: 'IN-A-1', text: 'Bonjour, vous avez de la place samedi ?', pushName: 'Madame A' })
  pousser(e1)
  pousser(evt({ id: 'IN-B-1', jid: `${B}@s.whatsapp.net`, phone: B, pushName: 'Awa WhatsApp', text: 'Merci pour hier !' }))
  pousser(evt({ id: 'IN-D-1', jid: `${D}@s.whatsapp.net`, phone: D, text: 'STOP' }))
  const s1 = await sync()
  check('relecture des événements → 3 messages enregistrés', s1.status === 200 && s1.body?.data?.traites === 3, s1.texte.slice(0, 200))
  const lst = await api('GET', '/admin/whatsapp/chat/conversations', { token: admin })
  const parNum = (n) => lst.body?.data?.find((c) => c.phone === n)
  check('liste : conversations créées, non lues = 1', lst.status === 200 && parNum(A)?.unread === 1 && parNum(B)?.unread === 1)
  check('inconnue : nom = nom WhatsApp, pas de fiche cliente créée', parNum(A)?.name === 'Madame A' && parNum(A)?.isCustomer === false && (await query('SELECT id FROM customers WHERE phone_key = ?', [local(A)])).length === 0)
  check('cliente enregistrée : nom de la fiche + lien vers la fiche', parNum(B)?.name === 'Awa Koné' && parNum(B)?.customerId === clienteB.id)
  check('aperçu du dernier message', parNum(A)?.lastMessage.startsWith('Bonjour, vous avez') && parNum(A)?.lastDirection === 'in')
  check('numéro lisible', parNum(A)?.phoneDisplay === `+225 07 ${stamp.slice(0, 2)} ${stamp.slice(2, 4)} ${stamp.slice(4, 6)} ${stamp.slice(6)}1`.replace(/\s+/g, ' '), parNum(A)?.phoneDisplay)
  check('total non lus renvoyé', lst.body?.unread?.messages >= 3)
  check('curseur de départ renvoyé avec la liste', lst.body?.cursor > 0 && typeof lst.body?.sync?.perte === 'boolean')

  section('Doublons et reprise')
  pousser({ ...e1 }) // même message (même identifiant WhatsApp), nouveau numéro de séquence
  pousser({ ...e1 })
  const s2 = await sync()
  check('même message rejoué → aucun doublon, aucun compteur', s2.body?.data?.traites === 0 && (await query('SELECT id FROM whatsapp_messages WHERE wa_message_id = ?', ['IN-A-1'])).length === 1)
  const apres = await api('GET', '/admin/whatsapp/chat/conversations', { token: admin })
  check('non lus inchangés après le rejeu', apres.body.data.find((c) => c.phone === A)?.unread === 1)
  const cur = await etatSync()
  await sync()
  check('le curseur ne recule pas et ne retraite rien', (await etatSync()) === cur && cur === svc.seq)
  pousser({ type: 'message', seq: 999, id: 'bad id', jid: 'pas-un-jid', direction: 'in' })
  pousser(evt({ id: 'IN-A-2', text: 'Deuxième message', ts: ts()}))
  const s3 = await sync()
  check('événement mal formé ignoré, le suivant est bien traité', s3.body?.data?.traites === 1 && (await query('SELECT id FROM whatsapp_messages WHERE wa_message_id = ?', ['IN-A-2'])).length === 1)

  section('Recherche, non lus, tri')
  const q1 = await api('GET', '/admin/whatsapp/chat/conversations?q=Awa', { token: admin })
  check('recherche par nom (fiche ou nom WhatsApp)', q1.body.data.length === 1 && q1.body.data[0].phone === B)
  const q2 = await api('GET', `/admin/whatsapp/chat/conversations?q=${local(A).slice(-6)}`, { token: admin })
  check('recherche par numéro (fragment)', q2.body.data.some((c) => c.phone === A) && !q2.body.data.some((c) => c.phone === B))
  const q3 = await api('GET', '/admin/whatsapp/chat/conversations?q=%25&limit=5', { token: admin })
  check('recherche sans résultat sûre (caractère spécial)', q3.status === 200)
  const nl = await api('GET', '/admin/whatsapp/chat/conversations?unread=1', { token: admin })
  check('filtre « non lues » : uniquement des conversations non lues', nl.body.data.length >= 3 && nl.body.data.every((c) => c.unread > 0))
  const listeOrdre = await api('GET', '/admin/whatsapp/chat/conversations', { token: admin })
  const ordre = listeOrdre.body.data.filter((c) => [A, B, D].includes(c.phone)).map((c) => c.phone)
  check('conversations les plus récentes d’abord (A a le message le plus récent)', ordre[0] === A, ordre.join(','))

  section('Historique et pagination')
  const convA = parNum(A)
  for (let i = 1; i <= 5; i += 1) pousser(evt({ id: `HIST-${i}`, text: `Historique ${i}`, ts: ts()}))
  await sync()
  const p1 = await api('GET', `/admin/whatsapp/chat/conversations/${convA.id}/messages?limit=3`, { token: admin })
  check('page 1 : 3 derniers messages, chronologique, hasMore', p1.body.data.messages.length === 3 && p1.body.data.hasMore === true && p1.body.data.messages.at(-1).text === 'Historique 5' && p1.body.data.messages[0].text === 'Historique 3')
  const p2 = await api('GET', `/admin/whatsapp/chat/conversations/${convA.id}/messages?limit=3&before=${p1.body.data.messages[0].id}`, { token: admin })
  check('page 2 (avant le plus ancien affiché) : messages précédents, sans recouvrement', p2.body.data.messages.length === 3 && !p2.body.data.messages.some((m) => p1.body.data.messages.some((x) => x.id === m.id)))
  check('messages reçus : direction « in », origine « client »', p2.body.data.messages.every((m) => m.direction === 'in' && m.origin === 'client'))
  check('conversation inconnue → 404', (await api('GET', '/admin/whatsapp/chat/conversations/99999999/messages', { token: admin })).status === 404)

  section('Marquer comme lu')
  const rd = await api('POST', `/admin/whatsapp/chat/conversations/${convA.id}/read`, { token: admin, body: {} })
  check('ouverture → non lus remis à 0', rd.status === 200 && rd.body.data.unread === 0)
  check('les autres conversations gardent leurs non lus', (await api('GET', '/admin/whatsapp/chat/conversations', { token: admin })).body.data.find((c) => c.phone === B).unread === 1)

  section('Temps réel : curseur de changements')
  const u0 = await api('GET', '/admin/whatsapp/chat/updates?since=0', { token: admin })
  check('updates depuis 0 : conversations et messages, curseur', u0.status === 200 && u0.body.data.conversations.length >= 3 && u0.body.data.messages.length >= 8 && u0.body.data.cursor > 0)
  const curseur = u0.body.data.cursor
  await wait(1100)
  pousser(evt({ id: 'LIVE-1', text: 'Nouveau message en direct', ts: ts()}))
  await sync()
  const u1 = await api('GET', `/admin/whatsapp/chat/updates?since=${curseur}`, { token: admin })
  check('updates depuis le curseur : le nouveau message est là', u1.body.data.messages.some((m) => m.text === 'Nouveau message en direct') && u1.body.data.conversations.some((c) => c.phone === A))
  check('updates : ne renvoie pas tout l’historique', u1.body.data.messages.length < u0.body.data.messages.length)
  check('updates : non lus renvoyés pour la pastille', u1.body.data.unread.messages >= 2)

  section('Envoi d’une réponse')
  const ref1 = `ref-${stamp}-0001`
  const envoi = await api('POST', `/admin/whatsapp/chat/conversations/${convA.id}/messages`, { token: admin, body: { text: 'Oui, samedi 10h est possible.', clientRef: ref1 } })
  check('réponse envoyée (201), état « sent », identifiant WhatsApp mémorisé', envoi.status === 201 && envoi.body.data.status === 'sent' && envoi.body.data.origin === 'dashboard' && envoi.body.data.direction === 'out', envoi.texte.slice(0, 200))
  check('le service a reçu un envoi « chat » vers le bon numéro avec le bon texte', svc.sent.at(-1)?.kind === 'chat' && svc.sent.at(-1)?.to === `+${A}` && svc.sent.at(-1)?.text === 'Oui, samedi 10h est possible.')
  const nbEnvois = svc.sent.length
  const rejeu = await api('POST', `/admin/whatsapp/chat/conversations/${convA.id}/messages`, { token: admin, body: { text: 'Oui, samedi 10h est possible.', clientRef: ref1 } })
  check('même clientRef rejoué → 200, aucun nouvel envoi, même message', rejeu.status === 200 && rejeu.body.replayed === true && rejeu.body.data.id === envoi.body.data.id && svc.sent.length === nbEnvois)
  const simultanes = await Promise.all(Array.from({ length: 4 }, () => api('POST', `/admin/whatsapp/chat/conversations/${convA.id}/messages`, { token: admin, body: { text: 'Un seul envoi', clientRef: `ref-${stamp}-0002` } })))
  check('4 requêtes simultanées avec le même clientRef → 1 seul message envoyé', svc.sent.filter((m) => m.text === 'Un seul envoi').length === 1 && simultanes.every((r) => r.status < 300), JSON.stringify(simultanes.map((r) => r.status)))
  const apresEnvoi = await api('GET', `/admin/whatsapp/chat/conversations/${convA.id}`, { token: admin })
  check('aperçu de la conversation mis à jour (sortant)', apresEnvoi.body.data.lastDirection === 'out' && apresEnvoi.body.data.lastMessage.length > 0)
  const v = await api('POST', `/admin/whatsapp/chat/conversations/${convA.id}/messages`, { token: admin, body: { text: '   ' } })
  check('message vide → 422', v.status === 422)
  check('message trop long (>4000) → 422', (await api('POST', `/admin/whatsapp/chat/conversations/${convA.id}/messages`, { token: admin, body: { text: 'a'.repeat(4001) } })).status === 422)
  check('champ inconnu refusé', (await api('POST', `/admin/whatsapp/chat/conversations/${convA.id}/messages`, { token: admin, body: { text: 'ok', to: '+2250000000000' } })).status === 422)

  section('Fusion avec l’événement « message envoyé » du service (course)')
  // Le service annonce notre propre envoi (origine « api ») avec le même identifiant, avant ou après la réponse.
  pousser(evt({ id: envoi.body.data.id ? `CHATMSG${svc.sent.findIndex((m) => m.text === 'Oui, samedi 10h est possible.') + 1}` : 'x', direction: 'out', origin: 'api', text: 'Oui, samedi 10h est possible.' }))
  await sync()
  check('aucun doublon : un seul message pour cet envoi', (await query("SELECT id FROM whatsapp_messages WHERE conversation_id = ? AND body = 'Oui, samedi 10h est possible.'", [convA.id])).length === 1)
  pousser({ type: 'status', id: `CHATMSG${svc.sent.findIndex((m) => m.text === 'Oui, samedi 10h est possible.') + 1}`, jid: `${A}@s.whatsapp.net`, status: 'delivered' })
  await sync()
  const apresStatut = await api('GET', `/admin/whatsapp/chat/conversations/${convA.id}/messages?limit=100`, { token: admin })
  check('accusé « remis » appliqué au message envoyé', apresStatut.body.data.messages.find((m) => m.text === 'Oui, samedi 10h est possible.')?.status === 'delivered')
  pousser({ type: 'status', id: `CHATMSG${svc.sent.findIndex((m) => m.text === 'Oui, samedi 10h est possible.') + 1}`, jid: `${A}@s.whatsapp.net`, status: 'read' })
  pousser({ type: 'status', id: `CHATMSG${svc.sent.findIndex((m) => m.text === 'Oui, samedi 10h est possible.') + 1}`, jid: `${A}@s.whatsapp.net`, status: 'delivered' })
  await sync()
  check('l’état ne redescend jamais (lu puis « remis » tardif → reste lu)', (await api('GET', `/admin/whatsapp/chat/conversations/${convA.id}/messages?limit=100`, { token: admin })).body.data.messages.find((m) => m.text === 'Oui, samedi 10h est possible.')?.status === 'read')
  pousser(evt({ id: 'PHONE-1', direction: 'out', origin: 'phone', text: 'Écrit depuis le téléphone du salon' }))
  await sync()
  const dep = (await api('GET', `/admin/whatsapp/chat/conversations/${convA.id}/messages?limit=100`, { token: admin })).body.data.messages.find((m) => m.text.startsWith('Écrit depuis'))
  check('message écrit depuis le téléphone : sortant, origine « phone », sans non lu', dep?.direction === 'out' && dep?.origin === 'phone')

  section('Consentement et premier contact')
  const inconnu = await api('POST', '/admin/whatsapp/chat/conversations', { token: admin, body: { phone: local(C), text: 'Bonjour !' } })
  check('numéro inconnu qui n’a jamais écrit : le salon peut lui écrire (201)', inconnu.status === 201, inconnu.texte.slice(0, 200))
  const envoisAvant = svc.sent.length
  const clienteOk = await api('POST', '/admin/whatsapp/chat/conversations', { token: admin, body: { phone: `+${E}`, text: 'Bonjour Eve, votre rendez-vous est confirmé.', clientRef: `ref-${stamp}-0003` } })
  check('cliente enregistrée consentante : discussion démarrée (201), nom de la fiche', clienteOk.status === 201 && clienteOk.body.data.conversation.name === 'Eve Traoré' && clienteOk.body.data.message.status === 'sent', clienteOk.texte.slice(0, 220))
  check('le service a reçu le message', svc.sent.length === envoisAvant + 1 && svc.sent.at(-1).to === `+${E}`)
  const refus = await api('POST', '/admin/whatsapp/chat/conversations', { token: admin, body: { phone: `0${local(D)}`.slice(-10), text: 'Bonjour' } })
  check('cliente qui avait refusé WhatsApp : le salon peut lui écrire depuis le chat (201)', refus.status === 201 && svc.sent.length === envoisAvant + 2, refus.texte.slice(0, 200))
  const convD = (await api('GET', '/admin/whatsapp/chat/conversations?q=Dina', { token: admin })).body.data[0]
  const repD = await api('POST', `/admin/whatsapp/chat/conversations/${convD.id}/messages`, { token: admin, body: { text: 'Réponse refusée' } })
  check('répondre à une cliente qui avait refusé : possible (201)', repD.status === 201 && svc.sent.length === envoisAvant + 3)
  check('numéro invalide → 422', (await api('POST', '/admin/whatsapp/chat/conversations', { token: admin, body: { phone: '123', text: 'x' } })).status === 422)
  check('numéro étranger refusé → 422', (await api('POST', '/admin/whatsapp/chat/conversations', { token: admin, body: { phone: '+33612345678', text: 'x' } })).status === 422)

  section('Échec d’envoi et « Réessayer »')
  svc.sendMode = 'notconnected'
  const ko = await api('POST', `/admin/whatsapp/chat/conversations/${convA.id}/messages`, { token: admin, body: { text: 'Message qui échoue', clientRef: `ref-${stamp}-0004` } })
  check('WhatsApp déconnecté : message enregistré en « échec » (pas d’erreur 5xx)', ko.status === 201 && ko.body.data.status === 'failed' && ko.body.data.error === 'NOT_CONNECTED', ko.texte.slice(0, 200))
  check('le message échoué reste dans l’historique', (await api('GET', `/admin/whatsapp/chat/conversations/${convA.id}/messages?limit=100`, { token: admin })).body.data.messages.some((m) => m.id === ko.body.data.id && m.status === 'failed'))
  svc.sendMode = 'ratelimit'
  const rl = await api('POST', `/admin/whatsapp/chat/messages/${ko.body.data.id}/retry`, { token: admin, body: {} })
  check('limite du service : réessai → toujours « échec » (RATE_LIMITED)', rl.body?.data?.status === 'failed' && rl.body.data.error === 'RATE_LIMITED', rl.texte.slice(0, 200))
  svc.sendMode = 'slow'
  const nbAvantRetry = svc.sent.length
  const retries = await Promise.all(Array.from({ length: 3 }, () => api('POST', `/admin/whatsapp/chat/messages/${ko.body.data.id}/retry`, { token: admin, body: {} })))
  check('3 « Réessayer » simultanés → un seul envoi réel, aucun doublon', svc.sent.length === nbAvantRetry + 1 && svc.sent.filter((m) => m.text === 'Message qui échoue').length === 1, `${svc.sent.length - nbAvantRetry} envoi(s) ; ${JSON.stringify(retries.map((r) => r.status))}`)
  svc.sendMode = 'ok'
  const final = (await api('GET', `/admin/whatsapp/chat/conversations/${convA.id}/messages?limit=100`, { token: admin })).body.data.messages.find((m) => m.id === ko.body.data.id)
  check('après le réessai : état « sent »', final?.status === 'sent')
  const rejeuRetry = await api('POST', `/admin/whatsapp/chat/messages/${ko.body.data.id}/retry`, { token: admin, body: {} })
  check('réessayer un message déjà envoyé : sans effet', rejeuRetry.status === 200 && rejeuRetry.body.replayed === true && svc.sent.filter((m) => m.text === 'Message qui échoue').length === 1)
  check('réessayer un message reçu → 404', (await api('POST', `/admin/whatsapp/chat/messages/${p1.body.data.messages[0].id}/retry`, { token: admin, body: {} })).status === 404)

  section('Service indisponible : l’historique reste consultable')
  svc.mode = 'down'
  await wait(1100)
  const up = await api('GET', '/admin/whatsapp/chat/updates?since=0', { token: admin })
  check('updates → 200 avec sync.ok=false (le dashboard affiche « hors ligne »)', up.status === 200 && up.body.data.sync.ok === false && up.body.data.conversations.length >= 3, up.texte.slice(0, 200))
  check('historique toujours lisible', (await api('GET', `/admin/whatsapp/chat/conversations/${convA.id}/messages`, { token: admin })).body.data.messages.length > 0)
  const koDown = await api('POST', `/admin/whatsapp/chat/conversations/${convA.id}/messages`, { token: admin, body: { text: 'Pendant la panne', clientRef: `ref-${stamp}-0005` } })
  check('envoi pendant la panne → message « échec » (réessai possible)', koDown.status === 201 && koDown.body.data.status === 'failed')
  svc.mode = 'ok'
  const rep = await api('POST', `/admin/whatsapp/chat/messages/${koDown.body.data.id}/retry`, { token: admin, body: {} })
  check('service rétabli : « Réessayer » fonctionne', rep.body?.data?.status === 'sent')

  section('Service redémarré avec un journal vierge')
  const cap = await etatSync()
  svc.events = []; svc.seq = 0
  pousser(evt({ id: 'RESET-1', text: 'Après remise à zéro du service' }))
  await sync()
  check('curseur trop haut → remise à zéro et lecture reprise', (await query('SELECT id FROM whatsapp_messages WHERE wa_message_id = ?', ['RESET-1'])).length === 1 && cap > 1)

  section('Contact sans numéro (identifiant WhatsApp « LID »)')
  pousser(evt({ id: 'LID-1', jid: '9988776655@lid', phone: null, pushName: 'Inconnue LID', text: 'Message sans numéro' }))
  await sync()
  const lid = (await api('GET', '/admin/whatsapp/chat/conversations?q=Inconnue', { token: admin })).body.data[0]
  check('apparaît dans la messagerie, sans numéro', lid?.name === 'Inconnue LID' && lid.phone === null)
  const repLid = await api('POST', `/admin/whatsapp/chat/conversations/${lid.id}/messages`, { token: admin, body: { text: 'Réponse' } })
  check('répondre sans numéro connu → 422 explicite', repLid.status === 422 && repLid.body?.error?.code === 'WHATSAPP_CHAT_NO_PHONE')

  section('Persistance après redémarrage du serveur')
  const nbMessages = Number((await query('SELECT COUNT(*) AS n FROM whatsapp_messages'))[0].n)
  const nbConv = Number((await query('SELECT COUNT(*) AS n FROM whatsapp_conversations'))[0].n)
  apiTest.stop()
  await wait(800)
  apiTest = await startApi(4262, ENV, { capture: true })
  const BASE2 = apiTest.base
  const adminBis = (await (await fetch(`${BASE2}/api/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: config.admin.email, password: config.admin.password }) })).json()).data.token
  const apresRedemarrage = await (await fetch(`${BASE2}/api/admin/whatsapp/chat/conversations`, { headers: { Authorization: `Bearer ${adminBis}` } })).json()
  check('les conversations et messages sont retrouvés après redémarrage', apresRedemarrage.data.some((c) => c.phone === A) && Number((await query('SELECT COUNT(*) AS n FROM whatsapp_messages'))[0].n) === nbMessages && Number((await query('SELECT COUNT(*) AS n FROM whatsapp_conversations'))[0].n) === nbConv)
  const sRe = await (await fetch(`${BASE2}/api/admin/whatsapp/chat/sync`, { method: 'POST', headers: { Authorization: `Bearer ${adminBis}`, 'Content-Type': 'application/json' }, body: '{}' })).json()
  check('après redémarrage : rien n’est retraité (pas de doublon)', sRe.data.traites === 0 && Number((await query('SELECT COUNT(*) AS n FROM whatsapp_messages'))[0].n) === nbMessages)

  section('Confidentialité')
  const sortie = apiTest.sortie()
  check('journaux du serveur : ni secret ni texte des messages', !sortie.includes(SECRET) && !sortie.includes('Oui, samedi 10h') && !sortie.includes('Message qui échoue') && !sortie.includes('Nouveau message en direct'))
  check('le secret du service n’apparaît dans aucune réponse', ![lst, u0, envoi, ko, clienteOk].some((r) => r.texte.includes(SECRET)))
  check('chaque appel au service est signé', svc.calls.every((c) => c.ok))
  const logs = await query("SELECT id FROM message_logs WHERE channel = 'whatsapp' AND recipient LIKE ?", [`%${A.slice(-8)}%`])
  check('le chat n’écrit pas dans le journal des notifications (aucune confusion avec les envois automatiques)', logs.length === 0)
} finally {
  await nettoyer()
  await execute('UPDATE whatsapp_sync_state SET last_seq = ? WHERE id = 1', [avantSeq]).catch(() => {})
  apiTest.stop(); service.close()
  await closePool()
}

console.log(`\n${passed + failed} contrôle(s) : ${passed} réussi(s), ${failed} échec(s)`)
process.exit(failed ? 1 : 0)
