/**
 * Tests du paiement de la consultation (nouvelles clientes) — Jèko en MODE SIMULATION : aucun argent, aucun appel réel.
 * Lance sa propre API de test (port 4220). Base du `.env` : utilisez une base de TEST.
 *
 *   npm run test:paiement
 */
import { createHmac } from 'node:crypto'

import { config } from '../src/config/env.js'
import { query, execute, closePool } from '../src/config/database.js'
import { JEKO_OFF, startApi } from './lib/start-api.js'

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

const API = await startApi(Number(process.env.TEST_PAY_API_PORT || 4220), {
  NODE_ENV: 'development',
  JEKO_MOCK: 'true',
  JEKO_WEBHOOK_SECRET: SECRET,
  WHATSAPP_ENABLED: 'false',
  CONSULTATION_FEE: '5000',
})

async function api(method, path, { body, token, headers = {}, raw } = {}) {
  const response = await fetch(`${API.base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  })
  let json = null
  try { json = await response.json() } catch { /* 204 */ }
  return { status: response.status, body: json }
}

const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
const stamp = String(Date.now()).slice(-8)
const phone = `07${stamp}`
const phone2 = `05${stamp}`
const person = (p) => ({ firstName: 'Testeuse', lastName: 'Paiement', phone: p, email: 'test.pay@example.com' })
const demande = (p, extra = {}) =>
  api('POST', '/booking-requests', {
    body: { besoin: 'creation', type: 'small', volume: 'M', longueur: 'mi-dos', desiredDate: tomorrow, customerKind: 'nouvelle', consultation: { mode: 'ignoree' }, ...person(p), ...extra },
  })
const visibleDuSalon = async (p) => ({
  messages: (await query('SELECT id FROM booking_requests WHERE phone = ? AND awaiting_payment = 0', [p])).length,
  clientes: (await query('SELECT id FROM customers WHERE phone = ?', [p])).length,
})
const nettoyer = async (p) => {
  for (const { reference } of await query('SELECT reference FROM booking_requests WHERE phone = ?', [p])) {
    await execute('DELETE FROM payment_events WHERE request_reference = ?', [reference]).catch(() => {})
    await execute('DELETE FROM payment_attempts WHERE request_reference = ?', [reference]).catch(() => {})
  }
  await execute('DELETE FROM appointments WHERE phone = ?', [p])
  await execute('DELETE FROM booking_requests WHERE phone = ?', [p])
  await execute('DELETE FROM contact_messages WHERE phone = ?', [p])
  await execute('DELETE FROM message_logs WHERE recipient LIKE ?', [`%${p.slice(-8)}%`])
  await execute('DELETE FROM customers WHERE phone = ?', [p])
}

async function main() {
  const login = await api('POST', '/admin/auth/login', { body: { email: config.admin.email, password: config.admin.password } })
  const token = login.body?.data?.token
  check('connexion admin', Boolean(token))
  const salonAvant = (await api('GET', '/admin/salon', { token })).body?.data
  const feeAvant = salonAvant?.consultation_fee ?? salonAvant?.settings?.consultation_fee
  // Le réglage du salon (en base) l'emporte sur l'environnement : on le fixe pour ce test, puis on le remet.
  await api('PUT', '/admin/salon', { token, body: { consultation_fee: '5000' } })

  try {
    section('Nouvelle cliente : la demande attend son paiement')
    const r = await demande(phone)
    check('201', r.status === 201, JSON.stringify(r.body).slice(0, 200))
    const ref = r.body?.data?.reference
    check('paiement requis, montant = 5 000 FCFA, statut en attente', r.body?.data?.payment?.required === true && r.body?.data?.payment?.amount === 5000 && r.body?.data?.payment?.status === 'pending', JSON.stringify(r.body?.data?.payment))
    check('message : réglez la consultation', /consultation/i.test(r.body?.data?.message ?? ''))
    const avant = await visibleDuSalon(phone)
    check('rien n’existe encore pour le salon (ni message, ni fiche cliente)', avant.messages === 0 && avant.clientes === 0, JSON.stringify(avant))
    const listeAdmin = await api('GET', `/admin/booking-requests?search=${phone}`, { token })
    check('la demande n’apparaît pas dans la liste admin', listeAdmin.body?.data?.length === 0, String(listeAdmin.body?.data?.length))

    section('Initiation du paiement (simulation)')
    check('moyen de paiement inconnu → 422', (await api('POST', '/payments/initiate', { body: { reference: ref, method: 'cheque' } })).status === 422)
    check('référence inconnue → 404', (await api('POST', '/payments/initiate', { body: { reference: 'DM-ZZZZZZ', method: 'wave' } })).status === 404)
    const init = await api('POST', '/payments/initiate', { body: { reference: ref, method: 'wave' } })
    check('initiation → 200 simulée', init.status === 200 && init.body?.data?.simulated === true, JSON.stringify(init.body).slice(0, 200))
    check('redirection vers la page de retour du site', /\/paiement\/DM-/.test(init.body?.data?.redirectUrl ?? ''))
    const st = await api('GET', `/payments/status/${ref}`)
    check('statut → paid', st.body?.data?.payment?.status === 'paid' && st.body?.data?.payment?.required === false, JSON.stringify(st.body?.data?.payment))
    const apres = await visibleDuSalon(phone)
    check('la demande est maintenant visible : message + fiche cliente', apres.messages === 1 && apres.clientes === 1, JSON.stringify(apres))
    const listeApres = await api('GET', `/admin/booking-requests?search=${phone}`, { token })
    check('… et dans la liste admin, payée', listeApres.body?.data?.length === 1 && listeApres.body.data[0].payment?.status === 'paid', JSON.stringify(listeApres.body?.data?.[0]?.payment))
    await new Promise((r) => setTimeout(r, 800))
    const jour = Number(tomorrow.slice(8, 10))
    const corpsMsg = await query("SELECT body FROM message_logs WHERE recipient LIKE ? AND body LIKE '%paiement de%recu%'", [`%${phone.slice(-8)}%`])
    const sms = await query("SELECT body FROM message_logs WHERE channel = 'sms' AND recipient LIKE ?", [`%${phone.slice(-8)}%`])
    check('aucun message ne dit plus que le salon doit « fixer le jour et l heure »', (await query("SELECT body FROM message_logs WHERE recipient LIKE ?", [`%${phone.slice(-8)}%`])).every((m) => !/fixer le jour/.test(m.body)))
    check('SMS : un seul par événement, sans accent, détaillé (≤ 480 caractères)', sms.length === 1 && !/[^\x20-\x7e]/.test(sms[0].body) && sms[0].body.length <= 480, JSON.stringify(sms.map((m) => [m.body.length])))
    check('message « paiement reçu » (aucune heure choisie, donc pas de confirmation) : annonce le paiement, ne promet pas de rendez-vous confirmé', corpsMsg.length >= 1 && corpsMsg.every((m) => /5 000 FCFA/.test(m.body) && !/CONFIRME/.test(m.body)), JSON.stringify(corpsMsg.map((m) => m.body)).slice(0, 220))
    check('rendez-vous « en attente » créé', (await query('SELECT id FROM appointments WHERE phone = ?', [phone])).length === 1)
    const suivi = await api('GET', `/admin/jeko/payments?search=${ref}`, { token })
    check('la rubrique « Paiements Jèko » voit la tentative : simulée, payée, moyen wave', suivi.body?.data?.length === 1 && suivi.body.data[0].simulated === true && suivi.body.data[0].status === 'success' && suivi.body.data[0].method === 'wave', JSON.stringify(suivi.body?.data))
    check('2e initiation → 422 (déjà payée)', (await api('POST', '/payments/initiate', { body: { reference: ref, method: 'wave' } })).status === 422)

    section('Cliente déjà venue : elle paie aussi (tout le monde règle la consultation)')
    const r2 = await demande(phone, { customerKind: 'ancienne' })
    check('201 avec paiement requis, 5 000 FCFA', r2.status === 201 && r2.body?.data?.payment?.required === true && r2.body?.data?.payment?.amount === 5000, JSON.stringify(r2.body?.data?.payment))
    check('invisible du salon tant qu’elle n’a pas payé', (await visibleDuSalon(phone)).messages === 1)
    const r2init = await api('POST', '/payments/initiate', { body: { reference: r2.body?.data?.reference, method: 'wave' } })
    check('paiement simulé → 200', r2init.status === 200 && r2init.body?.data?.simulated === true)
    check('payée : la demande existe pour le salon (2 messages)', (await visibleDuSalon(phone)).messages === 2)
    check('statut public : l’état du paiement et « paiement en ligne disponible »', (await api('GET', `/payments/status/${r2.body?.data?.reference}`)).body?.data?.payment?.available === true)

    section('Webhook : signature obligatoire, rejeu sans effet')
    const r3 = await demande(phone2)
    const ref3 = r3.body?.data?.reference
    check('autre nouvelle cliente : paiement requis', r3.body?.data?.payment?.required === true)
    const corps = JSON.stringify({ status: 'success', reference: `${ref3}-abc` })
    const sig = createHmac('sha256', SECRET).update(corps).digest('hex')
    check('sans signature → 401', (await api('POST', '/payments/jeko/webhook', { raw: corps })).status === 401)
    check('mauvaise signature → 401', (await api('POST', '/payments/jeko/webhook', { raw: corps, headers: { 'Jeko-Signature': 'ab'.repeat(32) } })).status === 401)
    check('toujours en attente après les refus', (await visibleDuSalon(phone2)).messages === 0)
    const echec = JSON.stringify({ status: 'failed', reference: `${ref3}-abc` })
    const hook0 = await api('POST', '/payments/jeko/webhook', { raw: echec, headers: { 'Jeko-Signature': createHmac('sha256', SECRET).update(echec).digest('hex') } })
    check('webhook « échec » signé → 200', hook0.status === 200)
    check('statut → failed, toujours invisible du salon', (await api('GET', `/payments/status/${ref3}`)).body?.data?.payment?.status === 'failed' && (await visibleDuSalon(phone2)).messages === 0)
    const hook1 = await api('POST', '/payments/jeko/webhook', { raw: corps, headers: { 'Jeko-Signature': sig } })
    check('webhook « succès » signé → 200', hook1.status === 200 && hook1.body?.data?.matched === true)
    check('la demande est finalisée', (await visibleDuSalon(phone2)).messages === 1)
    await api('POST', '/payments/jeko/webhook', { raw: corps, headers: { 'Jeko-Signature': sig } })
    const rejoue = await visibleDuSalon(phone2)
    check('webhook rejoué → pas de doublon', rejoue.messages === 1 && rejoue.clientes === 1, JSON.stringify(rejoue))
    const inconnue = JSON.stringify({ status: 'success', reference: 'DM-ZZZZZZ-abc' })
    const hook2 = await api('POST', '/payments/jeko/webhook', { raw: inconnue, headers: { 'Jeko-Signature': createHmac('sha256', SECRET).update(inconnue).digest('hex') } })
    check('référence inconnue → 200 sans correspondance', hook2.status === 200 && hook2.body?.data?.matched === false)

    section('Consultation en rendez-vous : le parcours s’arrête au paiement')
    const jours = (await api('GET', '/availability/days')).body?.data?.days ?? []
    const jourOk = jours.find((j) => j.bookable)
    const creneaux = (await api('GET', `/availability/slots?date=${jourOk?.date}`)).body?.data?.slots ?? []
    const heureOk = creneaux.find((c) => c.available)?.time
    check('un jour et un créneau libres existent pour le test', Boolean(jourOk && heureOk), `${jourOk?.date} ${heureOk}`)
    const phoneS = `06${stamp}`
    const soloBody = { customerKind: 'ancienne', consultation: { mode: 'sur_place', hasLocks: true, date: jourOk?.date, time: heureOk }, ...person(phoneS) }
    const sansHeure = await api('POST', '/booking-requests', { body: { ...soloBody, consultation: { mode: 'sur_place', hasLocks: true, date: jourOk?.date } } })
    check('consultation sur place sans heure → 422', sansHeure.status === 422, String(sansHeure.status))
    const sansBesoin = await api('POST', '/booking-requests', { body: { ...person(phoneS), customerKind: 'nouvelle', consultation: { mode: 'ignoree' }, desiredDate: tomorrow } })
    check('consultation ignorée SANS besoin ni type → 422 (le parcours complet reste obligatoire)', sansBesoin.status === 422, String(sansBesoin.status))
    const solo = await api('POST', '/booking-requests', { body: { ...soloBody, besoin: 'resserrage', type: 'micro', volume: 'XL', desiredDate: tomorrow } })
    const sd = solo.body?.data
    check('201 sans besoin/type : seul le créneau compte (le reste est ignoré)', solo.status === 201 && sd?.consultationOnly === true && sd?.consultation?.date === jourOk?.date && sd?.consultation?.time === heureOk && sd?.consultation?.hasLocks === true, JSON.stringify(sd).slice(0, 300))
    check('paiement requis : 5 000 FCFA, en attente', sd?.payment?.required === true && sd?.payment?.amount === 5000 && sd?.payment?.status === 'pending')
    check('rien n’existe encore pour le salon', (await visibleDuSalon(phoneS)).messages === 0 && (await query('SELECT id FROM appointments WHERE phone = ?', [phoneS])).length === 0)
    const [brS] = await query('SELECT besoin, lock_type, volume, desired_date FROM booking_requests WHERE phone = ?', [phoneS])
    check('le serveur a ignoré besoin/type/volume envoyés en trop', brS && brS.lock_type === null && brS.volume === null)
    const pS = await api('POST', '/payments/initiate', { body: { reference: sd?.reference, method: 'orange' } })
    check('paiement simulé → 200', pS.status === 200 && pS.body?.data?.simulated === true)
    const apptS = await query('SELECT service_name, appointment_date, appointment_time, price, status FROM appointments WHERE phone = ?', [phoneS])
    check('payé : le rendez-vous « Consultation capillaire » est CONFIRMÉ automatiquement au créneau choisi', apptS.length === 1 && apptS[0].service_name === 'Consultation capillaire' && String(apptS[0].appointment_time).slice(0, 5) === heureOk && Number(apptS[0].price) === 5000 && apptS[0].status === 'confirmed', JSON.stringify(apptS))
    const msgS = (await query('SELECT message FROM booking_requests WHERE phone = ?', [phoneS]))[0]?.message ?? ''
    check('le message au salon dit « consultation seule » et ne parle ni de type ni de volume', /CONSULTATION CAPILLAIRE SEULE/.test(msgS) && !/Type de locks|Volume/.test(msgS), msgS.slice(0, 200))
    const stS = await api('GET', `/payments/status/${sd?.reference}`)
    check('statut public : payé, consultation seule, avec locks (pour la page de paiement)', stS.body?.data?.payment?.status === 'paid' && stS.body?.data?.consultationOnly === true && stS.body?.data?.consultation?.hasLocks === true)
    await nettoyer(phoneS)
    await execute('DELETE FROM appointments WHERE phone = ?', [phoneS])

    section('Consultation PUIS prestation : un seul paiement de 5 000 FCFA, la prestation un autre jour')
    const jourService = jours.find((j) => j.bookable && j.date > jourOk?.date)
    check('un second jour libre existe pour la prestation', Boolean(jourService), jourService?.date)
    const phoneP = `04${stamp}`
    const avecBody = {
      ...person(phoneP), customerKind: 'nouvelle',
      consultation: { mode: 'sur_place', hasLocks: false, date: jourOk?.date, time: heureOk },
      avecPrestation: true, besoin: 'creation', type: 'micro', methode: 'twist', volume: 'M', longueur: 'Moyenne',
      serviceDate: jourService?.date,
    }
    // Règle actuelle : la prestation peut avoir lieu le jour de la consultation, à une autre heure ; jamais à la même heure, jamais avant.
    const memeHeure = await api('POST', '/booking-requests', { body: { ...avecBody, serviceDate: jourOk?.date, serviceTime: heureOk } })
    check('prestation le même jour À LA MÊME HEURE que la consultation → 422', memeHeure.status === 422, String(memeHeure.status))
    const veille = new Date(new Date(`${jourOk?.date}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10)
    const avantConsult = await api('POST', '/booking-requests', { body: { ...avecBody, serviceDate: veille } })
    check('prestation AVANT la consultation → 422', avantConsult.status === 422, String(avantConsult.status))
    const sansService = await api('POST', '/booking-requests', { body: { ...avecBody, serviceDate: undefined } })
    check('prestation demandée sans jour → 422', sansService.status === 422, String(sansService.status))
    const sansType = await api('POST', '/booking-requests', { body: { ...avecBody, type: undefined } })
    check('prestation demandée sans type → 422', sansType.status === 422, String(sansType.status))
    const avec = await api('POST', '/booking-requests', { body: avecBody })
    const ad = avec.body?.data
    check('201 : consultation + prestation, 5 000 FCFA à payer', avec.status === 201 && ad?.consultationOnly === true && ad?.payment?.required === true && ad?.payment?.amount === 5000, `${avec.status} ${JSON.stringify(ad).slice(0, 250)}`)
    const [brP] = await query('SELECT lock_type, methode, volume, longueur, desired_date, consultation_date, service_date FROM booking_requests WHERE phone = ?', [phoneP])
    check('la prestation souhaitée est conservée (type, méthode, volume, longueur)', brP?.lock_type === 'micro' && brP?.methode === 'twist' && brP?.volume === 'M' && brP?.longueur === 'Moyenne', JSON.stringify(brP))
    check('le jour de prestation souhaité est enregistré (colonne dédiée), distinct de la consultation', Boolean(brP?.service_date) && String(brP.service_date instanceof Date ? brP.service_date.toISOString() : brP.service_date).slice(0, 10) === jourService.date, JSON.stringify(brP))
    const msgP = (await query('SELECT message FROM booking_requests WHERE phone = ?', [phoneP]))[0]?.message ?? ''
    check('le message au salon décrit la consultation ET la prestation souhaitée', /CONSULTATION CAPILLAIRE, puis PRESTATION/.test(msgP) && /Micro-Locks/.test(msgP) && /Méthode : /.test(msgP) && new RegExp(`Prestation souhaitée le : ${jourService.date.split('-').reverse().join('/')}`).test(msgP), msgP.slice(0, 400))
    await api('POST', '/payments/initiate', { body: { reference: ad?.reference, method: 'orange' } })
    const apptP = await query('SELECT service_name, appointment_date, status FROM appointments WHERE phone = ?', [phoneP])
    check('payé : le rendez-vous est la consultation, au créneau choisi (pas à la date de prestation)', apptP.length === 1 && apptP[0].service_name === 'Consultation capillaire' && String(apptP[0].appointment_date).slice(0, 10) !== jourService.date && apptP[0].status === 'confirmed', JSON.stringify(apptP))
    await nettoyer(phoneP)
    await execute('DELETE FROM appointments WHERE phone = ?', [phoneP])

    for (const mode of ['telephone', 'whatsapp']) {
      const phoneT = `${mode === 'telephone' ? '02' : '03'}${stamp}`
      const t = await api('POST', '/booking-requests', { body: { ...person(phoneT), customerKind: 'nouvelle', consultation: { mode, hasLocks: false } } })
      const td = t.body?.data
      check(`consultation par ${mode} : même parcours court, sans jour ni besoin → 201 à payer`, t.status === 201 && td?.consultationOnly === true && td?.payment?.required === true && td?.payment?.amount === 5000 && !td?.consultation?.date, `${t.status} ${JSON.stringify(td).slice(0, 200)}`)
      const tp = await api('POST', '/payments/initiate', { body: { reference: td?.reference, method: 'wave' } })
      check(`${mode} : paiement simulé → 200`, tp.status === 200)
      const msgT = (await query('SELECT message FROM booking_requests WHERE phone = ?', [phoneT]))[0]?.message ?? ''
      check(`${mode} : le salon est prévenu de recontacter la cliente (aucun créneau)`, /CONSULTATION CAPILLAIRE SEULE/.test(msgT) && /recontacter/.test(msgT) && (await query('SELECT id FROM appointments WHERE phone = ?', [phoneT])).length === 0, msgT.slice(0, 220))
      await nettoyer(phoneT)
    }

    section('Paiement en ligne indisponible (Jèko non configuré) : la page s’affiche, rien n’est confirmé')
    const API2 = await startApi(4221, { ...JEKO_OFF, CONSULTATION_FEE: '5000', WHATSAPP_ENABLED: 'false' })
    try {
      const phoneU = `08${stamp}`
      const rU = await (await fetch(`${API2.base}/api/booking-requests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ besoin: 'creation', type: 'small', volume: 'M', longueur: 'mi-dos', desiredDate: tomorrow, customerKind: 'ancienne', consultation: { mode: 'ignoree' }, ...person(phoneU) }) })).json()
      check('201 : paiement requis (5 000) mais « indisponible »', rU?.data?.payment?.required === true && rU?.data?.payment?.available === false && rU?.data?.payment?.amount === 5000, JSON.stringify(rU?.data?.payment))
      const initU = await fetch(`${API2.base}/api/payments/initiate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference: rU?.data?.reference, method: 'wave' }) })
      check('initiation → 503 (pas d’encaissement possible)', initU.status === 503, String(initU.status))
      const stU = await (await fetch(`${API2.base}/api/payments/status/${rU?.data?.reference}`)).json()
      check('statut public : en attente, paiement indisponible', stU?.data?.payment?.status === 'pending' && stU?.data?.payment?.available === false)
      check('demande NON confirmée : ni message, ni fiche, ni rendez-vous', (await visibleDuSalon(phoneU)).messages === 0 && (await query('SELECT id FROM appointments WHERE phone = ?', [phoneU])).length === 0)
      await nettoyer(phoneU)
    } finally {
      API2.stop()
    }

    section('Prix de la consultation réglable (paramètres du salon)')
    const bad = await api('PUT', '/admin/salon', { token, body: { consultation_fee: 'abc' } })
    check('montant invalide → 422', bad.status === 422, String(bad.status))
    const neg = await api('PUT', '/admin/salon', { token, body: { consultation_fee: '-5' } })
    check('montant négatif → 422', neg.status === 422, String(neg.status))
    const ok = await api('PUT', '/admin/salon', { token, body: { consultation_fee: '7500' } })
    check('montant 7 500 enregistré', ok.status === 200, JSON.stringify(ok.body).slice(0, 200))
    const phone3 = `01${stamp}`
    const r4 = await demande(phone3)
    check('une nouvelle cliente doit alors 7 500 FCFA', r4.body?.data?.payment?.amount === 7500, JSON.stringify(r4.body?.data?.payment))
    await nettoyer(phone3)
    await api('PUT', '/admin/salon', { token, body: { consultation_fee: '0' } })
    const phone4 = `09${stamp}`
    const r5 = await demande(phone4)
    check('montant 0 → consultation gratuite, aucune attente de paiement', r5.status === 201 && r5.body?.data?.payment?.required === false, JSON.stringify(r5.body?.data?.payment))
    await nettoyer(phone4)
  } finally {
    // Remise du réglage d'origine, puis nettoyage des données de test.
    await api('PUT', '/admin/salon', { token, body: { consultation_fee: String(feeAvant ?? '5000') } }).catch(() => {})
    for (const p of [phone, phone2]) await nettoyer(p)
  }
}

try { await main() } catch (e) { failed += 1; failures.push(`Exception : ${e.message}`); console.error(e) }
console.log('\n══════════════════════════════════════')
console.log(`  ${passed} test(s) réussi(s), ${failed} échec(s)`)
if (failures.length) { console.log('\n  Échecs :'); failures.forEach((f) => console.log(`   • ${f}`)) }
console.log('══════════════════════════════════════\n')
await closePool().catch(() => {})
API.stop()
process.exit(failed ? 1 : 0)
