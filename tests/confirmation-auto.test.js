/**
 * Tests de la CONFIRMATION AUTOMATIQUE d'un rendez-vous après paiement de la consultation (Jèko).
 * Règle : paiement confirmé par Jèko (webhook signé) = rendez-vous « Confirmé » sans action de l'administratrice.
 * Aucun argent, aucun appel réel : webhooks signés avec un secret de test, SMS / e-mail pointés vers un port fermé.
 * Lance ses propres API de test (ports 4240 / 4241). Base du `.env` : utilisez une base de TEST.
 *
 *   npm run test:confirmation
 */
import { createHmac } from 'node:crypto'

import { config } from '../src/config/env.js'
import { query, execute, closePool } from '../src/config/database.js'
import { insertAppointment } from '../src/modules/appointments/model.js'
import { startApi } from './lib/start-api.js'

if (config.isProduction) {
  console.error('Refus : ces tests écrivent en base, ils ne tournent jamais avec NODE_ENV=production.')
  process.exit(1)
}

const SECRET = 'secret-de-test-webhook'
let passed = 0
let failed = 0
const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const attendre = (ms) => new Promise((r) => setTimeout(r, ms))

const ENV = { NODE_ENV: 'development', JEKO_MOCK: 'true', JEKO_WEBHOOK_SECRET: SECRET, WHATSAPP_ENABLED: 'false', CONSULTATION_FEE: '5000' }
const API = await startApi(Number(process.env.TEST_CONF_API_PORT || 4240), ENV)
// Messagerie en panne : SMS et e-mail pointent vers un port fermé.
const API_PANNE = await startApi(Number(process.env.TEST_CONF_API_PORT2 || 4241), {
  ...ENV, SMS_ENABLED: 'true', SMS_API_URL: 'http://127.0.0.1:9/sms', SMS_API_TOKEN: 'x', SMS_SENDER_ID: 'BH',
  MAIL_ENABLED: 'true', MAIL_HOST: '127.0.0.1', MAIL_PORT: '9', MAIL_USER: 'x', MAIL_PASSWORD: 'x',
})

async function api(base, method, path, { body, token, headers = {}, raw } = {}) {
  const response = await fetch(`${base.base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  })
  let json = null
  try { json = await response.json() } catch { /* 204 */ }
  return { status: response.status, body: json }
}

const stamp = Number(String(Date.now()).slice(-8))
let compteur = 0
const nouveauTel = () => `07${String(stamp + (compteur += 1)).padStart(8, '0').slice(-8)}`
const telephones = []
const person = (p) => ({ firstName: 'Testeuse', lastName: 'Confirmation', phone: p, email: 'test.conf@example.com' })

const webhook = (base, { reference, statut = 'success', montant = 5000, devise = 'XOF', transaction = `TX-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, signer = true }) => {
  const corps = JSON.stringify({ id: transaction, status: statut, transactionType: 'payment', amount: { amount: montant, currency: devise }, transactionDetails: { reference: `${reference}-abc` } })
  const sig = createHmac('sha256', SECRET).update(corps).digest('hex')
  return api(base, 'POST', '/payments/jeko/webhook', { raw: corps, headers: signer ? { 'Jeko-Signature': sig } : {} })
}

const rdvDe = async (p) => (await query('SELECT * FROM appointments WHERE phone = ?', [p]))
const demandeDe = async (p) => (await query('SELECT * FROM booking_requests WHERE phone = ?', [p]))[0]
const evenements = async (p) => query('SELECT e.kind, e.label FROM appointment_events e JOIN appointments a ON a.id = e.appointment_id WHERE a.phone = ?', [p])
const messages = async (p) => query('SELECT channel, body, status FROM message_logs WHERE recipient LIKE ?', [`%${p.slice(-8)}%`])

