/**
 * Avis du site, fourchettes d'installation, agents multiples, rapport comptable,
 * PDF de marque et listes « Rendez-vous » / « Rendez-vous terminés ».
 * Lancer avec l'API démarrée. Nettoie ses données.
 */
import { config } from '../src/config/env.js'
import { execute, query, closePool } from '../src/config/database.js'

const BASE = process.env.TEST_API_URL || config.apiUrl
let passed = 0, failed = 0
const check = (l, ok, d = '') => { if (ok) { passed++; console.log(`  ✓ ${l}`) } else { failed++; console.log(`  ✗ ${l}${d ? ` — ${d}` : ''}`) } }
async function api(method, path, { body, token, raw } = {}) {
  const r = await fetch(`${BASE}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  if (raw) return { status: r.status, type: r.headers.get('content-type') ?? '', buf: Buffer.from(await r.arrayBuffer()) }
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
const phone = `07${String(Date.now()).slice(-8)}`
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
const today = new Date().toISOString().slice(0, 10)

async function main() {
  const token = (await api('POST', '/admin/auth/login', { body: { email: config.admin.email, password: config.admin.password } })).body?.data?.token

  /* ── Avis déposés depuis le site ── */
  const marque = `Avis test ${Date.now()}`
  const bad = await api('POST', '/testimonials', { body: { firstName: 'Awa', rating: 9, comment: 'Très bien merci beaucoup', serviceName: marque } })
  check('avis : note hors 1–5 refusée (422)', bad.status === 422, String(bad.status))
  const court = await api('POST', '/testimonials', { body: { firstName: 'Awa', rating: 5, comment: 'ok', serviceName: marque } })
  check('avis : commentaire trop court refusé (422)', court.status === 422)
  const robot = await api('POST', '/testimonials', { body: { firstName: 'Bot', rating: 5, comment: 'Message envoyé par un robot', serviceName: marque, website: 'http://spam' } })
  check('avis : piège anti-robot sans enregistrement', (robot.status === 422 || robot.status < 300) && (await query('SELECT id FROM testimonials WHERE service_name = ?', [marque])).length === 0, String(robot.status))
  const ok = await api('POST', '/testimonials', { body: { firstName: 'Awa', rating: 5, comment: 'Des locks magnifiques, merci à toute l’équipe !', serviceName: marque } })
  check('avis : dépôt accepté (201/200)', ok.status === 201 || ok.status === 200, JSON.stringify(ok.body).slice(0, 150))
  const [ligne] = await query('SELECT id, is_published FROM testimonials WHERE service_name = ?', [marque])
  check('avis : enregistré NON publié', ligne && Number(ligne.is_published) === 0)
  const publics = (await api('GET', '/testimonials')).body?.data ?? []
  check('avis : absent du site tant qu’il n’est pas publié', !publics.some((t) => t.serviceName === marque || t.service === marque))
  const admin = (await api('GET', '/admin/testimonials', { token })).body?.data ?? []
  check('avis : visible dans le dashboard', JSON.stringify(admin).includes(marque))
  await execute('DELETE FROM testimonials WHERE service_name = ?', [marque])

  /* ── Fourchettes d'installation ── */
  const cat = (await api('GET', '/admin/tarifs', { token })).body?.data
  check('tarifs : fourchettes d’installation présentes', Array.isArray(cat?.installations) && cat.installations.length >= 3, JSON.stringify(cat?.installations)?.slice(0, 150))
  const pub = (await api('GET', '/tarifs')).body?.data
  check('tarifs : exposées sur le site', Array.isArray(pub?.installations) && pub.installations.length >= 3)

  /* ── Rendez-vous : agents multiples, listes, tri ── */
  const equipe = (await api('GET', '/admin/team', { token })).body?.data ?? []
  const agents = equipe.filter((m) => m.isActive !== false).slice(0, 2)
  const refs = []
  const creer = async (n) => {
    const r = await api('POST', '/booking-requests', { body: { besoin: 'creation', type: 'small', volume: 'M', longueur: 'mi-dos', delai: 'standard', etat: 'bon', desiredDate: tomorrow, firstName: 'Multi', lastName: `Agent${n}`, phone, email: `multi${n}@example.com` } })
    refs.push(r.body?.data?.reference)
    return r.body?.data?.reference
  }
  const r1 = await creer(1); const r2 = await creer(2)
  const liste = (await api('GET', `/admin/appointments?search=${phone}`, { token })).body?.data ?? []
  const a1 = liste.find((a) => a.reference === r1); const a2 = liste.find((a) => a.reference === r2)
  const act = (await api('GET', `/admin/operations?scope=active&search=${phone}`, { token }))
  check('rendez-vous (active) : les demandes en attente y figurent', act.status === 200 && (act.body?.data ?? []).some((x) => x.reference === r1 && x.status === 'pending'), String(act.status))
  const plan = await api('POST', `/admin/appointments/${a1.id}/plan`, { token, body: { date: tomorrow, time: '10:30', price: 40000 } })
  check('planification (200)', plan.status === 200)
  if (agents.length >= 2) {
    const aff = await api('PATCH', `/admin/appointments/${a1.id}/assignment`, { token, body: { staffIds: agents.map((a) => a.id) } })
    check('affecter plusieurs agents (200)', aff.status === 200 && aff.body?.data?.agents?.length === 2, JSON.stringify(aff.body).slice(0, 200))
    const fiche = (await api('GET', `/admin/appointments/${a1.id}/operation`, { token })).body?.data
    check('fiche : les deux agents sont relus', fiche?.agents?.length === 2 && fiche?.agent?.id === agents[0].id, JSON.stringify(fiche?.agents))
    const faux = await api('PATCH', `/admin/appointments/${a1.id}/assignment`, { token, body: { staffIds: [999999] } })
    check('agent inconnu refusé (422)', faux.status === 422)
  } else check('(agents multiples ignorés : moins de 2 agents en base)', true)
  // Une cliente encaisse depuis la page de traitement
  await api('POST', `/admin/appointments/${a1.id}/arrival`, { token, body: {} })
  const pay = await api('POST', `/admin/appointments/${a1.id}/payments`, { token, body: { amount: 15000 } })
  check('paiement depuis la fiche (200)', pay.status === 200 && pay.body?.data?.totals?.paid === 15000, JSON.stringify(pay.body).slice(0, 150))
  const rec = await api('POST', `/admin/appointments/${a1.id}/documents/receipt`, { token, body: {} })
  check('reçu généré (200/201)', rec.status < 300, JSON.stringify(rec.body).slice(0, 150))
  const docId = rec.body?.data?.id ?? rec.body?.data?.document?.id
  if (docId) {
    const pdf = await api('GET', `/admin/documents/${docId}/pdf`, { token, raw: true })
    check('reçu : PDF valide à la marque', pdf.status === 200 && pdf.buf.subarray(0, 4).toString() === '%PDF' && pdf.buf.length > 5000, `${pdf.status} ${pdf.buf.length}`)
  }
  // Tri du plus récent au moins récent
  const triees = (await api('GET', `/admin/operations?scope=active&search=${phone}`, { token })).body?.data ?? []
  const cles = triees.map((x) => `${String(x.date).slice(0, 10)} ${x.time}`)
  check('tri : du plus récent au moins récent', cles.every((c, i) => i === 0 || cles[i - 1] >= c), cles.join(' | '))
  // Terminer → bascule dans « terminés »
  const fin = await api('POST', `/admin/appointments/${a1.id}/complete`, { token, body: { notify: false } })
  const encoreActif = (await api('GET', `/admin/operations?scope=active&search=${phone}`, { token })).body?.data ?? []
  const termines = (await api('GET', `/admin/operations?scope=completed&search=${phone}`, { token })).body?.data ?? []
  check('terminé : sort de « Rendez-vous »', fin.status === 200 && !encoreActif.some((x) => x.id === a1.id) && encoreActif.some((x) => x.id === a2.id), String(fin.status))
  check('terminé : seul « Rendez-vous terminés » le contient', termines.length === 1 && termines[0].id === a1.id && termines[0].status === 'completed')

  /* ── Rapport comptable ── */
  const rj = await api('GET', `/admin/accounting/report?from=${today}&to=${today}&format=json`, { token })
  check('rapport JSON (200)', rj.status === 200 && rj.body?.data, String(rj.status))
  const rp = await api('GET', `/admin/accounting/report?from=${today}&to=${today}&format=pdf`, { token, raw: true })
  check('rapport PDF (200, %PDF)', rp.status === 200 && rp.buf.subarray(0, 4).toString() === '%PDF', `${rp.status} ${rp.type}`)
  const rc = await api('GET', `/admin/accounting/report?from=${today}&to=${today}&format=csv`, { token, raw: true })
  check('rapport CSV (200)', rc.status === 200 && /csv|text/.test(rc.type), rc.type)
  check('rapport : refusé sans jeton (401)', (await api('GET', `/admin/accounting/report?from=${today}&to=${today}&format=json`)).status === 401)
  check('rapport : dates invalides (422)', (await api('GET', '/admin/accounting/report?from=nimporte&to=quoi&format=json', { token })).status === 422)

  for (const ref of refs.filter(Boolean)) {
    await execute('DELETE FROM documents WHERE appointment_id IN (SELECT id FROM appointments WHERE reference = ?)', [ref]).catch(() => {})
    await execute('DELETE FROM appointment_agents WHERE appointment_id IN (SELECT id FROM appointments WHERE reference = ?)', [ref]).catch(() => {})
    await execute('DELETE FROM booking_requests WHERE reference = ?', [ref]).catch(() => {})
    await execute('DELETE FROM appointments WHERE reference = ?', [ref]).catch(() => {})
  }
  await execute('DELETE FROM customers WHERE phone = ?', [phone]).catch(() => {})
  console.log(`\n${passed} réussis, ${failed} échoués`)
  await closePool()
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
