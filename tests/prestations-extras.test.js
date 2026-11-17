/**
 * Prestations supplémentaires (shampoing…) ajoutées à l'encaissement : prix propre, total, versements, reçu.
 * Nécessite la migration 021 (appliquée sur la base de test).
 */
import { config } from '../src/config/env.js'
import { execute, query, closePool } from '../src/config/database.js'

const BASE = process.env.TEST_API_URL || config.apiUrl
let passed = 0, failed = 0
const check = (l, ok, d = '') => { if (ok) { passed++; console.log(`  ✓ ${l}`) } else { failed++; console.log(`  ✗ ${l}${d ? ` — ${d}` : ''}`) } }
async function api(method, path, { body, token } = {}) {
  const r = await fetch(`${BASE}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}

async function main() {
  const token = (await api('POST', '/admin/auth/login', { body: { email: config.admin.email, password: config.admin.password } })).body?.data?.token
  const serviceId = ((await api('GET', '/admin/services', { token })).body?.data ?? []).find((x) => x.isActive !== false && x.active !== false)?.id
  const jour = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10)
  const phone = `07${String(Date.now()).slice(-8)}`
  const rdv = (await api('POST', '/admin/appointments', { token, body: { firstName: 'Extra', lastName: 'Test', phone, date: jour, time: '11:00', serviceId, force: true } })).body?.data
  check('rendez-vous créé', Boolean(rdv?.id))
  /* ── Rendez-vous au comptoir : même parcours que le site, sans paiement d'avance ── */
  let jourOuvert = null, heure = null
  for (let i = 30; i < 44 && !heure; i += 1) {
    const d = new Date(Date.now() + i * 86400000).toISOString().slice(0, 10)
    const sl = (await api('GET', `/availability/slots?date=${d}&besoin=creation&type=micro`)).body?.data?.slots ?? []
    const libre = sl.find((x) => x.available)
    if (libre) { jourOuvert = d; heure = String(libre.time).slice(0, 5) }
  }
  check('un créneau libre existe pour le test', Boolean(heure))
  const corps = (extra = {}) => ({ firstName: 'Comptoir', lastName: 'Parcours', email: 'comptoir.test@example.com', phone: `07${String(Date.now() + Math.floor(Math.random() * 1000)).slice(-8)}`, customerKind: 'nouvelle', besoin: 'creation', type: 'micro', volume: 'M', longueur: 'Courte', desiredDate: jourOuvert, desiredTime: heure, ...extra })
  const sansToken = await api('POST', '/admin/booking-requests/comptoir', { body: corps() })
  check('comptoir : réservé au personnel connecté', sansToken.status === 401, String(sansToken.status))
  const cpt = await api('POST', '/admin/booking-requests/comptoir', { token, body: corps() })
  check('comptoir : demande créée comme sur le site', cpt.status === 201 && /^DM-/.test(cpt.body?.data?.reference ?? ''), JSON.stringify(cpt.body).slice(0, 200))
  check('comptoir : pas de paiement d’avance (jamais « en attente de paiement »)', cpt.body?.data?.status !== 'awaiting_payment', JSON.stringify(cpt.body?.data?.status))
  const [ligne] = await query('SELECT appointment_id, message FROM booking_requests WHERE reference = ?', [cpt.body?.data?.reference])
  check('comptoir : rendez-vous créé, marqué comptoir', Boolean(ligne?.appointment_id) && /comptoir/.test(ligne?.message ?? ''), JSON.stringify(ligne).slice(0, 160))
  const [rdvAuto] = await query('SELECT status, appointment_date, appointment_time FROM appointments WHERE id = ?', [ligne?.appointment_id])
  check('comptoir : confirmé AUTOMATIQUEMENT au créneau choisi, comme le site', rdvAuto?.status === 'confirmed' && String(rdvAuto.appointment_time).slice(0, 5) === heure, JSON.stringify(rdvAuto))
  const [demandeAuto] = await query('SELECT status FROM booking_requests WHERE reference = ?', [cpt.body?.data?.reference])
  check('comptoir : la demande d’origine passe aussi à « confirmée »', demandeAuto?.status === 'confirmed', JSON.stringify(demandeAuto))
  await new Promise((r) => setTimeout(r, 1500))
  const envois = await query('SELECT DISTINCT channel FROM message_logs WHERE appointment_id = ?', [ligne?.appointment_id])
  const canaux = envois.map((e) => e.channel).sort().join(',')
  check('comptoir confirmé : récapitulatif envoyé par SMS, WhatsApp et e-mail (comme le site)', ['email', 'sms', 'whatsapp'].every((c) => canaux.includes(c)), canaux || 'aucun envoi')
  const estim = await api('POST', '/admin/estimate-tarif', { token, body: { type: 'micro', volume: 'M', formule: 'complet', delai: 'standard', etat: 'bon' } })
  check('aperçu du tarif indicatif calculé par le serveur', estim.status === 200 && estim.body?.data?.total > 0, JSON.stringify(estim.body).slice(0, 160))
  const mauvais = await api('POST', '/admin/booking-requests/comptoir', { token, body: corps({ desiredTime: '03:00' }) })
  check('comptoir : mêmes règles de créneau que le site (422)', mauvais.status === 422, String(mauvais.status))
  const ajouteurs = (await query('SELECT id FROM booking_requests WHERE first_name = ? AND last_name = ?', ['Comptoir', 'Parcours'])).map((r) => r.id)
  const rdvs = (await query('SELECT appointment_id FROM booking_requests WHERE first_name = ? AND last_name = ?', ['Comptoir', 'Parcours'])).map((r) => r.appointment_id).filter(Boolean)
  for (const rid of ajouteurs) await execute('DELETE FROM booking_requests WHERE id = ?', [rid]).catch(() => {})
  for (const aid of rdvs) { await execute('DELETE FROM message_logs WHERE appointment_id = ?', [aid]).catch(() => {}); await execute('DELETE FROM appointments WHERE id = ?', [aid]).catch(() => {}) }

  const id = rdv.id
  const avecPrix = (await api('POST', '/admin/appointments', { token, body: { firstName: 'Prix', lastName: 'Test', phone: `07${String(Date.now() + 5).slice(-8)}`, date: jour, time: '12:00', serviceId, price: 33000, force: true } })).body?.data
  check('rendez-vous du comptoir : prix saisi appliqué', avecPrix?.price === 33000, JSON.stringify(avecPrix?.price))
  if (avecPrix?.id) await execute('DELETE FROM appointments WHERE id = ?', [avecPrix.id]).catch(() => {})
  const ops = (m, p, b) => api(m, `/admin/appointments/${id}${p}`, { token, body: b })

  const avantPresence = await ops('POST', '/extras', { label: 'Shampoing', price: 3000 })
  check('avant la présence : refusé (409)', avantPresence.status === 409)
  await ops('POST', '/arrival', {})
  await ops('PUT', '/price', { price: 40000 })
  const ajout = await ops('POST', '/extras', { label: 'Shampoing', price: 3000 })
  const op = ajout.body?.data
  check('shampoing ajouté', ajout.status === 200 && op?.extras?.length === 1, JSON.stringify(ajout.body).slice(0, 200))
  check('prix de base inchangé, total = base + shampoing', op?.basePrice === 40000 && op?.totals?.total === 43000, JSON.stringify({ b: op?.basePrice, t: op?.totals?.total }))
  check('refus d’un prix nul / d’un nom vide (422)', (await ops('POST', '/extras', { label: 'Shampoing', price: 0 })).status === 422 && (await ops('POST', '/extras', { label: '', price: 500 })).status === 422)
  const corrige = (await ops('PUT', '/price', { price: 42000 })).body?.data
  check('corriger le prix de base garde le shampoing', corrige?.basePrice === 42000 && corrige?.totals?.total === 45000, JSON.stringify({ b: corrige?.basePrice, t: corrige?.totals?.total }))
  const pay = await ops('POST', '/payments', { amount: 45000 })
  check('versement du total (prestation + shampoing)', pay.status === 200 && pay.body?.data?.totals?.status === 'paid', JSON.stringify(pay.body).slice(0, 200))
  const retirerPaye = await ops('DELETE', `/extras/${op.extras[0].id}`)
  check('retrait refusé quand le shampoing est déjà encaissé (422)', retirerPaye.status === 422, String(retirerPaye.status))
  const recu = await ops('POST', '/documents/receipt')
  check('reçu établi', recu.status === 200 || recu.status === 201, JSON.stringify(recu.body).slice(0, 160))
  const [snap] = await query("SELECT snapshot FROM appointment_documents WHERE appointment_id = ? AND kind = 'receipt' ORDER BY id DESC LIMIT 1", [id])
  const s = JSON.parse(typeof snap?.snapshot === 'string' ? snap.snapshot : JSON.stringify(snap?.snapshot ?? {}))
  const pr = s.appointment?.prestations ?? []
  check('reçu : prestation principale + shampoing, chacun avec son prix', pr.length === 2 && pr[0].price === 42000 && pr[1].name === 'Shampoing' && pr[1].price === 3000, JSON.stringify(pr))

  await execute('DELETE FROM ledger_entries WHERE appointment_id = ?', [id]).catch(() => {})
  await execute('DELETE FROM appointment_documents WHERE appointment_id = ?', [id]).catch(() => {})
  await execute('DELETE FROM appointments WHERE id = ?', [id]).catch((e) => console.log(e.message))
  await execute('DELETE FROM customers WHERE phone = ?', [phone]).catch(() => {})
  console.log(`\n${passed} réussis, ${failed} échoués`)
  await closePool()
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
