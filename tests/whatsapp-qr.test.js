/**
 * Tests de l'intégration du service WhatsApp QR (Baileys) — AUCUN vrai WhatsApp, AUCUN vrai service :
 * un faux service écoute en local (port 4240) et vérifie la signature HMAC comme le vrai
 * (même chaîne signée, tolérance, nonce à usage unique). Une fausse API Meta (port 4241) sert à
 * prouver qu'il n'y a JAMAIS de repli vers Meta.
 *
 * `node tests/whatsapp-qr.test.js` démarre sa propre API (port 4250). Base du `.env` : base de TEST uniquement.
 */
import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'

import { config } from '../src/config/env.js'
import { closePool, execute, query } from '../src/config/database.js'
import { signer } from '../src/lib/whatsappQr.js'
import { envoyer, verifierConsentement } from '../src/modules/messaging/model.js'
import { findByPhone } from '../src/modules/customers/model.js'
import { JEKO_OFF, startApi } from './lib/start-api.js'

if (config.isProduction) {
  console.error('Refus : ces tests écrivent en base, jamais avec NODE_ENV=production.')
  process.exit(1)
}

const SECRET = 'q'.repeat(48)
const QR_PAYLOAD = 'FAKEQRPAYLOAD0123456789'
const QR_DATA_URL = `data:image/png;base64,${QR_PAYLOAD}`

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/* ─────────────── Faux service QR ─────────────── */
const svc = {
  secret: SECRET,
  mode: 'ok', // ok | down | slow
  state: 'disconnected',
  hasSavedSession: false,
  qrAvailable: false,
  lastError: null,
  sent: [], // messages reçus sur /v1/send
  calls: [], // { method, path, headers }
  nonces: new Set(),
  optedOut: new Set(),
  sendFailure: null,
}
const sha = (s) => createHash('sha256').update(s).digest('hex')
const statusBody = () => ({
  state: svc.state, connected: svc.state === 'connected', phone: svc.state === 'connected' ? '+225••••••05' : null,
  connectedAt: svc.state === 'connected' ? new Date().toISOString() : null, since: new Date().toISOString(),
  hasQr: svc.qrAvailable, qrExpiresAt: svc.qrAvailable ? new Date(Date.now() + 40000).toISOString() : null,
  lastError: svc.lastError, reconnectAttempts: 0, hasSavedSession: svc.hasSavedSession,
})
const service = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString()
    const json = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }
    if (svc.mode === 'down') return req.socket.destroy()
    if (svc.mode === 'slow') await wait(4000)
    // Vérification indépendante de celle du backend : on reconstruit la chaîne signée à la main.
    const h = req.headers
    const path = req.url.split('?')[0]
    const base = [h['x-bh-timestamp'], h['x-bh-nonce'], req.method, path, sha(raw), h['x-bh-actor'] ?? ''].join('\n')
    const attendu = createHmac('sha256', svc.secret).update(base).digest('hex')
    const frais = Math.abs(Date.now() - Number(h['x-bh-timestamp'])) <= 60_000
    const nonceOk = /^[A-Za-z0-9_-]{16,64}$/.test(h['x-bh-nonce'] ?? '') && !svc.nonces.has(h['x-bh-nonce'])
    svc.calls.push({ method: req.method, path, actor: h['x-bh-actor'], timestamp: Number(h['x-bh-timestamp']), nonce: h['x-bh-nonce'], validSignature: attendu === h['x-bh-signature'] })
    if (attendu !== h['x-bh-signature'] || !frais || !nonceOk) return json(401, { error: { code: 'UNAUTHORIZED', message: 'Authentification requise' } })
    svc.nonces.add(h['x-bh-nonce'])
    const body = raw ? JSON.parse(raw) : {}

    if (req.method === 'GET' && path === '/v1/status') return json(200, statusBody())
    if (req.method === 'POST' && path === '/v1/connect') {
      if (svc.state !== 'connected') { svc.state = svc.hasSavedSession ? 'connecting' : 'waiting_qr'; svc.qrAvailable = !svc.hasSavedSession }
      return json(202, statusBody())
    }
    if (req.method === 'GET' && path === '/v1/qr') {
      if (!svc.qrAvailable) return json(404, { error: { code: 'NO_QR', message: 'Aucun QR' } })
      return json(200, { dataUrl: QR_DATA_URL, expiresAt: new Date(Date.now() + 40000).toISOString() })
    }
    if (req.method === 'POST' && path === '/v1/disconnect') {
      svc.state = 'disconnected'; svc.qrAvailable = false; svc.hasSavedSession = false
      return json(200, statusBody())
    }
    if (req.method === 'POST' && path === '/v1/send') {
      if (svc.state !== 'connected') return json(409, { error: { code: 'NOT_CONNECTED', message: 'non connecté' } })
      if (svc.sendFailure === 429) return json(429, { error: { code: 'RATE_LIMITED', message: 'trop' } }, { 'Retry-After': '30' })
      if ([...svc.optedOut].some((n) => body.to.endsWith(n))) return json(422, { error: { code: 'RECIPIENT_OPTED_OUT', message: 'désinscrit' } })
      svc.sent.push({ to: body.to, text: body.text, reference: body.reference })
      return json(202, { messageId: `MSG${svc.sent.length}`, status: 'sent_to_whatsapp', delivered: null, reference: body.reference ?? null })
    }
    if (path.startsWith('/v1/optout/') && (req.method === 'PUT' || req.method === 'DELETE')) {
      const n = path.split('/').pop()
      if (req.method === 'PUT') svc.optedOut.add(n); else svc.optedOut.delete(n)
      return json(200, { optedOut: req.method === 'PUT' })
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'inconnu' } })
  })
})
await new Promise((r) => service.listen(4240, '127.0.0.1', r))

