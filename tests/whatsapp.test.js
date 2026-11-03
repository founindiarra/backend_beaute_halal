/**
 * Tests du canal WhatsApp — AUCUN envoi réel : une fausse API Meta écoute en local (port 4200).
 *
 * `npm run test:whatsapp` démarre lui-même une API de test (port 4210) avec WhatsApp activé vers la
 * fausse API Meta, et avec Jèko désactivé (les demandes de nouvelles clientes ne sont donc pas
 * suspendues au paiement). Il utilise la base du `.env` : utilisez une base de TEST.
 * Pour tester une API déjà lancée à la main : TEST_API_URL=http://localhost:4000 npm run test:whatsapp
 */
import { createServer } from 'node:http'

import { config } from '../src/config/env.js'
import { execute, query, closePool } from '../src/config/database.js'
import { startApi, JEKO_OFF } from './lib/start-api.js'
import { construireCorps, numeroWhatsapp } from '../src/lib/whatsapp.js'

const PHONE_ESSAI = `07${String(Date.now()).slice(-8)}`
let BASE = process.env.TEST_API_URL
let apiTest = null
if (!BASE) {
  apiTest = await startApi(Number(process.env.TEST_WA_API_PORT || 4210), {
    ...JEKO_OFF,
    WHATSAPP_ENABLED: 'true',
    ADMIN_TEST_PHONE: PHONE_ESSAI, // seul destinataire d'essai admis
    WHATSAPP_PROVIDER: 'meta', // code historique, conservé tant que Meta n'est pas retiré
    WHATSAPP_PHONE_NUMBER_ID: '111',
    WHATSAPP_ACCESS_TOKEN: 'fake',
    WHATSAPP_GRAPH_URL: 'http://127.0.0.1:4200',
    WHATSAPP_TEMPLATE_REQUEST_RECEIVED: 'demande_recue',
    WHATSAPP_TEMPLATE_REQUEST_CONFIRMED: 'demande_confirmee',
  })
  BASE = apiTest.base
}
let passed = 0
let failed = 0
const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, path, { body, token } = {}) {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await response.json() } catch { /* 204 */ }
  return { status: response.status, body: json }
}

