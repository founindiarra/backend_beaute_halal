/**
 * Heure choisie sur le site : elle occupe une place (autant de places que d'agents en poste), les créneaux du profil
 * existent, et une demande annulée libère sa place. Lancer avec l'API démarrée (npm start). Nettoie ses données.
 */
import { config } from '../src/config/env.js'
import { execute, query, closePool } from '../src/config/database.js'

const BASE = process.env.TEST_API_URL || config.apiUrl
let passed = 0, failed = 0
const check = (l, ok, d = '') => { if (ok) { passed++; console.log(`  ✓ ${l}`) } else { failed++; console.log(`  ✗ ${l}${d ? ` — ${d}` : ''}`) } }
async function api(method, path, { body } = {}) {
  const r = await fetch(`${BASE}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
const phone = `07${String(Date.now()).slice(-8)}`
const person = { firstName: 'Capacite', lastName: 'Test', phone, email: 'capacite.test@example.com' }
const demande = (date, time) => api('POST', '/booking-requests', { body: { besoin: 'creation', type: 'small', volume: 'M', longueur: 'mi-dos', delai: 'standard', etat: 'bon', desiredDate: date, desiredTime: time, customerKind: 'nouvelle', ...person } })

async function main() {
  const slotsOf = async (d) => (await api('GET', `/availability/slots?date=${d}`)).body?.data?.slots ?? []
  // Premier jour ouvert d'ici 3 semaines (mardi → samedi), assez loin pour ne pas dépendre de l'heure courante.
  let date = null
  for (let i = 21; i < 40 && !date; i += 1) {
    const d = new Date(Date.now() + i * 86400000).toISOString().slice(0, 10)
    const s = await slotsOf(d)
    if (s.some((x) => x.time === '10:00' && x.available)) date = d
  }
  check('un jour ouvert existe', Boolean(date))
  const agents = Number((await query('SELECT COUNT(*) AS n FROM team_members WHERE is_active = 1'))[0].n)
  const initial = await slotsOf(date)
  const heures = initial.map((x) => x.time)
  check('créneaux du profil présents (10:00, 14:00, 14:30) et plus de 09:00', ['10:00', '14:00', '14:30'].every((h) => heures.includes(h)) && !heures.includes('09:00'), heures.join(','))
  const free0 = initial.find((x) => x.time === '14:30')?.agentsFree
  check(`14:30 propose ${agents} place(s) au départ`, free0 === agents, String(free0))

  const refs = []
  for (let i = 0; i < agents; i += 1) {
    const r = await demande(date, '14:30')
    check(`demande ${i + 1}/${agents} à 14:30 acceptée`, r.status === 201, JSON.stringify(r.body).slice(0, 160))
    if (r.body?.data?.reference) refs.push(r.body.data.reference)
  }
  const apres = (await slotsOf(date)).find((x) => x.time === '14:30')
  check('14:30 complet une fois les places prises', apres?.available === false && apres?.reason === 'full', JSON.stringify(apres))
  const trop = await demande(date, '14:30')
  check('une demande de plus à 14:30 → 422', trop.status === 422, String(trop.status))
  const autre = (await slotsOf(date)).find((x) => x.time === '10:00')
  check('10:00 reste libre', autre?.available === true && autre?.agentsFree === agents)

  // Une demande annulée libère sa place.
  await execute("UPDATE booking_requests SET status = 'cancelled' WHERE reference = ?", [refs[0]])
  const libere = (await slotsOf(date)).find((x) => x.time === '14:30')
  check('demande annulée → la place est libérée', libere?.available === true && libere?.agentsFree === 1, JSON.stringify(libere))

  // Une demande planifiée à l'heure réelle n'est pas comptée deux fois (rendez-vous lié à heure réelle).
  const [ligne] = await query('SELECT id FROM booking_requests WHERE reference = ?', [refs[1] ?? refs[0]])
  const [{ id: sid }] = await query('SELECT id FROM services LIMIT 1')
  const ins = await execute(
    `INSERT INTO appointments (reference, service_id, service_name, appointment_date, appointment_time, duration_minutes, price, currency, first_name, last_name, phone, email, status, source)
     VALUES (?, ?, 'Test capacité', ?, '14:30:00', 60, 0, 'FCFA', 'C', 'T', ?, 'c@example.com', 'confirmed', 'site-v3')`,
    [`CP-${String(Date.now()).slice(-8)}`, sid, date, phone],
  )
  await execute('UPDATE booking_requests SET appointment_id = ? WHERE id = ?', [ins.insertId, ligne.id])
  const unique = (await slotsOf(date)).find((x) => x.time === '14:30')
  check('rendez-vous planifié : compté une seule fois', unique?.agentsFree === agents - (refs.length - 1), JSON.stringify(unique))

  await execute('DELETE FROM booking_requests WHERE phone = ?', [phone])
  await execute('DELETE FROM appointments WHERE phone = ?', [phone])
  await execute("DELETE FROM customers WHERE phone = ?", [phone]).catch(() => {})
}

main().catch((e) => { failed++; console.error(e) }).finally(async () => {
  await closePool()
  console.log(`\n${passed} OK, ${failed} échec(s)`)
  process.exit(failed ? 1 : 0)
})