/* ─────────────── Fausse API Meta : ne doit JAMAIS être appelée ─────────────── */
let appelsMeta = 0
const meta = createServer((req, res) => { appelsMeta += 1; res.end('{}') })
await new Promise((r) => meta.listen(4241, '127.0.0.1', r))

const phone = `07${String(Date.now()).slice(-8)}`
const apiTest = await startApi(4250, {
  ...JEKO_OFF,
  ADMIN_TEST_PHONE: phone, // seul destinataire d'essai admis, configuré côté serveur
  WHATSAPP_ENABLED: 'false', // drapeau Meta : ne doit pas empêcher les envois par le numéro connecté (service QR)
  WHATSAPP_PROVIDER: 'qr',
  WHATSAPP_QR_SERVICE_URL: 'http://127.0.0.1:4240',
  WHATSAPP_QR_SERVICE_SECRET: SECRET,
  WHATSAPP_QR_TIMEOUT_MS: '1500',
  // Une configuration Meta COMPLÈTE est présente exprès : elle ne doit pas être utilisée.
  WHATSAPP_PHONE_NUMBER_ID: '111',
  WHATSAPP_ACCESS_TOKEN: 'fake-meta-token',
  WHATSAPP_GRAPH_URL: 'http://127.0.0.1:4241',
  WHATSAPP_TEMPLATE_REQUEST_RECEIVED: 'demande_recue',
  WHATSAPP_TEMPLATE_REQUEST_CONFIRMED: 'demande_confirmee',
}, { capture: true })
const BASE = apiTest.base

async function api(method, path, { body, token } = {}) {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const texte = await response.text()
  let json = null
  try { json = JSON.parse(texte) } catch { /* vide */ }
  return { status: response.status, body: json, texte, headers: response.headers }
}

const stamp = String(Date.now()).slice(-7)
const mdp = 'MotDePasseTest-2026'
const mails = [`wa.qr.agent1.${stamp}@example.com`, `wa.qr.agent2.${stamp}@example.com`]
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
const demande = (over = {}) => api('POST', '/booking-requests', {
  body: { besoin: 'creation', type: 'small', volume: 'M', longueur: 'mi-dos', delai: 'standard', etat: 'bon', desiredDate: tomorrow, firstName: 'Testeuse', lastName: 'Qr', phone, email: `qr.${stamp}@example.com`, ...over },
})
const journal = () => query("SELECT * FROM message_logs WHERE channel = 'whatsapp' AND recipient LIKE ? ORDER BY id", [`%${phone.slice(-8)}%`])

