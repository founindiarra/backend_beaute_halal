/**
 * Places par jour (type de locks / coiffure), e-mail facultatif, prestation le jour de la consultation.
 * Lancer avec l'API démarrée. Remet les quotas d'origine et nettoie ses données.
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
const phone = (n) => `07${String(Date.now() + n).slice(-8)}`
const refs = []
const phones = []

async function main() {
  const token = (await api('POST', '/admin/auth/login', { body: { email: config.admin.email, password: config.admin.password } })).body?.data?.token
  const catalogue = (await api('GET', '/admin/tarifs', { token })).body?.data
  const quotasAvant = catalogue.quotas ?? { types: {}, coiffures: {} }
  const regler = (quotas) => api('PUT', '/admin/tarifs', { token, body: { ...catalogue, quotas } })

  // Un jour ouvert avec 14:00 libre, loin devant (pas de dépendance à l'heure courante).
  let jour = null
  for (let i = 25; i < 50 && !jour; i += 1) {
    const d = new Date(Date.now() + i * 86400000).toISOString().slice(0, 10)
    const s = (await api('GET', `/availability/slots?date=${d}`)).body?.data?.slots ?? []
    if (s.some((x) => x.time === '14:00' && x.available) && s.some((x) => x.time === '10:00' && x.available) && s.some((x) => x.time === '14:30' && x.available)) jour = d
  }
  check('un jour ouvert existe', Boolean(jour))
  const demande = async (extra = {}) => {
    const p = phone(phones.length + 1); phones.push(p)
    const r = await api('POST', '/booking-requests', { body: { besoin: 'creation', type: 'small', volume: 'M', longueur: 'mi-dos', delai: 'standard', etat: 'bon', desiredDate: jour, firstName: 'Quota', lastName: 'Test', phone: p, email: 'quota.test@example.com', ...extra } })
    if (r.body?.data?.reference) refs.push(r.body.data.reference)
    return r
  }

  /* ── Quota par type ── */
  check('réglage du quota (small = 1)', (await regler({ types: { small: 1 }, coiffures: {} })).status === 200)
  const avant = (await api('GET', `/availability/days?from=${jour}&to=${jour}&type=small`)).body?.data?.days?.[0]
  check('avant : jour ouvert, 1 place', avant?.bookable === true && avant?.placesLeft === 1, JSON.stringify(avant))
  const r1 = await demande()
  check('1re demande small acceptée', r1.status === 201, JSON.stringify(r1.body).slice(0, 160))
  const apres = (await api('GET', `/availability/days?from=${jour}&to=${jour}&type=small`)).body?.data?.days?.[0]
  check('quota atteint : jour fermé pour small', apres?.bookable === false && apres?.reason === 'quota_full', JSON.stringify(apres))
  const autreType = (await api('GET', `/availability/days?from=${jour}&to=${jour}&type=micro`)).body?.data?.days?.[0]
  check('le même jour reste ouvert pour un autre type', autreType?.bookable === true && autreType?.placesLeft === null, JSON.stringify(autreType))
  const sans = (await api('GET', `/availability/days?from=${jour}&to=${jour}`)).body?.data?.days?.[0]
  check('sans type choisi : jour ouvert', sans?.bookable === true)
  const slots = (await api('GET', `/availability/slots?date=${jour}&type=small`)).body?.data
  check('créneaux : aucun libre quand le quota est atteint', slots?.bookable === false && slots?.placesLeft === 0)
  const r2 = await demande()
  check('2e demande small refusée (422)', r2.status === 422 && /type de locks/i.test(r2.body?.error?.message ?? ''), JSON.stringify(r2.body).slice(0, 200))
  const r3 = await demande({ type: 'micro' })
  check('demande micro le même jour acceptée', r3.status === 201, JSON.stringify(r3.body).slice(0, 160))
  await execute("UPDATE booking_requests SET status = 'cancelled' WHERE reference = ?", [r1.body?.data?.reference])
  const libre = (await api('GET', `/availability/days?from=${jour}&to=${jour}&type=small`)).body?.data?.days?.[0]
  check('demande annulée : la place revient', libre?.bookable === true && libre?.placesLeft === 1)
  const vue = (await api('GET', `/admin/quotas?from=${jour}&to=${jour}`, { token })).body?.data?.[0]
  check('vue salon : places prises / limite', vue?.date === jour && vue?.types?.small?.limit === 1, JSON.stringify(vue))
  check('vue salon : refusée sans jeton (401)', (await api('GET', `/admin/quotas?from=${jour}&to=${jour}`)).status === 401)

  /* ── Quota par coiffure ── */
  const [{ id: coiffure }] = (await api('GET', '/admin/services?limit=1', { token })).body?.data ?? [{}]
  if (coiffure) {
    await regler({ types: {}, coiffures: { [coiffure]: 1 } })
    const c1 = await demande({ inspiration: { id: coiffure, title: 'Coiffure test' } })
    const c2 = await demande({ inspiration: { id: coiffure, title: 'Coiffure test' } })
    check('quota par coiffure : 1re acceptée, 2e refusée', c1.status === 201 && c2.status === 422, `${c1.status}/${c2.status}`)
    const c3 = await demande()
    check('une autre coiffure (ou aucune) reste libre', c3.status === 201, String(c3.status))
  }
  await regler(quotasAvant)

  /* ── Règles : besoin, combinaison besoin + type, total du jour ── */
  const ouvert = async (q) => (await api('GET', `/availability/days?from=${jour}&to=${jour}&${q}`)).body?.data?.days?.[0]
  check('règle : réglage accepté (installation micro = 2, 1 déjà prise)', (await regler({ types: {}, coiffures: {}, rules: [{ besoin: 'creation', type: 'micro', limit: 2 }] })).status === 200)
  const rg1 = await demande({ type: 'micro' })
  check('règle : 2e installation micro (dernière place) acceptée', rg1.status === 201, JSON.stringify(rg1.body).slice(0, 160))
  const rg2 = await demande({ type: 'micro' })
  check('règle : 3e installation micro refusée (422)', rg2.status === 422 && /prestation/i.test(rg2.body?.error?.message ?? ''), JSON.stringify(rg2.body).slice(0, 200))
  const rgJour = await ouvert('type=micro&besoin=creation')
  check('règle : jour fermé pour installation micro', rgJour?.bookable === false && rgJour?.reason === 'quota_full', JSON.stringify(rgJour))
  const rgAutre = await ouvert('type=small&besoin=creation')
  check('règle : installation small reste ouverte', rgAutre?.bookable === true, JSON.stringify(rgAutre))
  const rgRes = await ouvert('type=micro&besoin=resserrage')
  check('règle : resserrage micro reste ouvert', rgRes?.bookable === true, JSON.stringify(rgRes))
  const rgVue = (await api('GET', `/admin/quotas?from=${jour}&to=${jour}`, { token })).body?.data?.[0]
  check('règle : vue salon avec places prises', rgVue?.rules?.[0]?.limit === 2 && rgVue.rules[0].used >= 1, JSON.stringify(rgVue?.rules))
  await regler({ types: {}, coiffures: {}, rules: [{ besoin: 'reparation', type: '', limit: 1 }] })
  const rep1 = await demande({ besoin: 'resserrage', formule: 'reparation' })
  const rep2 = await demande({ besoin: 'resserrage', formule: 'reparation' })
  check('règle réparation : 1re acceptée, 2e refusée', rep1.status === 201 && rep2.status === 422, `${rep1.status}/${rep2.status}`)
  const crea = await demande({ type: 'small' })
  check('règle réparation : une installation passe encore', crea.status === 201, String(crea.status))
  await regler({ types: {}, coiffures: {}, rules: [{ besoin: '', type: '', limit: 1 }] })
  const tot = await demande({ type: 'small' })
  check('total du jour atteint : toute nouvelle prestation refusée', tot.status === 422, String(tot.status))
  await regler(quotasAvant)

  /* ── E-mail facultatif ── */
  const sansMail = await demande({ email: undefined, desiredDate: jour })
  check('demande sans e-mail acceptée', sansMail.status === 201, JSON.stringify(sansMail.body).slice(0, 200))
  const vide = await demande({ email: '' })
  check('e-mail vide accepté', vide.status === 201, JSON.stringify(vide.body).slice(0, 200))
  const faux = await demande({ email: 'pas-un-mail' })
  check('e-mail invalide toujours refusé (422)', faux.status === 422)

  /* ── Prestation le jour de la consultation ── */
  const consult = (extra = {}) => demande({ consultation: { mode: 'sur_place', hasLocks: true, date: jour, time: '10:00' }, avecPrestation: true, serviceDate: jour, serviceTime: '14:00', customerKind: 'ancienne', ...extra })
  const memeJour = await consult()
  check('prestation le même jour que la consultation, autre heure : acceptée', memeJour.status === 201, JSON.stringify(memeJour.body).slice(0, 220))
  const memeHeure = await consult({ serviceTime: '10:00' })
  check('même heure que la consultation : refusée (422)', memeHeure.status === 422 && /autre heure/i.test(memeHeure.body?.error?.message ?? ''), JSON.stringify(memeHeure.body).slice(0, 200))
  const veille = await consult({ serviceDate: new Date(new Date(`${jour}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10) })
  check('prestation avant la consultation : refusée (422)', veille.status === 422)

  /* ── Rendez-vous pris au salon : même règle ── */
  const idService = ((await api('GET', '/admin/services', { token })).body?.data ?? []).find((x) => x.isActive !== false && x.active !== false)?.id
  const creerSalon = (extra = {}) => api('POST', '/admin/appointments', { token, body: { firstName: 'Salon', lastName: 'Test', phone: phone(700 + phones.length), date: jour, time: '14:00', serviceId: idService, ...extra } })
  await regler({ types: {}, coiffures: { [idService]: 1 }, rules: [] })
  const sa = await creerSalon({ force: true })
  const salonIds = [sa.body?.data?.id]
  const sb = await creerSalon()
  check('salon : coiffure à 1 place, 1re prise acceptée', sa.status === 201, JSON.stringify(sa.body).slice(0, 160))
  check('salon : 2e refusée (409, forçable)', sb.status === 409 && sb.body?.error?.details?.forceable === true, JSON.stringify(sb.body).slice(0, 200))
  const sc = await creerSalon({ force: true })
  salonIds.push(sc.body?.data?.id)
  check('salon : le salon peut forcer', sc.status === 201, String(sc.status))
  const vueSalon = (await api('GET', `/admin/quotas?from=${jour}&to=${jour}`, { token })).body?.data?.[0]
  check('les rendez-vous du salon comptent dans la vue', (vueSalon?.coiffures?.[idService]?.used ?? 0) >= 2, JSON.stringify(vueSalon?.coiffures))
  const ouvertSite = (await api('GET', `/availability/days?from=${jour}&to=${jour}&coiffureId=${idService}`)).body?.data?.days?.[0]
  check('le jour est fermé pour le site quand le salon a rempli la coiffure', ouvertSite?.bookable === false, JSON.stringify(ouvertSite))
  await regler({ types: {}, coiffures: {}, rules: [{ besoin: '', type: '', limit: 1 }] })
  const total = await creerSalon()
  check('salon : total du jour atteint → 409', total.status === 409, String(total.status))
  for (const id of salonIds) if (id) await execute('DELETE FROM appointments WHERE id = ?', [id]).catch(() => {})
  await regler(quotasAvant)

  /* ── Modifier date, heure et statut depuis le dashboard ── */
  const walk = await api('POST', '/admin/appointments', { token, body: { firstName: 'Edit', lastName: 'Test', phone: phone(900), date: jour, time: '14:00', serviceId: ((await api('GET', '/admin/services', { token })).body?.data ?? []).find((x) => x.isActive !== false && x.active !== false)?.id, force: true } })
  const rdv = walk.body?.data
  if (rdv?.id) {
    phones.push(rdv.phone ?? '')
    const st = (status) => api('PATCH', `/admin/appointments/${rdv.id}/status`, { token, body: { status, notify: false } })
    const ligne = async () => { const r = await execute('SELECT status, arrived_at, completed_at FROM appointments WHERE id = ?', [rdv.id]); return Array.isArray(r[0]) ? r[0][0] : r[0] }
    check('statut → terminé accepté', (await st('completed')).status === 200)
    let l = await ligne()
    check('terminé : présence et fin horodatées', Boolean(l?.arrived_at) && Boolean(l?.completed_at), JSON.stringify(l))
    check('retour à « confirmé » accepté', (await st('confirmed')).status === 200)
    l = await ligne()
    check('confirmé : présence et fin effacées', !l?.arrived_at && !l?.completed_at, JSON.stringify(l))
    const dep = await api('PATCH', `/admin/appointments/${rdv.id}`, { token, body: { date: jour, time: '15:00' } })
    check('changement d’heure accepté', dep.status === 200, JSON.stringify(dep.body).slice(0, 160))
    await execute('DELETE FROM appointments WHERE id = ?', [rdv.id]).catch(() => {})
  } else check('rendez-vous de test créé', false, JSON.stringify(walk.body).slice(0, 200))

  for (const ref of refs) {
    await execute('DELETE FROM appointment_documents WHERE appointment_id IN (SELECT appointment_id FROM booking_requests WHERE reference = ?)', [ref]).catch(() => {})
    await execute('DELETE FROM appointments WHERE id IN (SELECT appointment_id FROM booking_requests WHERE reference = ?)', [ref]).catch(() => {})
    await execute('DELETE FROM booking_requests WHERE reference = ?', [ref]).catch(() => {})
  }
  for (const p of phones) await execute('DELETE FROM customers WHERE phone = ?', [p]).catch(() => {})
  console.log(`\n${passed} réussis, ${failed} échoués`)
  await closePool()
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
