/**
 * Tests : trois types de locks, prestations = coiffures, photos des types.
 * Lancer l'API puis : npm run test:coiffures
 */
import { config } from '../src/config/env.js'
import { execute, query, closePool } from '../src/config/database.js'

const BASE = process.env.TEST_API_URL || config.apiUrl
let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
async function api(method, path, { body, token } = {}) {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await r.json() } catch { /* 204 */ }
  return { status: r.status, body: json }
}

let creeId = null
let suppId = null
let rdvId = null
let avant = null
try {
  const token = (await api('POST', '/admin/auth/login', { body: { email: config.admin.email, password: config.admin.password } })).body?.data?.token
  check('connexion', Boolean(token))

  console.log('\n── Les trois catégories ──')
  const cats = (await api('GET', '/service-categories')).body.data
  check('public : exactement 3 catégories actives', cats.length === 3 && ['traditionnels', 'small', 'micro'].every((s) => cats.some((c) => c.slug === s)), JSON.stringify(cats.map((c) => c.slug)))
  check('création de catégorie refusée (403)', (await api('POST', '/admin/service-categories', { token, body: { name: 'Coloration' } })).status === 403)
  check('suppression de catégorie refusée (403)', (await api('DELETE', `/admin/service-categories/${cats[0].id}`, { token })).status === 403)

  console.log('\n── Types de locks (page Catégories) ──')
  const types = await api('GET', '/admin/lock-types', { token })
  check('GET /admin/lock-types : 3 types avec categoryId', types.status === 200 && types.body.data.length === 3 && types.body.data.every((t) => t.categoryId), JSON.stringify(types.body).slice(0, 200))
  avant = types.body.data.find((t) => t.id === 'small')
  const maj = await api('PATCH', '/admin/lock-types/small', { token, body: { name: 'Small Locks TEST', tagline: 'Slogan test', description: 'Description test', size: '0,5 cm', rhythm: 'Tous les 2 mois', image: '/uploads/test-small.jpg' } })
  check('PATCH : informations et image enregistrées', maj.status === 200 && maj.body.data.name === 'Small Locks TEST' && maj.body.data.image === '/uploads/test-small.jpg' && /^https?:\/\/.+\/uploads\/test-small\.jpg$/.test(maj.body.data.imageUrl), JSON.stringify(maj.body).slice(0, 250))
  const pub = (await api('GET', '/tarifs')).body.data.lockTypes.find((t) => t.id === 'small')
  check('site : /tarifs porte l’image (adresse complète) et le texte', /\/uploads\/test-small\.jpg$/.test(pub.image) && pub.name === 'Small Locks TEST' && pub.tagline === 'Slogan test')
  const cat = (await api('GET', '/service-categories')).body.data.find((c) => c.slug === 'small')
  check('catégorie « small » renommée aussi', cat.name === 'Small Locks TEST')
  check('type inconnu → 404', (await api('PATCH', '/admin/lock-types/xyz', { token, body: { name: 'Zz' } })).status === 404)
  check('nom trop court → 422', (await api('PATCH', '/admin/lock-types/small', { token, body: { name: 'A' } })).status === 422)
  // Enregistrer les tarifs (PUT complet) ne doit pas effacer l'image
  const adminCat = (await api('GET', '/admin/tarifs', { token })).body.data
  const put = await api('PUT', '/admin/tarifs', { token, body: adminCat })
  check('PUT /admin/tarifs conserve l’image du type', put.status === 200 && put.body.data.lockTypes.find((t) => t.id === 'small').image === '/uploads/test-small.jpg', String(put.status))
  const reset = await api('POST', '/admin/tarifs/reset', { token })
  check('« Rétablir » la grille conserve photos et textes des types', reset.status === 200 && reset.body.data.lockTypes.find((t) => t.id === 'small').image === '/uploads/test-small.jpg' && reset.body.data.lockTypes.find((t) => t.id === 'small').name === 'Small Locks TEST')

  console.log('\n── Prestations = coiffures ──')
  const catSmall = (await api('GET', '/admin/lock-types', { token })).body.data.find((t) => t.id === 'small').categoryId
  const c = await api('POST', '/admin/services', { token, body: { categoryId: catSmall, name: 'Coiffure test coiffures', description: 'Une belle coiffure', imageUrl: '/uploads/test-c.jpg', isFeatured: true } })
  check('création sans prix ni durée (201)', c.status === 201, JSON.stringify(c.body).slice(0, 200))
  creeId = c.body?.data?.id
  check('catégorie = type small, image enregistrée', c.body?.data?.category?.slug === 'small' && c.body?.data?.imageUrl?.endsWith('/uploads/test-c.jpg'))
  const orph = (await api('GET', '/admin/service-categories', { token })).body.data.find((x) => x.slug === 'sur-mesure-site' || x.name.includes('Sur mesure'))
  if (orph) {
    const bad = await api('POST', '/admin/services', { token, body: { categoryId: orph.id, name: 'Hors type' } })
    check('catégorie hors des 3 types → 422', bad.status === 422, String(bad.status))
  }
  const modif = await api('PATCH', `/admin/services/${creeId}`, { token, body: { name: 'Coiffure test modifiée', description: 'Nouvelle description', isActive: true } })
  check('modification (nom, description)', modif.status === 200 && modif.body.data.name === 'Coiffure test modifiée' && modif.body.data.description === 'Nouvelle description')
  const listePub = (await api('GET', '/services')).body.data
  check('visible du public avec son image', listePub.some((s) => s.id === creeId && s.imageUrl))
  const masque = await api('PATCH', `/admin/services/${creeId}`, { token, body: { isActive: false } })
  check('désactivée → disparaît du public', masque.status === 200 && !(await api('GET', '/services')).body.data.some((s) => s.id === creeId))
  // Depuis le site v3, les anciennes prestations (retwist, coloration…) sont masquées du public mais conservées en base.
  const toutes = (await api('GET', '/admin/services?includeInactive=true&limit=200', { token })).body?.data ?? []
  const anciennes = toutes.filter((s) => s.isActive === false && s.price > 0 && s.durationMinutes > 0)
  const publicSlugs = new Set((await api('GET', '/services')).body.data.map((s) => s.slug))
  check('anciennes prestations gardées en base (prix et durée) mais absentes du public', anciennes.length > 0 && anciennes.every((s) => !publicSlugs.has(s.slug)), `${anciennes.length} anciennes`)

  console.log('\n── Ordre des coiffures (glisser-déposer du dashboard) ──')
  const avantOrdre = (await api('GET', '/admin/services?includeInactive=true&limit=500', { token })).body.data
  const idsAvant = avantOrdre.map((x) => x.id)
  const nouveau = [...idsAvant]
  ;[nouveau[0], nouveau[2]] = [nouveau[2], nouveau[0]]
  const ordre = await api('PUT', '/admin/services/order', { token, body: { ids: nouveau } })
  check('enregistrement de l’ordre (200)', ordre.status === 200 && ordre.body?.data?.ordered === nouveau.length, JSON.stringify(ordre.body).slice(0, 160))
  const apresOrdre = (await api('GET', '/admin/services?includeInactive=true&limit=500', { token })).body.data
  check('la liste du dashboard suit le nouvel ordre', JSON.stringify(apresOrdre.map((x) => x.id)) === JSON.stringify(nouveau))
  const publicOrdre = (await api('GET', '/services')).body.data.map((x) => x.id)
  check('le site public suit le même ordre', JSON.stringify(publicOrdre) === JSON.stringify(nouveau.filter((id) => publicOrdre.includes(id))))
  check('seule la position change (noms, photos et visibilité intacts)', apresOrdre.every((x) => { const o = avantOrdre.find((y) => y.id === x.id); return o && o.name === x.name && o.imageUrl === x.imageUrl && o.isActive === x.isActive }))
  const partiel = await api('PUT', '/admin/services/order', { token, body: { ids: [nouveau[5]] } })
  const apresPartiel = (await api('GET', '/admin/services?includeInactive=true&limit=500', { token })).body.data.map((x) => x.id)
  check('liste partielle : la prestation passe en premier, les autres gardent leur ordre', partiel.status === 200 && apresPartiel[0] === nouveau[5] && JSON.stringify(apresPartiel.slice(1)) === JSON.stringify(nouveau.filter((id) => id !== nouveau[5])))
  check('liste vide refusée (422)', (await api('PUT', '/admin/services/order', { token, body: { ids: [] } })).status === 422)
  await api('PUT', '/admin/services/order', { token, body: { ids: idsAvant } })
  check('ordre d’origine restauré', JSON.stringify((await api('GET', '/admin/services?includeInactive=true&limit=500', { token })).body.data.map((x) => x.id)) === JSON.stringify(idsAvant))

  console.log('\n── Suppression d’une prestation utilisée par un ancien rendez-vous ──')
  const s2 = await api('POST', '/admin/services', { token, body: { categoryId: (await api('GET', '/service-categories')).body.data[0].id, name: 'Coiffure test à supprimer' } })
  suppId = s2.body?.data?.id
  const ref = `ZZ-${String(Date.now()).slice(-8)}`
  const ins = await execute(
    `INSERT INTO appointments (reference, service_id, service_name, appointment_date, appointment_time, duration_minutes, price, currency, first_name, last_name, phone, email, status, source)
     VALUES (?, ?, 'Ancienne coiffure test', '2024-01-10', '10:00:00', 60, 12000, 'FCFA', 'Z', 'T', '0100000000', 'zz@example.com', 'completed', 'test')`,
    [ref, suppId],
  )
  rdvId = ins.insertId
  const del = await api('DELETE', `/admin/services/${suppId}`, { token })
  check('la prestation utilisée par un rendez-vous est supprimable (204)', del.status === 204, String(del.status))
  const encore = await query('SELECT id FROM services WHERE id = ?', [suppId])
  check('la prestation a bien disparu', encore.length === 0)
  const [rdv] = await query('SELECT service_name, price, status, service_id FROM appointments WHERE id = ?', [rdvId])
  check('le rendez-vous est conservé (libellé, prix, statut)', rdv?.service_name === 'Ancienne coiffure test' && Number(rdv.price) === 12000 && rdv.status === 'completed')
  const [tech] = await query("SELECT id, is_active FROM services WHERE slug = 'prestation-sur-mesure-site'")
  check('son lien technique passe sur la prestation « sur mesure » inactive', tech && Number(rdv.service_id) === tech.id && !tech.is_active)
  const techDel = await api('DELETE', `/admin/services/${tech.id}`, { token })
  check('la prestation technique portant des rendez-vous n’est pas supprimable (409)', techDel.status === 409, String(techDel.status))
} finally {
  if (rdvId) await execute('DELETE FROM appointments WHERE id = ?', [rdvId])
  if (suppId) await execute('DELETE FROM services WHERE id = ?', [suppId])
  if (creeId) await execute('DELETE FROM services WHERE id = ?', [creeId])
  if (avant) await execute("UPDATE service_categories SET name = ?, description = ? WHERE slug = 'small'", [avant.name, avant.description || null])
  await closePool()
}
// Restaurer le type small dans le catalogue
if (avant) {
  const token = (await api('POST', '/admin/auth/login', { body: { email: config.admin.email, password: config.admin.password } })).body?.data?.token
  await api('PATCH', '/admin/lock-types/small', { token, body: { name: avant.name, tagline: avant.tagline, description: avant.description, size: avant.size, rhythm: avant.rhythm, image: avant.image || '' } })
}
console.log(`\n${passed} réussis, ${failed} échoués`)
process.exit(failed ? 1 : 0)