let admin = null
const phone2 = `07${String(Date.now() + 13).slice(-8)}`
try {
  section('Démarrage et conformité du protocole')
  check('le backend démarre avec le service QR configuré', (await fetch(`${BASE}/api/health`)).ok)
  // Vecteur calculé avec le code réel du service (src/utils/signature.js) : si l'un change, ce test échoue.
  const vecteur = signer('s'.repeat(40), { timestamp: '1760000000000', nonce: 'abcdefghijklmnop', method: 'post', path: '/v1/send', body: '{"to":"+2250102030405","text":"Bonjour"}', actor: 'admin-1' })
  check('signature identique à celle du service (vecteur de référence)', vecteur === '7513a2cb00b751deb2a3b889a652c691091c27ce5ce8ba5e4cf587ab2cd30120', vecteur)

  const login = await api('POST', '/admin/auth/login', { body: { email: config.admin.email, password: config.admin.password } })
  admin = login.body?.data?.token
  check('connexion administratrice', Boolean(admin))
  check('l’administratrice a le droit « whatsapp »', login.body?.data?.user?.permissions?.includes('whatsapp'))

  section('Droits : réservé à l’administratrice')
  const c1 = await api('POST', '/admin/auth/users', { token: admin, body: { name: 'Agent Qr Un', email: mails[0], password: mdp, role: 'staff', permissions: ['messaging', 'customers', 'appointments'] } })
  const c2 = await api('POST', '/admin/auth/users', { token: admin, body: { name: 'Agent Qr Deux', email: mails[1], password: mdp } })
  check('agents de test créés', c1.status === 201 && c2.status === 201, `${c1.status}/${c2.status}`)
  const t1 = (await api('POST', '/admin/auth/login', { body: { email: mails[0], password: mdp } })).body?.data?.token
  const t2 = (await api('POST', '/admin/auth/login', { body: { email: mails[1], password: mdp } })).body?.data?.token
  const accordeWa = await api('POST', '/admin/auth/users', { token: admin, body: { name: 'X Y', email: `wa.qr.bad.${stamp}@example.com`, password: mdp, permissions: ['whatsapp'] } })
  check('droit « whatsapp » accordable à un agent par l’administratrice (201)', accordeWa.status === 201 && accordeWa.body?.data?.permissions?.includes('whatsapp'), String(accordeWa.status))
  await execute('DELETE FROM users WHERE email = ?', [`wa.qr.bad.${stamp}@example.com`])
  check('agent absent des droits par défaut du staff', !(c2.body?.data?.permissions ?? []).includes('whatsapp'))
  const appelsAvant = svc.calls.length
  for (const [nom, token] of [['agent avec droits choisis', t1], ['agent aux droits par défaut', t2]]) {
    for (const [m, p, b] of [['GET', '/admin/whatsapp/status'], ['POST', '/admin/whatsapp/connect', {}], ['GET', '/admin/whatsapp/qr'], ['POST', '/admin/whatsapp/disconnect', { confirm: true }], ['GET', '/admin/whatsapp/logs'], ['POST', '/admin/whatsapp/test-message', { to: phone }]]) {
      const r = await api(m, p, { token, body: b })
      check(`${nom} : ${m} ${p.replace('/admin/whatsapp', '')} refusé (403)`, r.status === 403 && r.body?.error?.code === 'MISSING_PERMISSION', String(r.status))
    }
  }
  check('aucun appel n’a atteint le service pour un agent', svc.calls.length === appelsAvant)
  check('sans jeton : 401', (await api('GET', '/admin/whatsapp/status')).status === 401)

  section('État déconnecté, connexion, QR')
  const s0 = await api('GET', '/admin/whatsapp/status', { token: admin })
  check('statut → 200, déconnecté, service joignable', s0.status === 200 && s0.body?.data?.connection?.state === 'disconnected' && s0.body?.data?.service?.reachable === true, s0.texte.slice(0, 200))
  check('statut : fournisseur « qr », configuré', s0.body?.data?.provider === 'qr' && s0.body?.data?.configured === true)
  check('statut : pas de cache (no-store)', /no-store/.test(s0.headers.get('cache-control') ?? ''))
  const q0 = await api('GET', '/admin/whatsapp/qr', { token: admin })
  check('QR indisponible → 404 WHATSAPP_NO_QR', q0.status === 404 && q0.body?.error?.code === 'WHATSAPP_NO_QR', q0.texte.slice(0, 160))
  const cn = await api('POST', '/admin/whatsapp/connect', { token: admin, body: {} })
  check('connexion demandée → 202, état waiting_qr', cn.status === 202 && cn.body?.data?.connection?.state === 'waiting_qr', cn.texte.slice(0, 200))
  const q1 = await api('GET', '/admin/whatsapp/qr', { token: admin })
  check('QR récupéré → 200 {dataUrl, expiresAt}', q1.status === 200 && q1.body?.data?.dataUrl === QR_DATA_URL && Boolean(q1.body?.data?.expiresAt))
  check('QR : Cache-Control no-store', /no-store/.test(q1.headers.get('cache-control') ?? ''))
  const q2 = await api('GET', '/admin/whatsapp/qr', { token: admin })
  check('relire le QR ne relance pas de connexion (une seule demande de connexion)', svc.calls.filter((c) => c.path === '/v1/connect').length === 1 && q2.status === 200)
  svc.qrAvailable = false; svc.state = 'disconnected'; svc.lastError = 'qr_expired'
  const s1 = await api('GET', '/admin/whatsapp/status', { token: admin })
  check('QR expiré : état déconnecté + lastError=qr_expired', s1.body?.data?.connection?.state === 'disconnected' && s1.body?.data?.connection?.lastError === 'qr_expired')
  check('QR expiré : /qr → 404', (await api('GET', '/admin/whatsapp/qr', { token: admin })).status === 404)
  svc.lastError = null

  section('Protocole HMAC côté backend')
  const signees = svc.calls.filter((c) => c.validSignature)
  check('toutes les requêtes du backend ont une signature valide', svc.calls.length > 0 && signees.length === svc.calls.length)
  check('horodatage frais et nonces tous différents', svc.calls.every((c) => Math.abs(Date.now() - c.timestamp) < 60_000) && new Set(svc.calls.map((c) => c.nonce)).size === svc.calls.length)
  check('acteur = identifiant de l’admin, pas son e-mail', svc.calls.every((c) => /^admin-\d+$/.test(c.actor)))
  svc.secret = 'z'.repeat(48)
  const bad = await api('POST', '/admin/whatsapp/connect', { token: admin, body: {} })
  check('secret différent → erreur contrôlée WHATSAPP_AUTH_FAILED (502)', bad.status === 502 && bad.body?.error?.code === 'WHATSAPP_AUTH_FAILED', bad.texte.slice(0, 200))
  check('ni le secret ni un détail interne dans l’erreur', !bad.texte.includes(SECRET) && !bad.texte.includes('z'.repeat(20)) && !/UNAUTHORIZED|Authentification requise/.test(bad.texte))
  svc.secret = SECRET

  section('Connecté, reconnexion, déconnexion')
  svc.state = 'connected'; svc.hasSavedSession = true; svc.qrAvailable = false
  const s2 = await api('GET', '/admin/whatsapp/status', { token: admin })
  check('état connecté, numéro masqué, session conservée', s2.body?.data?.connection?.connected === true && /••/.test(s2.body?.data?.connection?.phone ?? '') && s2.body?.data?.connection?.hasSavedSession === true)
  check('connecté : /qr → 404 (aucun QR superflu)', (await api('GET', '/admin/whatsapp/qr', { token: admin })).status === 404)
  // Redémarrage du service avec session conservée : il se reconnecte seul, sans QR.
  svc.state = 'connecting'
  const s3 = await api('GET', '/admin/whatsapp/status', { token: admin })
  check('après redémarrage : connexion en cours, sans QR, session conservée', s3.body?.data?.connection?.state === 'connecting' && s3.body?.data?.connection?.hasQr === false && s3.body?.data?.connection?.hasSavedSession === true)
  svc.state = 'connected'
  const avantDec = svc.calls.length
  const d0 = await api('POST', '/admin/whatsapp/disconnect', { token: admin, body: {} })
  check('déconnexion sans confirmation → 422, rien envoyé au service', d0.status === 422 && svc.calls.length === avantDec)
  const d1 = await api('POST', '/admin/whatsapp/disconnect', { token: admin, body: { confirm: true } })
  check('déconnexion confirmée → 200, déconnecté, session supprimée côté service', d1.status === 200 && d1.body?.data?.connection?.state === 'disconnected' && d1.body?.data?.connection?.hasSavedSession === false)

  section('Service indisponible ou trop lent')
  svc.mode = 'down'
  const sd = await api('GET', '/admin/whatsapp/status', { token: admin })
  check('service coupé : statut 200 avec service.reachable=false (pas d’erreur brute)', sd.status === 200 && sd.body?.data?.service?.reachable === false && sd.body?.data?.service?.error === 'UNREACHABLE', sd.texte.slice(0, 200))
  const cd = await api('POST', '/admin/whatsapp/connect', { token: admin, body: {} })
  check('connexion impossible → 502 WHATSAPP_UNREACHABLE', cd.status === 502 && cd.body?.error?.code === 'WHATSAPP_UNREACHABLE', cd.texte.slice(0, 200))
  check('l’erreur ne révèle ni URL interne ni secret', !cd.texte.includes('127.0.0.1') && !cd.texte.includes(SECRET))
  svc.mode = 'slow'
  const t0 = Date.now()
  const sl = await api('POST', '/admin/whatsapp/connect', { token: admin, body: {} })
  check('délai dépassé → 504 WHATSAPP_TIMEOUT en ~1,5 s (pas 4 s)', sl.status === 504 && sl.body?.error?.code === 'WHATSAPP_TIMEOUT' && Date.now() - t0 < 3500, `${sl.status} ${Date.now() - t0} ms`)
  svc.mode = 'ok'; await wait(4200) // laisse finir la réponse lente en attente

  section('Notifications automatiques par le service QR')
  svc.state = 'connected'; svc.hasSavedSession = true
  await api('POST', '/admin/whatsapp/connect', { token: admin, body: {} })
  const r1 = await demande()
  check('demande de rendez-vous créée (201)', r1.status === 201, r1.texte.slice(0, 150))
  await wait(1500)
  let logs = await journal()
  const recu = svc.sent.find((m) => m.to.endsWith(phone.slice(-8)))
  check('« demande reçue » → texte envoyé au service (pas de modèle Meta)', Boolean(recu) && /Testeuse/.test(recu.text) && /DM-|BH-|demande/i.test(recu.text), JSON.stringify(recu))
  check('numéro transmis au format international avec « + »', /^\+225\d{8,10}$/.test(recu?.to ?? ''), recu?.to)
  check('journal : ligne « sent » avec la référence du service', logs.at(-1)?.status === 'sent' && String(logs.at(-1)?.provider_reference).startsWith('MSG'), JSON.stringify(logs.at(-1)))
  const nbEnvois = svc.sent.length
  // Même message, même personne : pas de doublon.
  const dup = await api('POST', '/admin/whatsapp/test-message', { token: admin, body: { text: 'Texte identique' } })
  const dup2 = await api('POST', '/admin/whatsapp/test-message', { token: admin, body: { text: 'Texte identique' } })
  check('premier message d’essai envoyé', dup.status === 200 && dup.body?.data?.status === 'sent', dup.texte.slice(0, 160))
  check('même texte, même numéro : ignoré (doublon), un seul envoi réel', dup2.body?.data?.status === 'skipped' && /Doublon/.test(dup2.body?.data?.error ?? '') && svc.sent.length === nbEnvois + 1)

  section('Consentement et désinscription')
  await execute('UPDATE customers SET whatsapp_opt_in = 0 WHERE phone = ?', [phone])
  const avantOpt = svc.sent.length
  await demande({ desiredDate: tomorrow })
  await wait(1500)
  logs = await journal()
  check('cliente ayant refusé WhatsApp : sa notification de rendez-vous part quand même', svc.sent.length === avantOpt + 1 && logs.at(-1)?.status === 'sent', JSON.stringify(logs.at(-1)))
  await execute('UPDATE customers SET whatsapp_opt_in = 1 WHERE phone = ?', [phone])
  svc.optedOut.add(phone.slice(-8))
  const op = await api('POST', '/admin/whatsapp/test-message', { token: admin, body: { text: 'Autre texte désinscrit' } })
  check('numéro sur la liste de désinscription du service : ignoré, pas d’envoi', op.body?.data?.status === 'skipped' && !svc.sent.some((m) => m.text === 'Autre texte désinscrit'))
  svc.optedOut.clear()

  section('Message d’essai : numéro saisi dans le dashboard, sans ADMIN_TEST_PHONE obligatoire')
  const avantEssai = svc.sent.length
  const autre = await api('POST', '/admin/whatsapp/test-message', { token: admin, body: { to: '0709998877', text: `Essai vers un inconnu ${Date.now()}` } })
  check('numéro saisi dans le dashboard : l’essai part vers ce numéro', autre.status === 200 && autre.body?.data?.status === 'sent' && svc.sent.at(-1)?.text.startsWith('Essai vers un inconnu') && svc.sent.length === avantEssai + 1, autre.texte.slice(0, 160))
  const sans = await api('POST', '/admin/whatsapp/test-message', { token: admin, body: { text: 'Essai administratrice sans numéro' } })
  check('sans numéro dans la requête : l’essai part vers le numéro du serveur', sans.status === 200 && sans.body?.data?.status === 'sent' && svc.sent.at(-1)?.text === 'Essai administratrice sans numéro' && svc.sent.at(-1).to.endsWith(phone.slice(-8)), sans.texte.slice(0, 160))
  const meme = await api('POST', '/admin/whatsapp/test-message', { token: admin, body: { to: `+225 ${phone}`, text: 'Essai même numéro écrit autrement' } })
  check('même numéro écrit en +225 : accepté', meme.status === 200 && meme.body?.data?.status === 'sent', meme.texte.slice(0, 160))
  const tw = await api('POST', '/admin/messaging/test-whatsapp', { token: admin, body: { to: '0709998877', message: `Essai route messagerie ${Date.now()}` } })
  check('route d’essai WhatsApp de la messagerie : numéro saisi accepté', tw.body?.data?.result?.status === 'sent', tw.texte.slice(0, 200))
  const savePhone = config.admin.testPhone
  config.admin.testPhone = ''
  const vide = await verifierConsentement({ channel: 'whatsapp', kind: 'test', customer: null, destinataire: phone })
  check('aucun numéro d’essai configuré : l’essai reste autorisé (numéro saisi)', vide.autorise === true)
  config.admin.testPhone = savePhone

  section('Consentement : avec fiche, sans fiche, inconnu (vérification directe)')
  const [fiche] = await query('SELECT id FROM customers WHERE phone = ?', [phone])
  const inconnu = `07${String(Date.now() + 7).slice(-8)}`
  const v = (over) => verifierConsentement({ channel: 'whatsapp', kind: 'appointment', customer: null, destinataire: phone, ...over })
  check('fiche retrouvée à partir du numéro seul (aucune fiche fournie) : autorisé', (await v({})).autorise === true && (await v({})).customerId === fiche.id)
  check('numéro écrit autrement (+225, espaces) : même fiche retrouvée', (await v({ destinataire: `+225 ${phone.slice(0, 2)} ${phone.slice(2, 4)} ${phone.slice(4)}` })).customerId === fiche.id)
  const inc = await v({ destinataire: inconnu })
  check('message lié à un rendez-vous, numéro sans fiche : autorisé (la cliente vient de réserver)', inc.autorise === true, JSON.stringify(inc))
  const incManuel = await v({ destinataire: inconnu, kind: 'campaign' })
  check('campagne promotionnelle vers un numéro sans fiche : consentement INCONNU → refusé', incManuel.autorise === false && /inconnu/i.test(incManuel.motif), JSON.stringify(incManuel))
  check('numéro vide ou trop court : refusé', (await v({ destinataire: '12' })).autorise === false)
  await execute('UPDATE customers SET whatsapp_opt_in = 0 WHERE id = ?', [fiche.id])
  const ref = await v({})
  check('fiche retrouvée par le numéro, WhatsApp refusé : un message de rendez-vous part quand même', ref.autorise === true && ref.customerId === fiche.id)
  const refCampagne = await v({ kind: 'campaign' })
  check('… mais une campagne promotionnelle respecte le refus', refCampagne.autorise === false && /refus/.test(refCampagne.motif))
  check('fiche fournie avec refus : message de rendez-vous autorisé, campagne refusée', (await v({ customer: { id: fiche.id, whatsappOptIn: false } })).autorise === true && (await v({ kind: 'campaign', customer: { id: fiche.id, whatsappOptIn: false } })).autorise === false)
  check('fiche fournie avec accord : autorisé', (await v({ customer: { id: fiche.id, whatsappOptIn: true } })).autorise === true)
  await execute('UPDATE customers SET whatsapp_opt_in = 1, sms_opt_in = 0 WHERE id = ?', [fiche.id])
  check('le refus SMS ne bloque que les campagnes SMS (canal par canal)', (await v({})).autorise === true && (await v({ channel: 'sms' })).autorise === true && (await v({ kind: 'campaign' })).autorise === true && (await v({ kind: 'campaign', channel: 'sms' })).autorise === false)
  await execute('UPDATE customers SET sms_opt_in = 1 WHERE id = ?', [fiche.id])
  check('e-mail inconnu : refusé', (await verifierConsentement({ channel: 'email', kind: 'manual', customer: null, destinataire: 'personne@example.org' })).autorise === false)
  check('essai vers un autre numéro : autorisé', (await v({ kind: 'test', destinataire: '0708887766' })).autorise === true)
  config.admin.testPhone = inconnu
  check('essai vers le numéro configuré sans fiche : seule exception, autorisée', (await v({ kind: 'test', destinataire: inconnu })).autorise === true)
  config.admin.testPhone = savePhone

  section('Numéros avec espaces, points, tirets ou indicatif : tous reçoivent')
  Object.assign(config.whatsapp, { provider: 'qr' })
  Object.assign(config.whatsapp.qr, { url: 'http://127.0.0.1:4240', secret: SECRET, timeoutMs: 1500 })
  const chiffresEsp = `07${String(Date.now() + 7).slice(-8)}`
  const avecEsp = chiffresEsp.replace(/(\d{2})(?=\d)/g, '$1 ')
  await execute('INSERT INTO customers (phone, phone_key, first_name, last_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, NOW(), NOW())', [avecEsp, chiffresEsp, 'Esp', 'Ace'])
  for (const forme of [avecEsp, `+225 ${avecEsp}`, chiffresEsp.replace(/(\d{2})(?=\d)/g, '$1.'), chiffresEsp.replace(/(\d{2})(?=\d)/g, '$1-'), `00225${chiffresEsp}`]) {
    check(`fiche retrouvée avec « ${forme} »`, (await findByPhone(forme))?.phone_key === chiffresEsp)
    const avant = svc.sent.length
    const r = await envoyer({ channel: 'whatsapp', kind: 'appointment', recipient: forme, body: `Bonjour ${forme} ${Math.random()}` }, null)
    check(`WhatsApp part vers « ${forme} »`, r.status === 'sent' && svc.sent.length === avant + 1 && svc.sent.at(-1).to.endsWith(chiffresEsp.slice(-8)), JSON.stringify(r))
  }

  check('ancienne forme à 8 chiffres (225 + 8) : la même fiche est retrouvée', (await findByPhone(`225${chiffresEsp.slice(-8)}`))?.phone_key === chiffresEsp)

  section('Consentement de bout en bout (journal, aucun envoi sans accord)')
  const avantSans = svc.sent.length
  const rr = await demande({ phone: phone2, firstName: 'Inconnue', email: `inconnue.${stamp}@example.com` })
  await wait(1200)
  const [dem2] = await query('SELECT id, customer_id FROM booking_requests WHERE phone = ? ORDER BY id DESC LIMIT 1', [phone2])
  check('demande d’une nouvelle cliente : fiche créée, accusé envoyé (consentement connu par défaut)', rr.status === 201 && Boolean(dem2?.customer_id) && svc.sent.length === avantSans + 1, `${rr.status} ${svc.sent.length - avantSans}`)
  await execute('UPDATE booking_requests SET customer_id = NULL WHERE id = ?', [dem2.id])
  await execute('DELETE FROM customers WHERE phone = ?', [phone2])
  const avantContact = svc.sent.length
  const pc = await api('PATCH', `/admin/booking-requests/${dem2.id}`, { token: admin, body: { status: 'rejected' } })
  await wait(1200)
  const [lg2] = await query("SELECT status, error FROM message_logs WHERE channel = 'whatsapp' AND recipient LIKE ? ORDER BY id DESC LIMIT 1", [`%${phone2.slice(-8)}%`])
  check('statut modifié (200), cliente sans fiche : le message automatique part quand même', pc.status === 200 && svc.sent.length === avantContact + 1, String(pc.status))
  check('journal : message « sent » même sans fiche cliente', lg2?.status === 'sent', JSON.stringify(lg2))

  section('Message manuel : fiche, refus, désinscription du service')
  const manuel = (message) => api('POST', '/admin/messaging/send', { token: admin, body: { customerId: fiche.id, channel: 'whatsapp', message } })
  const m1 = await manuel('Bonjour manuel 1')
  check('cliente avec accord : message envoyé', m1.body?.data?.status === 'sent' && svc.sent.some((m) => m.text === 'Bonjour manuel 1'), m1.texte.slice(0, 160))
  await execute('UPDATE customers SET whatsapp_opt_in = 0 WHERE id = ?', [fiche.id])
  const m2 = await manuel('Bonjour manuel 2')
  check('cliente ayant refusé : le message direct du salon part quand même', m2.body?.data?.status === 'sent' && svc.sent.some((m) => m.text === 'Bonjour manuel 2'), m2.texte.slice(0, 160))
  await execute('UPDATE customers SET whatsapp_opt_in = 1 WHERE id = ?', [fiche.id])
  svc.optedOut.add(phone.slice(-8))
  const m3 = await manuel('Bonjour manuel 3')
  check('accord dans la base mais numéro encore désinscrit côté service : ignoré par sécurité (aucun envoi)', m3.body?.data?.status === 'skipped' && !svc.sent.some((m) => m.text === 'Bonjour manuel 3'), m3.texte.slice(0, 200))
  svc.optedOut.clear()

  section('Synchronisation des désinscriptions : la base fait foi')
  const callsAvant = svc.calls.length
  const p1 = await api('PATCH', `/admin/customers/${fiche.id}`, { token: admin, body: { whatsappOptIn: false } })
  await wait(500)
  const put = svc.calls.slice(callsAvant).find((c) => c.method === 'PUT' && /^\/v1\/optout\/225\d+$/.test(c.path))
  check('fiche passée en refus → le service reçoit la désinscription (appel signé)', p1.status === 200 && Boolean(put) && put.validSignature && put.path.endsWith(phone.slice(-8)), JSON.stringify(svc.calls.slice(callsAvant).map((c) => `${c.method} ${c.path}`)))
  check('le service refuse désormais ce numéro', [...svc.optedOut].some((n) => n.endsWith(phone.slice(-8))))
  const appelsAvantRetrait = svc.calls.length
  const p2 = await api('PATCH', `/admin/customers/${fiche.id}`, { token: admin, body: { whatsappOptIn: true } })
  await wait(500)
  const del = svc.calls.slice(appelsAvantRetrait).find((c) => c.method === 'DELETE' && c.path.endsWith(phone.slice(-8)))
  check('fiche repassée en accord → la désinscription est retirée du service', p2.status === 200 && Boolean(del) && ![...svc.optedOut].some((n) => n.endsWith(phone.slice(-8))))
  await execute('UPDATE customers SET whatsapp_opt_in = 0 WHERE id = ?', [fiche.id])
  svc.optedOut.clear()
  check('liste du service vide → resynchronisation par l’administratrice : refus 403 pour un agent', (await api('POST', '/admin/whatsapp/sync-optouts', { token: t1 })).status === 403)
  const sy = await api('POST', '/admin/whatsapp/sync-optouts', { token: admin })
  check('resynchronisation (admin) : la cliente ayant refusé est poussée vers le service', sy.status === 200 && sy.body?.data?.synchronises >= 1 && [...svc.optedOut].some((n) => n.endsWith(phone.slice(-8))), sy.texte.slice(0, 200))
  svc.mode = 'down'
  const p3 = await api('PATCH', `/admin/customers/${fiche.id}`, { token: admin, body: { whatsappOptIn: true } })
  svc.mode = 'ok'
  check('service coupé : la modification de la fiche réussit quand même (la base fait foi)', p3.status === 200 && p3.body?.data?.whatsappOptIn === true)
  await wait(300)
  svc.optedOut.clear()

  section('Envois simultanés : un seul message part')
  const avantSimul = svc.sent.length
  const rafale = await Promise.all(Array.from({ length: 5 }, () => manuel('Message simultané identique')))
  const statuts = rafale.map((r) => r.body?.data?.status)
  check('5 envois simultanés du même texte : 1 seul « sent », les autres « skipped » (doublon)', statuts.filter((x) => x === 'sent').length === 1 && statuts.filter((x) => x === 'skipped').length === 4, JSON.stringify(statuts))
  check('un seul message réel est arrivé au service', svc.sent.length === avantSimul + 1 && svc.sent.filter((m) => m.text === 'Message simultané identique').length === 1)
  await execute('UPDATE customers SET whatsapp_opt_in = 0 WHERE id = ?', [fiche.id])
  const rafale2 = await Promise.all(Array.from({ length: 4 }, (_, i) => manuel(`Rafale refusée ${i}`)))
  check('4 envois vers une cliente ayant refusé : tous partent (messages directs du salon)', rafale2.every((r) => r.body?.data?.status === 'sent') && svc.sent.filter((m) => /^Rafale refusée/.test(m.text)).length === 4)
  await execute('UPDATE customers SET whatsapp_opt_in = 1 WHERE id = ?', [fiche.id])
  const rafale3 = await Promise.all(['Rafale A', 'Rafale B', 'Rafale C'].map((t) => manuel(t)))
  check('3 textes différents simultanés : les 3 partent (pas de faux doublon)', rafale3.every((r) => r.body?.data?.status === 'sent'), JSON.stringify(rafale3.map((r) => r.body?.data?.status)))

  section('Pannes : pas de repli vers Meta, pas d’annulation de réservation')
  const avantPanne = (await journal()).length
  svc.mode = 'down'
  const rp = await demande({ firstName: 'Panne', desiredDate: tomorrow })
  check('service QR coupé : la demande est quand même enregistrée (201)', rp.status === 201)
  await wait(2500)
  logs = await journal()
  check('journal : « failed » avec un motif clair, sans détail interne', logs.length > avantPanne && logs.at(-1)?.status === 'failed' && !/127\.0\.0\.1|ECONNRESET/.test(logs.at(-1)?.error ?? ''), JSON.stringify(logs.at(-1)))
  svc.mode = 'ok'
  svc.state = 'disconnected'
  const nc = await api('POST', '/admin/whatsapp/test-message', { token: admin, body: { text: 'Compte non connecté' } })
  check('compte non connecté : échec explicite « scannez le QR code »', nc.body?.data?.status === 'failed' && /connect/.test(nc.body?.data?.error ?? ''), nc.texte.slice(0, 200))
  svc.state = 'connected'; svc.sendFailure = 429
  const rl = await api('POST', '/admin/whatsapp/test-message', { token: admin, body: { text: 'Limite de débit' } })
  check('limite du service atteinte : échec journalisé (aucun contournement)', rl.body?.data?.status === 'failed' && /Limite/.test(rl.body?.data?.error ?? ''))
  svc.sendFailure = null
  check('AUCUN appel à l’API Meta pendant tout le test', appelsMeta === 0, `${appelsMeta} appel(s)`)

  section('Journal et absence de fuites')
  const lg = await api('GET', '/admin/whatsapp/logs', { token: admin })
  check('journal WhatsApp (admin) → 200 avec statuts', lg.status === 200 && Array.isArray(lg.body?.data) && lg.body.data.length >= 3 && lg.body.data.every((l) => ['queued', 'sent', 'failed', 'skipped'].includes(l.status)))
  check('journal : numéros masqués, aucun texte de message', lg.body.data.every((l) => /•/.test(l.recipient) && !('body' in l)) && !lg.texte.includes(phone))
  check('journal filtrable par statut', (await api('GET', '/admin/whatsapp/logs?status=failed', { token: admin })).body.data.every((l) => l.status === 'failed'))
  const toutesReponses = [s0, q1, bad, cd, sl, lg].map((r) => r.texte).join('\n')
  check('le secret du service n’apparaît dans aucune réponse', !toutesReponses.includes(SECRET))
  const stockes = await query('SELECT body, provider_response, error, subject FROM message_logs ORDER BY id DESC LIMIT 200')
  check('ni le secret ni le QR dans message_logs', !JSON.stringify(stockes).includes(SECRET) && !JSON.stringify(stockes).includes(QR_PAYLOAD))
  const sortie = apiTest.sortie()
  check('journaux du serveur : ni secret, ni QR, ni texte des messages', sortie.length > 0 && !sortie.includes(SECRET) && !sortie.includes(QR_PAYLOAD) && !sortie.includes('Compte non connecté') && !sortie.includes('Texte identique'))
  check('journaux du serveur : incidents consignés par code (AUTH_FAILED, UNREACHABLE, TIMEOUT)', /AUTH_FAILED/.test(sortie) && /UNREACHABLE/.test(sortie) && /TIMEOUT/.test(sortie))
  const msgStatus = await api('GET', '/admin/messaging/status', { token: admin })
  check('/messaging/status : fournisseur qr, sans secret ni URL du service', msgStatus.body?.data?.whatsapp?.provider === 'qr' && !msgStatus.texte.includes(SECRET) && !msgStatus.texte.includes('4240'), msgStatus.texte.slice(0, 200))
} finally {
  await execute('DELETE FROM users WHERE email IN (?, ?)', mails).catch(() => {})
  await execute('DELETE m FROM message_logs m WHERE m.recipient LIKE ? OR m.recipient LIKE ?', [`%${phone.slice(-8)}%`, `%${phone2.slice(-8)}%`]).catch(() => {})
  await execute('DELETE a FROM appointments a WHERE a.phone IN (?, ?)', [phone, phone2]).catch(() => {})
  await execute('DELETE FROM booking_requests WHERE phone IN (?, ?)', [phone, phone2]).catch(() => {})
  await execute('DELETE FROM contact_messages WHERE phone = ?', [phone]).catch(() => {})
  await execute('DELETE FROM customers WHERE phone IN (?, ?)', [phone, phone2]).catch(() => {})
  apiTest.stop(); service.close(); meta.close()
  await closePool()
}

console.log(`\n${passed + failed} contrôle(s) : ${passed} réussi(s), ${failed} échec(s)`)
process.exit(failed ? 1 : 0)