/* Fausse API Meta */
const recus = []
let mode = 'ok'
const meta = createServer((req, res) => {
  let data = ''
  req.on('data', (c) => (data += c))
  req.on('end', () => {
    recus.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(data || '{}') })
    res.setHeader('Content-Type', 'application/json')
    if (mode === 'ko') {
      res.statusCode = 400
      return res.end(JSON.stringify({ error: { message: 'Template name does not exist', code: 132001 } }))
    }
    res.end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.TEST${recus.length}` }] }))
  })
})
await new Promise((r) => meta.listen(4200, '127.0.0.1', r))

const phone = PHONE_ESSAI
const person = { firstName: 'Testeuse', lastName: 'Wa', phone, email: 'test.wa@example.com' }
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
const demande = () => api('POST', '/booking-requests', {
  body: { besoin: 'creation', type: 'small', volume: 'M', longueur: 'mi-dos', delai: 'standard', etat: 'bon', desiredDate: tomorrow, ...person },
})
const journal = () => query("SELECT * FROM message_logs WHERE channel = 'whatsapp' AND recipient LIKE ? ORDER BY id", [`%${phone.slice(-8)}%`])

async function main() {
  section('Format')
  check('numéro local → 225…', numeroWhatsapp('07 12 34 56 78') === '2250712345678')
  check('numéro déjà international conservé, sans +', numeroWhatsapp('+225 07 12 34 56 78') === '2250712345678')
  const corps = construireCorps({ to: '2250712345678', template: 'tpl', language: 'fr', params: ['Awa', 'BH-1'] })
  check('corps modèle', corps.type === 'template' && corps.template.name === 'tpl' && corps.template.components[0].parameters.length === 2 && corps.template.language.code === 'fr')
  check('corps texte', construireCorps({ to: '1', text: 'x' }).text.body === 'x')

  const login = await api('POST', '/admin/auth/login', { body: { email: config.admin.email, password: config.admin.password } })
  const token = login.body?.data?.token
  check('connexion admin', Boolean(token))

  section('Statut')
  const st = await api('GET', '/admin/messaging/status', { token })
  check('statut whatsapp prêt', st.body?.data?.whatsapp?.ready === true, JSON.stringify(st.body?.data?.whatsapp))
  check('jeton jamais renvoyé', !JSON.stringify(st.body).includes('fake'))

  section('Demande reçue → modèle WhatsApp')
  const r = await demande()
  check('demande créée', r.status === 201, JSON.stringify(r.body).slice(0, 150))
  const reference = r.body?.data?.reference
  await wait(1200)
  const m1 = recus.find((x) => x.body.template?.name === 'demande_recue')
  check('Meta a reçu le modèle demande_recue', Boolean(m1))
  check('numéro au format 225 sans +', m1?.body.to === `225${phone}`, m1?.body.to)
  check('URL et jeton corrects', m1?.url === '/v21.0/111/messages' && m1?.auth === 'Bearer fake', `${m1?.url} ${m1?.auth}`)
  check('variables : prénom, référence', m1?.body.template.components[0].parameters.map((p) => p.text).join('|') === `Testeuse|${reference}`)
  let logs = await journal()
  check('journal : envoyé + référence Meta', logs[0]?.status === 'sent' && String(logs[0]?.provider_reference).startsWith('wamid.'), JSON.stringify(logs[0]))

  section('Changement de statut')
  const mine = (await api('GET', `/admin/booking-requests?search=${phone}`, { token })).body?.data?.[0]
  const before = recus.length
  await api('PATCH', `/admin/booking-requests/${mine.id}`, { token, body: { status: 'confirmed' } })
  await wait(1200)
  check('confirmed → modèle demande_confirmee', recus.length === before + 1 && recus.at(-1).body.template.name === 'demande_confirmee')
  await api('PATCH', `/admin/booking-requests/${mine.id}`, { token, body: { status: 'confirmed' } })
  await wait(600)
  check('même statut renvoyé → pas de doublon', recus.length === before + 1)
  await api('PATCH', `/admin/booking-requests/${mine.id}`, { token, body: { status: 'rejected' } })
  await wait(1000)
  logs = await journal()
  check('rejected sans modèle configuré → ignoré, rien envoyé à Meta', recus.length === before + 1 && logs.at(-1)?.status === 'skipped' && /modèle/.test(logs.at(-1)?.error ?? ''), JSON.stringify(logs.at(-1)))

  section('Refus de la cliente')
  await execute('UPDATE customers SET whatsapp_opt_in = 0 WHERE phone = ?', [phone])
  const n = recus.length
  await demande()
  await wait(1200)
  logs = await journal()
  check('cliente ayant refusé : le message lié à sa demande part quand même (notification de rendez-vous)', recus.length === n + 1 && logs.at(-1)?.status === 'sent', JSON.stringify(logs.at(-1)))
  await execute('UPDATE customers SET whatsapp_opt_in = 1 WHERE phone = ?', [phone])

  section('Échec côté Meta')
  mode = 'ko'
  await demande()
  await wait(1200)
  logs = await journal()
  check('erreur Meta → ligne « échec » avec le message', logs.at(-1)?.status === 'failed' && /132001|Template/.test(`${logs.at(-1)?.error}${logs.at(-1)?.provider_response}`), JSON.stringify(logs.at(-1)))
  check('la demande a bien été créée malgré l’échec', (await api('GET', `/admin/booking-requests?search=${phone}`, { token })).body?.data?.length >= 3)
  mode = 'ok'

  section('Route d’essai')
  const t = await api('POST', '/admin/messaging/test-whatsapp', { token, body: { to: phone, template: 'demande_recue', params: ['Test', 'BH-0'] } })
  check('essai avec modèle → sent', t.body?.data?.result?.status === 'sent', JSON.stringify(t.body).slice(0, 200))
  const t2 = await api('POST', '/admin/messaging/test-whatsapp', { token, body: { to: phone, message: 'Bonjour' } })
  check('essai texte libre → sent (fausse API)', t2.body?.data?.result?.status === 'sent' && recus.at(-1).body.type === 'text')
  const t3 = await api('POST', '/admin/messaging/test-whatsapp', { token, body: { to: '0709999999', message: 'Bonjour' } })
  check('essai vers un autre numéro → autorisé (numéro saisi)', t3.body?.data?.result?.status === 'sent', JSON.stringify(t3.body).slice(0, 200))
  check('essai sans jeton → 401', (await api('POST', '/admin/messaging/test-whatsapp', { body: { to: phone } })).status === 401)
  check('canal whatsapp filtrable dans le journal', (await api('GET', '/admin/messaging/logs?channel=whatsapp', { token })).status === 200)
  const stats = await api('GET', '/admin/messaging/stats', { token })
  check('stats : compteur whatsapp', stats.body?.data?.whatsapp >= 3)

  section('Confirmer et planifier : la demande devient un rendez-vous')
  const r5 = await demande()
  const mine5 = (await api('GET', `/admin/booking-requests?search=${r5.body?.data?.reference}`, { token })).body?.data?.[0]
  await wait(900)
  const n5 = recus.length
  const conv0 = await api('POST', `/admin/booking-requests/${mine5.id}/convert`, { token, body: { date: tomorrow, time: '14:30' } })
  check('sans prix → 422 (le salon doit fixer le prix)', conv0.status === 422, String(conv0.status))
  const conv = await api('POST', `/admin/booking-requests/${mine5.id}/convert`, { token, body: { date: tomorrow, time: '14:30', price: 22000 } })
  check('convert → 200', conv.status === 200, JSON.stringify(conv.body).slice(0, 200))
  const appt = conv.body?.data?.appointment
  check('rendez-vous créé et confirmé', appt?.status === 'confirmed' && String(appt?.date).slice(0, 10) === tomorrow && String(appt?.time).slice(0, 5) === '14:30', JSON.stringify(appt).slice(0, 200))
  check('libellé repris de la demande, prix = celui fixé par le salon', appt?.service?.name === 'Installation de locks — Small Locks' && Number(appt?.price) === 22000, JSON.stringify([appt?.service, appt?.price]))
  check('demande liée : confirmée + appointmentId', conv.body?.data?.request?.status === 'confirmed' && conv.body?.data?.request?.appointmentId === appt?.id)
  const lu = await api('GET', `/admin/appointments/${appt?.id}`, { token })
  check('visible dans /admin/appointments', lu.status === 200 && lu.body?.data?.status === 'confirmed')
  const op = await api('GET', `/admin/appointments/${appt?.id}/operation`, { token })
  check('entre dans le suivi (fiche opération)', op.status === 200, String(op.status))
  await wait(1200)
  const last = recus.at(-1)
  check('WhatsApp : le prix convenu (22 000 FCFA) est dans les variables', last?.body?.template?.components?.[0]?.parameters?.map((p) => p.text).includes('22 000 FCFA'), JSON.stringify(last?.body?.template?.components))
  check('WhatsApp : modèle demande_confirmee avec jour et heure', recus.length === n5 + 1 && last.body.template.name === 'demande_confirmee' && last.body.template.components[0].parameters.map((p) => p.text).slice(1, 3).join('|') === `${tomorrow.slice(8, 10).replace(/^0/, '')} ${['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'][Number(tomorrow.slice(5, 7)) - 1]}|14:30`, JSON.stringify(last?.body?.template?.components))
  check('deuxième conversion → 409', (await api('POST', `/admin/booking-requests/${mine5.id}/convert`, { token, body: { date: tomorrow, time: '15:00', price: 15000 } })).status === 409)
  const r6 = await demande()
  const mine6 = (await api('GET', `/admin/booking-requests?search=${r6.body?.data?.reference}`, { token })).body?.data?.[0]
  await api('PATCH', `/admin/booking-requests/${mine6.id}`, { token, body: { status: 'rejected' } })
  check('demande déclinée → 422', (await api('POST', `/admin/booking-requests/${mine6.id}/convert`, { token, body: { date: tomorrow, time: '15:00', price: 15000 } })).status === 422)
  check('heure invalide → 422', (await api('POST', `/admin/booking-requests/${mine6.id}/convert`, { token, body: { date: tomorrow, time: '2pm' } })).status === 422)
  check('sans jeton → 401', (await api('POST', `/admin/booking-requests/${mine6.id}/convert`, { body: { date: tomorrow, time: '15:00' } })).status === 401)
  const pubServices = JSON.stringify((await api('GET', '/services')).body)
  check('la prestation technique reste invisible du public', !/prestation-sur-mesure-site/.test(pubServices))
  const prix = await api('POST', `/admin/booking-requests/${(await api('GET', `/admin/booking-requests?search=${phone}`, { token })).body.data.find((x) => x.status === 'pending')?.id}/convert`, { token, body: { date: tomorrow, time: '10:00', price: 18000, durationMinutes: 240 } })
  check('prix et durée choisis par le salon', Number(prix.body?.data?.appointment?.price) === 18000, JSON.stringify(prix.body).slice(0, 160))

  section('Nettoyage')
  await execute("DELETE FROM message_logs WHERE channel = 'whatsapp' AND recipient LIKE ?", [`%${phone.slice(-8)}%`])
  await execute('DELETE FROM appointment_documents WHERE appointment_id IN (SELECT id FROM appointments WHERE phone = ?)', [phone]).catch(() => {})
  await execute('DELETE FROM appointments WHERE phone = ?', [phone])
  await execute('DELETE FROM booking_requests WHERE phone = ?', [phone])
  await execute("DELETE FROM contact_messages WHERE email = 'test.wa@example.com'")
  await execute('DELETE FROM customers WHERE phone = ?', [phone])
}

try { await main() } catch (e) { failed += 1; failures.push(`Exception : ${e.message}`); console.error(e) }
meta.close()
await closePool().catch(() => {})
apiTest?.stop()
console.log(`\n══════════════════════════════════════\n  ${passed} test(s) réussi(s), ${failed} échec(s)`)
failures.forEach((f) => console.log(`   • ${f}`))
process.exit(failed ? 1 : 0)
