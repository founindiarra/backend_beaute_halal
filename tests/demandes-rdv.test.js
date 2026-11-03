/**
 * Une demande du site devient un rendez-vous « en attente » ; « Contactée » ; planification.
 * Lancer avec l'API démarrée (npm start). Nettoie ses données.
 */
import { config } from '../src/config/env.js'
import { execute, closePool } from '../src/config/database.js'

const BASE = process.env.TEST_API_URL || config.apiUrl
let passed = 0, failed = 0
const check = (l, ok, d = '') => { if (ok) { passed++; console.log(`  ✓ ${l}`) } else { failed++; console.log(`  ✗ ${l}${d ? ` — ${d}` : ''}`) } }
async function api(method, path, { body, token } = {}) {
  const r = await fetch(`${BASE}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
const phone = `07${String(Date.now()).slice(-8)}`
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
const person = { firstName: 'Testeuse', lastName: 'Rdv', phone, email: 'test.rdv@example.com' }
const demande = () => api('POST', '/booking-requests', { body: { besoin: 'creation', type: 'small', volume: 'M', longueur: 'mi-dos', delai: 'standard', etat: 'bon', desiredDate: tomorrow, ...person } })

async function main() {
  const token = (await api('POST', '/admin/auth/login', { body: { email: config.admin.email, password: config.admin.password } })).body?.data?.token
  const ref1 = (await demande()).body?.data?.reference
  const ref2 = (await demande()).body?.data?.reference
  const ref3 = (await demande()).body?.data?.reference
  const liste = (await api('GET', `/admin/appointments?search=${phone}`, { token })).body?.data ?? []
  const a1 = liste.find((a) => a.reference === ref1)
  check('la demande apparaît dans les rendez-vous, en attente', a1?.status === 'pending' && a1?.source === 'site-v3', JSON.stringify(liste.map((a) => a.reference)))
  check('heure à fixer + détails de la demande', a1?.timeToSet === true && a1?.request?.lockType === 'small')
  const a2 = liste.find((a) => a.reference === ref2)
  check('deux demandes le même jour : pas de conflit', Boolean(a2))

  const c = await api('PATCH', `/admin/appointments/${a1.id}/status`, { token, body: { status: 'contacted' } })
  check('statut Contactée (200)', c.status === 200 && c.body?.data?.status === 'contacted', JSON.stringify(c.body).slice(0, 200))
  const req = (await api('GET', `/admin/booking-requests?search=${ref1}`, { token })).body?.data?.[0]
  check('la demande d’origine suit', req?.status === 'contacted')
  const direct = await api('PATCH', `/admin/appointments/${a1.id}/status`, { token, body: { status: 'confirmed' } })
  check('confirmer sans planifier → 422', direct.status === 422)
  const sansPrix = await api('POST', `/admin/appointments/${a1.id}/plan`, { token, body: { date: tomorrow, time: '10:00' } })
  check('planifier sans prix → 422', sansPrix.status === 422)
  const plan = await api('POST', `/admin/appointments/${a1.id}/plan`, { token, body: { date: tomorrow, time: '10:30', price: 25000 } })
  check('planification (200) → confirmé', plan.status === 200 && plan.body?.data?.appointment?.status === 'confirmed' && Number(plan.body.data.appointment.price) === 25000, JSON.stringify(plan.body).slice(0, 200))
  check('plus « heure à fixer »', plan.body?.data?.appointment?.timeToSet === false)
  check('planifier deux fois → 409', (await api('POST', `/admin/appointments/${a1.id}/plan`, { token, body: { date: tomorrow, time: '11:30', price: 25000 } })).status === 409)
  const conf = (await api('GET', `/admin/operations?status=confirmed&search=${phone}`, { token }))
  check('visible dans Rendez-vous confirmés', (conf.body?.data ?? []).some((x) => x.reference === ref1), String(conf.status))
  const ct = (await api('GET', `/admin/operations?status=contacted&search=${phone}`, { token }))
  check('filtre Contactée accepté', ct.status === 200)
  const rej = await api('PATCH', `/admin/appointments/${a2.id}/status`, { token, body: { status: 'rejected' } })
  check('refus d’une demande (200)', rej.status === 200)
  const a3 = liste.find((a) => a.reference === ref3)
  const sync = await api('PATCH', `/admin/appointments/${a3.id}/status`, { token, body: { status: 'contacted' } })
  check('contacter une autre demande', sync.status === 200)

  // Fin de prestation → la demande passe à « terminée » ; historique des clientes.
  const arr = await api('POST', `/admin/appointments/${a1.id}/arrival`, { token, body: {} })
  // Prix : une demande sans prix (0 FCFA) ne peut pas encaisser tant que le prix n'est pas fixé ; il se fixe depuis le panneau Paiement.
  await execute('UPDATE appointments SET price = 0 WHERE id = ?', [a1.id])
  const sansPrixPaiement = await api('POST', `/admin/appointments/${a1.id}/payments`, { token, body: { amount: 5000 } })
  check('prix à 0 : versement refusé avec un message clair (409)', sansPrixPaiement.status === 409 && /prix/i.test(sansPrixPaiement.body?.error?.message ?? ''), JSON.stringify(sansPrixPaiement.body).slice(0, 200))
  check('prix négatif refusé', (await api('PUT', `/admin/appointments/${a1.id}/price`, { token, body: { price: -1 } })).status === 422)
  const fixe = await api('PUT', `/admin/appointments/${a1.id}/price`, { token, body: { price: 30000 } })
  check('fixer le prix (200)', fixe.status === 200 && fixe.body?.data?.totals?.total === 30000, JSON.stringify(fixe.body).slice(0, 200))
  const vers = await api('POST', `/admin/appointments/${a1.id}/payments`, { token, body: { amount: 10000 } })
  check('versement après fixation du prix (200)', vers.status === 200 && vers.body?.data?.totals?.paid === 10000 && vers.body?.data?.totals?.balance === 20000, JSON.stringify(vers.body?.data?.totals))
  check('prix inférieur à l’encaissé refusé (422)', (await api('PUT', `/admin/appointments/${a1.id}/price`, { token, body: { price: 8000 } })).status === 422)
  check('prix corrigé à la hausse (200)', (await api('PUT', `/admin/appointments/${a1.id}/price`, { token, body: { price: 32000 } })).status === 200)
  check('prix : accès sans jeton refusé', (await api('PUT', `/admin/appointments/${a1.id}/price`, { body: { price: 1000 } })).status === 401)
  const fin = await api('POST', `/admin/appointments/${a1.id}/complete`, { token, body: { notify: false } })
  check('présence puis fin de prestation (200)', arr.status < 300 && fin.status === 200, `${arr.status}/${fin.status}`)
  const reqFin = (await api('GET', `/admin/booking-requests?search=${ref1}`, { token })).body?.data?.[0]
  check('la demande d’origine passe à « terminée »', reqFin?.status === 'completed', reqFin?.status)
  // « Soins capillaires » = consultations capillaires. Les trois demandes ci-dessus sont des demandes de COIFFURE : elles n'y figurent pas.
  const cle = phone.slice(-10)
  const clients0 = await api('GET', `/admin/booking-requests/clients?search=${phone}`, { token })
  check('historique des clientes : une cliente qui n’a demandé que des coiffures est absente', clients0.status === 200 && clients0.body?.data?.length === 0, JSON.stringify(clients0.body).slice(0, 200))
  check('demandes de soin : aucune demande de coiffure', ((await api('GET', `/admin/booking-requests?kind=soin&phoneKey=${cle}`, { token })).body?.data ?? []).length === 0)
  const sesDemandes = await api('GET', `/admin/booking-requests?phoneKey=${cle}`, { token })
  check('toutes les demandes d’une cliente par numéro (3), sans filtre de soin', sesDemandes.body?.data?.length === 3, String(sesDemandes.body?.data?.length))
  // La 3e devient une consultation capillaire (en attente / contactée) : elle apparaît dans les deux onglets.
  await execute("UPDATE booking_requests SET consultation_mode = 'telephone' WHERE reference = ?", [ref3])
  const soins = (await api('GET', `/admin/booking-requests?kind=soin&phoneKey=${cle}`, { token })).body?.data ?? []
  check('kind=soin : seule la consultation capillaire', soins.length === 1 && soins[0].reference === ref3, String(soins.length))
  const cl = (await api('GET', `/admin/booking-requests/clients?search=${phone}`, { token })).body?.data?.[0]
  check('historique : la cliente figure dès qu’elle a pris un rendez-vous de consultation (même non confirmé)', cl?.requests === 1 && cl?.firstName === 'Testeuse' && Boolean(cl?.phone) && cl?.lastMode === 'telephone', JSON.stringify(cl))
  // Une cliente qui prend une consultation (WhatsApp) : elle est listée tout de suite.
  const phone2 = `05${String(Date.now()).slice(-8)}`
  const nouvelle = await api('POST', '/booking-requests', { body: { customerKind: 'ancienne', consultation: { mode: 'whatsapp', hasLocks: true }, firstName: 'Seulement', lastName: 'Consultation', phone: phone2, email: 'consult@example.com' } })
  const ref4 = nouvelle.body?.data?.reference
  const h2 = await api('GET', `/admin/booking-requests/clients?search=${phone2}`, { token })
  check('historique : consultation prise (en attente) → présente', h2.status === 200 && h2.body?.data?.length === 1 && h2.body.data[0].requests === 1, JSON.stringify(h2.body).slice(0, 200))
  check('demandes de soin : elle y figure aussi', ((await api('GET', `/admin/booking-requests?kind=soin&search=${phone2}`, { token })).body?.data ?? []).length === 1)
  if (ref4) {
    await execute('DELETE FROM documents WHERE appointment_id IN (SELECT id FROM appointments WHERE reference = ?)', [ref4]).catch(() => {})
    await execute('DELETE FROM booking_requests WHERE reference = ?', [ref4]).catch(() => {})
    await execute('DELETE FROM appointments WHERE reference = ?', [ref4]).catch(() => {})
    await execute('DELETE FROM customers WHERE phone = ?', [phone2]).catch(() => {})
  }
  check('historique : accès sans jeton refusé', (await api('GET', '/admin/booking-requests/clients')).status === 401)

  await execute("DELETE FROM message_logs WHERE recipient LIKE ?", [`%${phone.slice(-8)}%`]).catch(() => {})
  for (const ref of [ref1, ref2, ref3]) {
    await execute('DELETE FROM documents WHERE appointment_id IN (SELECT id FROM appointments WHERE reference = ?)', [ref]).catch(() => {})
    await execute('DELETE FROM booking_requests WHERE reference = ?', [ref]).catch(() => {})
    await execute('DELETE FROM appointments WHERE reference = ?', [ref]).catch(() => {})
  }
  await execute('DELETE FROM contact_messages WHERE phone = ?', [phone]).catch(() => {})
  await execute('DELETE FROM customers WHERE phone = ?', [phone]).catch(() => {})
  console.log(`\n${passed} réussis, ${failed} échoués`)
  await closePool()
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