const nettoyer = async (p) => {
  for (const { reference } of await query('SELECT reference FROM booking_requests WHERE phone = ?', [p])) {
    await execute('DELETE FROM payment_events WHERE request_reference = ?', [reference]).catch(() => {})
    await execute('DELETE FROM payment_attempts WHERE request_reference = ?', [reference]).catch(() => {})
  }
  await execute('DELETE FROM appointment_events WHERE appointment_id IN (SELECT id FROM appointments WHERE phone = ?)', [p]).catch(() => {})
  await execute('DELETE FROM appointments WHERE phone = ?', [p])
  await execute('DELETE FROM booking_requests WHERE phone = ?', [p])
  await execute('DELETE FROM contact_messages WHERE phone = ?', [p])
  await execute('DELETE FROM message_logs WHERE recipient LIKE ?', [`%${p.slice(-8)}%`]).catch(() => {})
  await execute('DELETE FROM customers WHERE phone = ?', [p])
}

async function main() {
  const login = await api(API, 'POST', '/admin/auth/login', { body: { email: config.admin.email, password: config.admin.password } })
  const token = login.body?.data?.token
  check('connexion admin', Boolean(token))
  const salonAvant = (await api(API, 'GET', '/admin/salon', { token })).body?.data
  const feeAvant = salonAvant?.consultation_fee ?? salonAvant?.settings?.consultation_fee
  await api(API, 'PUT', '/admin/salon', { token, body: { consultation_fee: '5000' } })

  try {
    // Créneaux libres distincts.
    const jours = (await api(API, 'GET', '/availability/days')).body?.data?.days ?? []
    const creneaux = []
    for (const j of jours.filter((x) => x.bookable).slice(0, 4)) {
      const slots = (await api(API, 'GET', `/availability/slots?date=${j.date}`)).body?.data?.slots ?? []
      for (const s of slots.filter((x) => x.available)) creneaux.push({ date: j.date, time: s.time })
    }
    check('au moins 10 créneaux libres pour les scénarios', creneaux.length >= 10, String(creneaux.length))
    let k = 0
    const prochainCreneau = () => creneaux[(k += 1) - 1]

    const creer = async (extra = {}, base = API) => {
      const tel = nouveauTel()
      telephones.push(tel)
      const c = prochainCreneau()
      const r = await api(base, 'POST', '/booking-requests', { body: { customerKind: 'nouvelle', consultation: { mode: 'sur_place', hasLocks: true, date: c.date, time: c.time }, ...person(tel), ...extra } })
      return { tel, c, ref: r.body?.data?.reference, status: r.status, data: r.body?.data }
    }

    section('1. Demande créée, paiement non effectué : aucune confirmation')
    const a = await creer()
    check('demande enregistrée, paiement requis (5 000 FCFA)', a.status === 201 && a.data?.payment?.required === true && a.data?.payment?.amount === 5000, JSON.stringify(a.data?.payment))
    check('aucun rendez-vous confirmé (rien n’existe tant que rien n’est payé)', (await rdvDe(a.tel)).length === 0)
    check('la demande reste « en attente »', (await demandeDe(a.tel))?.status === 'pending' && (await demandeDe(a.tel))?.payment_status !== 'paid')

    section('2. Paiement confirmé par Jèko : rendez-vous automatiquement confirmé')
    const tx = 'TX-CONFIRMATION-1'
    const h = await webhook(API, { reference: a.ref, transaction: tx })
    check('webhook signé « success » → 200', h.status === 200 && h.body?.data?.matched === true)
    await attendre(900)
    const rdv = (await rdvDe(a.tel))[0]
    const dem = await demandeDe(a.tel)
    check('paiement enregistré (paid) + date de paiement', dem?.payment_status === 'paid' && Boolean(dem?.paid_at))
    check('rendez-vous « confirmé » au créneau choisi, sans action admin', rdv?.status === 'confirmed' && String(rdv.appointment_time).slice(0, 5) === a.c.time && String(rdv.appointment_date).slice(0, 10) === a.c.date, JSON.stringify(rdv && [rdv.status, rdv.appointment_date, rdv.appointment_time]))
    check('date et heure de confirmation enregistrées', Boolean(rdv?.confirmed_at))
    check('la demande est « confirmée » aussi', dem?.status === 'confirmed')
    const ev = await evenements(a.tel)
    check('historique : « Confirmé automatiquement après paiement » avec montant et transaction', ev.some((e) => e.kind === 'auto_confirm' && /5 000 FCFA/.test(e.label) && e.label.includes(tx)), JSON.stringify(ev))
    const detail = await api(API, 'GET', `/admin/appointments/${rdv.id}`, { token })
    const pay = detail.body?.data?.request?.payment
    check('dashboard : montant payé, référence de transaction et confirmation automatique visibles', pay?.status === 'paid' && pay?.amount === 5000 && pay?.autoConfirmed === true && pay?.needsReview === false, JSON.stringify(pay))
    const m = await messages(a.tel)
    const sms = m.filter((x) => x.channel === 'sms')
    check('notification : SMS « CONFIRME » avec salon, montant, référence, date, heure et prestation', sms.length === 1 && /Beaute Halal/.test(sms[0].body) && /CONFIRME/.test(sms[0].body) && /Paye 5 000 F/.test(sms[0].body) && sms[0].body.includes(a.ref) && /Consultation/.test(sms[0].body) && sms[0].body.includes(a.c.time), JSON.stringify(sms.map((x) => x.body)))
    check('SMS : sans accent, un seul SMS de 155 caractères au plus', sms.every((x) => !/[^\x20-\x7e]/.test(x.body) && x.body.length <= 155), JSON.stringify(sms.map((x) => x.body.length)))

    // Récapitulatif complet : e-mail, WhatsApp ET SMS, déclenchés en même temps par le paiement (journalisés quel que soit le résultat d'envoi).
    await new Promise((r) => setTimeout(r, 300))
    const recap = await query("SELECT channel, subject, body FROM message_logs WHERE body LIKE ? AND body LIKE '%Montant reçu%'", [`%${a.ref}%`])
    const recapMail = recap.filter((x) => x.channel === 'email')
    const recapWa = recap.filter((x) => x.channel === 'whatsapp')
    check('récapitulatif de paiement : un e-mail ET un message WhatsApp', recapMail.length === 1 && recapWa.length === 1, JSON.stringify(recap.map((x) => x.channel)))
    check('récapitulatif : confirmé, référence, consultation, durée, paiement, règles du salon', recap.every((x) => /confirmé/.test(x.body) && x.body.includes(a.ref) && /Consultation capillaire/.test(x.body) && /30 minutes/.test(x.body) && /5 000 FCFA/.test(x.body) && /Annulations et retards/.test(x.body)), recap[0]?.body?.slice(0, 200))
    check('récapitulatif WhatsApp : mise en forme (gras) ; e-mail : texte simple', /\*Votre rendez-vous\*/.test(recapWa[0]?.body ?? '') && !/\*Votre/.test(recapMail[0]?.body ?? ''))

    section('3. Webhook reçu plusieurs fois : une seule confirmation')
    const avantRejeu = { rdv: (await rdvDe(a.tel)).length, msgs: (await messages(a.tel)).length, ev: (await evenements(a.tel)).filter((e) => e.kind === 'auto_confirm').length, paiements: (await query('SELECT paid_at FROM booking_requests WHERE phone = ?', [a.tel]))[0].paid_at }
    for (let i = 0; i < 3; i += 1) await webhook(API, { reference: a.ref, transaction: tx })
    await attendre(700)
    const apresRejeu = { rdv: (await rdvDe(a.tel)).length, msgs: (await messages(a.tel)).length, ev: (await evenements(a.tel)).filter((e) => e.kind === 'auto_confirm').length, paiements: (await query('SELECT paid_at FROM booking_requests WHERE phone = ?', [a.tel]))[0].paid_at }
    check('rejoué 3 fois : toujours 1 rendez-vous, 1 confirmation, aucun message de plus', apresRejeu.rdv === 1 && apresRejeu.ev === 1 && apresRejeu.msgs === avantRejeu.msgs && avantRejeu.ev === 1, JSON.stringify({ avantRejeu, apresRejeu }))
    check('le paiement n’est pas réenregistré (même date de paiement)', String(avantRejeu.paiements) === String(apresRejeu.paiements))
    check('rejeu en parallèle : toujours une seule confirmation', await (async () => {
      const b = await creer()
      await Promise.all([1, 2, 3, 4].map(() => webhook(API, { reference: b.ref, transaction: 'TX-PARALLELE' })))
      await attendre(900)
      const r = await rdvDe(b.tel)
      return r.length === 1 && r[0].status === 'confirmed' && (await evenements(b.tel)).filter((e) => e.kind === 'auto_confirm').length === 1 && (await messages(b.tel)).filter((x) => x.channel === 'sms').length === 1
    })())

    section('4. Paiement échoué / annulé / expiré : aucune confirmation, nouvelle tentative possible')
    for (const statut of ['failed', 'cancelled', 'expired']) {
      const e = await creer()
      const r = await webhook(API, { reference: e.ref, statut })
      await attendre(300)
      const d = await demandeDe(e.tel)
      check(`« ${statut} » → 200, paiement non réussi`, r.status === 200 && d?.payment_status !== 'paid', d?.payment_status)
      check(`« ${statut} » → aucun rendez-vous confirmé, aucun message de confirmation`, (await rdvDe(e.tel)).every((x) => x.status !== 'confirmed') && (await messages(e.tel)).every((x) => !/CONFIRME/.test(x.body)))
      check(`« ${statut} » → nouvelle tentative de paiement autorisée`, (await api(API, 'POST', '/payments/initiate', { body: { reference: e.ref, method: 'wave' } })).status === 200)
    }

    section('5. Paiement d’un montant ou d’une devise incorrects : aucune confirmation automatique')
    for (const [nom, opts] of [['montant 100 au lieu de 5 000', { montant: 100 }], ['devise EUR', { devise: 'EUR' }]]) {
      const e = await creer()
      await webhook(API, { reference: e.ref, ...opts, transaction: 'TX-ERREUR' })
      await attendre(800)
      const d = await demandeDe(e.tel)
      const r = (await rdvDe(e.tel))[0]
      const ev2 = await evenements(e.tel)
      check(`${nom} : paiement noté mais rendez-vous NON confirmé`, d?.payment_status === 'paid' && r?.status === 'pending' && d?.status === 'pending', JSON.stringify([d?.payment_status, r?.status]))
      check(`${nom} : signalé « à régulariser » dans l’historique`, ev2.some((x) => x.kind === 'payment_review') && !ev2.some((x) => x.kind === 'auto_confirm'))
      check(`${nom} : aucun message « confirmé » à la cliente`, (await messages(e.tel)).every((x) => !/CONFIRME/.test(x.body)))
      const det = await api(API, 'GET', `/admin/appointments/${r.id}`, { token })
      check(`${nom} : le dashboard le voit (needsReview)`, det.body?.data?.request?.payment?.needsReview === true)
    }

    section('6. Notification de paiement non authentifiée : rejet')
    const f = await creer()
    check('sans signature → 401', (await webhook(API, { reference: f.ref, signer: false })).status === 401)
    const faux = JSON.stringify({ status: 'success', reference: `${f.ref}-abc` })
    check('mauvaise signature → 401', (await api(API, 'POST', '/payments/jeko/webhook', { raw: faux, headers: { 'Jeko-Signature': 'ab'.repeat(32) } })).status === 401)
    await attendre(300)
    check('rien n’a changé : ni paiement, ni rendez-vous', (await demandeDe(f.tel))?.payment_status !== 'paid' && (await rdvDe(f.tel)).length === 0)
    check('le navigateur ne peut pas déclarer le paiement réussi (statut public inchangé)', (await api(API, 'GET', `/payments/status/${f.ref}?status=success&paid=1`)).body?.data?.payment?.status !== 'paid')

    section('7. Paiement confirmé alors que le créneau n’est plus disponible : traitement sécurisé')
    const g = await creer()
    // Pendant que la cliente payait, le salon (ou une autre cliente) a pris ce créneau.
    const service = (await query('SELECT id FROM services ORDER BY id LIMIT 1'))[0]
    const pris = []
    const estLibre = async () => ((await api(API, 'GET', `/availability/slots?date=${g.c.date}`)).body?.data?.slots ?? []).find((x) => x.time === g.c.time)?.available
    const prendre = async (n) => {
      const telPris = nouveauTel(); telephones.push(telPris)
      const rdvPris = await insertAppointment({ reference: `ZZ-${stamp}-${n}`, serviceId: service.id, serviceName: 'Rendez-vous déjà pris', date: g.c.date, time: `${g.c.time}:00`.slice(0, 8), durationMinutes: 30, price: 0, currency: 'FCFA', firstName: 'Autre', lastName: 'Cliente', phone: telPris, email: 'autre@example.com', source: 'admin' })
      await execute("UPDATE appointments SET status = 'confirmed', confirmed_at = NOW() WHERE id = ?", [rdvPris.id])
      pris.push(rdvPris.id)
    }
    // On remplit le créneau jusqu'à ce que l'agenda le dise complet, puis une place de plus : la demande de la cliente
    // retient elle-même une place, le créneau doit rester complet même SANS elle.
    for (let n = 0; n < 12 && (await estLibre()); n += 1) await prendre(n)
    await prendre(99)
    check('le créneau est désormais complet pour l’agenda', !(await estLibre()), `${pris.length} rendez-vous insérés`)
    await webhook(API, { reference: g.ref, transaction: 'TX-CRENEAU-PRIS' })
    await attendre(900)
    const dg = await demandeDe(g.tel)
    const rg = await rdvDe(g.tel)
    const evg = await evenements(g.tel)
    check('paiement reçu et enregistré', dg?.payment_status === 'paid')
    check('rendez-vous créé mais NON confirmé, sur un repère technique (pas de double réservation)', rg.length === 1 && rg[0].status === 'pending' && String(rg[0].appointment_time).slice(0, 5) !== g.c.time, JSON.stringify(rg.map((x) => [x.status, x.appointment_time])))
    check('aucune place supplémentaire prise sur le créneau (pas de surréservation)', (await query("SELECT id FROM appointments WHERE appointment_date = ? AND appointment_time = ? AND status NOT IN ('cancelled')", [g.c.date, `${g.c.time}:00`])).length === pris.length)
    check('« à régulariser » dans l’historique + aucune confirmation', evg.some((x) => x.kind === 'payment_review' && /plus disponible/.test(x.label)) && !evg.some((x) => x.kind === 'auto_confirm'))
    check('aucun message « confirmé » à la cliente', (await messages(g.tel)).every((x) => !/CONFIRME/.test(x.body)))
    for (const id of pris) {
      await execute('DELETE FROM appointment_events WHERE appointment_id = ?', [id])
      await execute('DELETE FROM appointments WHERE id = ?', [id])
    }

    section('8. Paiement arrivé après annulation / expiration de la demande')
    const i = await creer()
    await execute("UPDATE booking_requests SET status = 'cancelled' WHERE id = (SELECT id FROM (SELECT id FROM booking_requests WHERE phone = ?) x)", [i.tel])
    await webhook(API, { reference: i.ref, transaction: 'TX-TARDIF' })
    await attendre(900)
    const di = await demandeDe(i.tel)
    const ri = await rdvDe(i.tel)
    check('paiement enregistré mais la demande reste annulée (jamais « confirmée »)', di?.payment_status === 'paid' && di?.status === 'cancelled', JSON.stringify([di?.payment_status, di?.status]))
    check('aucun rendez-vous confirmé ; le créneau n’est pas bloqué', ri.every((x) => x.status !== 'confirmed') && ri.every((x) => String(x.appointment_time).slice(0, 5) !== i.c.time))
    check('signalé « à régulariser » (remboursement ou nouveau créneau)', (await evenements(i.tel)).some((x) => x.kind === 'payment_review' && /annul/.test(x.label)), JSON.stringify(await evenements(i.tel)))
    check('aucun message « confirmé »', (await messages(i.tel)).every((x) => !/CONFIRME/.test(x.body)))

    section('9. Échec d’envoi SMS / e-mail : la confirmation est conservée')
    const j = await creer({}, API_PANNE)
    check('demande créée (API à messagerie en panne)', j.status === 201 && Boolean(j.ref))
    const hj = await webhook(API_PANNE, { reference: j.ref, transaction: 'TX-PANNE' })
    await attendre(1500)
    const rj = (await rdvDe(j.tel))[0]
    check('webhook traité → 200 malgré la panne', hj.status === 200)
    check('rendez-vous confirmé et paiement conservés', rj?.status === 'confirmed' && (await demandeDe(j.tel))?.payment_status === 'paid')
    check('historique : confirmation automatique enregistrée', (await evenements(j.tel)).some((x) => x.kind === 'auto_confirm'))
    const mj = await messages(j.tel)
    check('l’échec d’envoi est journalisé (messagerie), sans effet sur la confirmation', mj.length === 0 || mj.some((x) => x.status !== 'sent'), JSON.stringify(mj.map((x) => [x.channel, x.status])))

    section('10. Cas particulier : consultation par WhatsApp (pas de créneau)')
    const tel = nouveauTel(); telephones.push(tel)
    const w = await api(API, 'POST', '/booking-requests', { body: { customerKind: 'nouvelle', consultation: { mode: 'whatsapp', hasLocks: true }, ...person(tel) } })
    await webhook(API, { reference: w.body?.data?.reference, transaction: 'TX-WA' })
    await attendre(800)
    const rw = await rdvDe(tel)
    check('payée mais sans jour ni heure : pas de rendez-vous confirmé (le salon fixe la date)', (await demandeDe(tel))?.payment_status === 'paid' && rw.every((x) => x.status !== 'confirmed'))
    check('la cliente reçoit l’accusé de paiement, pas un message « confirmé »', (await messages(tel)).every((x) => !/CONFIRME/.test(x.body)))

    section('11. Page « Messages » : seulement les messages du formulaire de contact')
    check('une demande payée n’est plus recopiée dans « Messages »', (await query('SELECT id FROM contact_messages WHERE phone = ?', [a.tel])).length === 0)
    const telMsg = nouveauTel(); telephones.push(telMsg)
    await execute('INSERT INTO contact_messages (name, email, phone, message) VALUES (?, ?, ?, ?)', ['Cliente Contact', 'contact@example.com', telMsg, 'Bonjour, quels sont vos horaires ?'])
    await execute('INSERT INTO contact_messages (name, email, phone, message) VALUES (?, ?, ?, ?)', ['Ancienne Copie', 'copie@example.com', telMsg, 'DEMANDE DE RENDEZ-VOUS DM-TEST01 (site v3)\nBesoin : Resserrage'])
    const liste = (await api(API, 'GET', '/admin/messages?limit=100', { token })).body?.data ?? []
    check('le message du formulaire de contact est listé', liste.some((m) => m.email === 'contact@example.com'))
    check('les anciennes copies de demandes sont masquées (sans être supprimées)', !liste.some((m) => /^DEMANDE DE RENDEZ-VOUS/.test(m.message)) && (await query("SELECT id FROM contact_messages WHERE email = 'copie@example.com'")).length === 1)
    await execute("DELETE FROM contact_messages WHERE phone = ?", [telMsg])
  } finally {
    for (const p of telephones) await nettoyer(p).catch((e) => console.error('nettoyage', e.message))
    if (feeAvant !== undefined) await api(API, 'PUT', '/admin/salon', { token, body: { consultation_fee: String(feeAvant) } }).catch(() => {})
  }
}

try {
  await main()
} catch (error) {
  failed += 1
  failures.push(`Exception : ${error.stack ?? error}`)
  console.error(error)
} finally {
  API.stop()
  API_PANNE.stop()
  await closePool().catch(() => {})
}

console.log(`\n${'═'.repeat(38)}\n  ${passed} test(s) réussi(s), ${failed} échec(s)`)
if (failures.length) { console.log('  Échecs :'); for (const f of failures) console.log(`   • ${f}`) }
console.log('═'.repeat(38))
process.exit(failed ? 1 : 0)
