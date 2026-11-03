/**
 * Tests du script « nettoyer-images-etrangeres » : une photo du domaine Beauté Halal (ou téléversée) n'est JAMAIS retirée.
 * Lancer : node tests/images-etrangeres.test.js (base de TEST uniquement ; les lignes créées sont supprimées à la fin).
 */
import { spawnSync } from 'node:child_process'

import { config } from '../src/config/env.js'
import { closePool, execute, query } from '../src/config/database.js'
import { estImageEtrangere, estReferencee, trierPrestations } from '../scripts/lib/images-etrangeres.js'

if (config.isProduction) { console.error('Refus : jamais en production.'); process.exit(1) }
let passed = 0
let failed = 0
const check = (label, ok, detail = '') => { if (ok) { passed += 1; console.log(`  ✓ ${label}`) } else { failed += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) } }

// ── Règle pure ──
const PROTEGEES = [
  'https://beaute-halal.aeemci-ce.ci/images/coiffures/locks-perles.webp',
  'https://beaute-halal.aeemci-ce.ci/images/coiffures/micro-locks-crepus-chignon.webp',
  'https://beaute-halal.aeemci-ce.ci/images/logo.png',
  'https://beaute-halal.aeemci-ce.ci/illustration.svg',
  'https://api.beaute-halal.aeemci-ce.ci/uploads/1-a-photo.jpg',
  '/uploads/1792229810856-1907e840-type-small.png',
  '/uploads/salon-micro-locks-finition.webp',
  '/images/coiffures/x.gif',
  'https://exemple.org/unsplash.com/photo.jpg',
  'https://unsplash.com.evil-site.test/p.jpg',
  '', null, undefined, 'pas une url',
]
const ETRANGERES = [
  'https://images.unsplash.com/photo-1625536658395-2bd89a631e37?auto=format&fit=crop&w=1200&q=80',
  'https://unsplash.com/photos/abc',
  'https://images.pexels.com/photos/1/pexels-photo-1.jpeg',
  'https://cdn.pixabay.com/photo/2020/01/01/img.png',
  'HTTPS://IMAGES.UNSPLASH.COM/photo-2',
]
for (const u of PROTEGEES) check(`protégée : ${u || String(u)}`, estImageEtrangere(u) === false)
for (const u of ETRANGERES) check(`étrangère : ${u.slice(0, 60)}`, estImageEtrangere(u) === true)

// ── Utilisée ailleurs (Hero, pages) ──
const hero = 'https://images.unsplash.com/photo-hero-zz'
check('référencée dans un JSON (slashs échappés)', estReferencee(hero, JSON.stringify({ site: { hero } })))
check('non référencée', !estReferencee(hero, 'autre chose'))
const tri = trierPrestations([{ id: 1, image_url: hero }, { id: 2, image_url: 'https://images.unsplash.com/photo-libre' }], JSON.stringify({ hero }))
check('image Hero étrangère protégée', tri.aRetirer.length === 1 && tri.aRetirer[0].id === 2 && tri.utiliseesAilleurs[0].id === 1)

// ── Script, sur la base de test ──
const tag = 'zz-test-img'
const lancer = (...args) => spawnSync(process.execPath, ['scripts/nettoyer-images-etrangeres.js', ...args], { encoding: 'utf8' })
const urlSalon = 'https://beaute-halal.aeemci-ce.ci/images/coiffures/locks-perles.webp'
const urlUnsplash = 'https://images.unsplash.com/photo-test-zz'
let ids = {}
let avant = {}
try {
  const [cat] = await query('SELECT id FROM service_categories LIMIT 1')
  const ajout = async (suffixe, url) => (await execute(
    `INSERT INTO services (category_id, slug, name, duration_minutes, price, currency, image_url, is_active, position) VALUES (?, ?, ?, 60, 0, 'FCFA', ?, 1, 9999)`,
    [cat.id, `${tag}-${suffixe}`, `Test ${suffixe}`, url],
  )).insertId
  ids = { salon: await ajout('salon', urlSalon), png: await ajout('png', 'https://beaute-halal.aeemci-ce.ci/images/x.png'), up: await ajout('up', '/uploads/zz-test.png'), unsplash: await ajout('unsplash', urlUnsplash) }
  ids.hero = await ajout('hero', 'https://images.pexels.com/photos/zz-hero.jpeg')
  const [cat2] = await query('SELECT id FROM gallery_categories LIMIT 1')
  const gal = await execute(`INSERT INTO gallery_items (category_id, title, image_url, is_active, position) VALUES (?, 'zz-test-img galerie', 'https://images.unsplash.com/photo-galerie-zz', 1, 9999)`, [cat2.id])
  await execute(`INSERT INTO salon_settings (setting_key, setting_value) VALUES ('zz_test_hero', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, ['https://images.pexels.com/photos/zz-hero.jpeg'])
  const compte = async () => ({ services: (await query('SELECT COUNT(*) n FROM services'))[0].n, galerie: (await query('SELECT COUNT(*) n FROM gallery_items WHERE id = ?', [gal.insertId]))[0].n, reglages: (await query('SELECT COUNT(*) n FROM salon_settings'))[0].n })
  avant = await compte()
  const lire = async (id) => (await query('SELECT image_url FROM services WHERE id = ?', [id]))[0]

  const simulation = lancer()
  check('simulation : code de sortie 0', simulation.status === 0, simulation.stderr?.slice(0, 200))
  check('simulation : affiche les protégées', simulation.stdout.includes('✓ protégée') && simulation.stdout.includes(urlSalon))
  check('simulation : affiche les images à retirer', simulation.stdout.includes('✗ à retirer') && simulation.stdout.includes('photo-test-zz'))
  check('simulation : ne retire rien', (await lire(ids.unsplash)).image_url === urlUnsplash)

  const reel = lancer('--apply')
  check('--apply : code de sortie 0', reel.status === 0, reel.stderr?.slice(0, 200))
  check('--apply : la photo Unsplash est retirée', (await lire(ids.unsplash)).image_url === null)
  check('--apply : la prestation est conservée', Boolean(await lire(ids.unsplash)))
  check('--apply : la photo du domaine Beauté Halal est conservée', (await lire(ids.salon)).image_url === urlSalon)
  check('--apply : un .png du domaine Beauté Halal est conservé', (await lire(ids.png)).image_url === 'https://beaute-halal.aeemci-ce.ci/images/x.png')
  check('--apply : une image utilisée dans les paramètres du site (Hero) est conservée', (await lire(ids.hero)).image_url === 'https://images.pexels.com/photos/zz-hero.jpeg')
  check('--apply : la galerie n\'est pas modifiée', (await query('SELECT image_url FROM gallery_items WHERE id = ?', [gal.insertId]))[0]?.image_url === 'https://images.unsplash.com/photo-galerie-zz')
  check('--apply : aucune prestation ni réglage supprimé', JSON.stringify(await compte()) === JSON.stringify(avant))
  check('--apply : un fichier téléversé est conservé', (await lire(ids.up)).image_url === '/uploads/zz-test.png')
} finally {
  await execute('DELETE FROM services WHERE slug LIKE ?', [`${tag}-%`])
  await execute("DELETE FROM gallery_items WHERE title = 'zz-test-img galerie'")
  await execute("DELETE FROM salon_settings WHERE setting_key = 'zz_test_hero'")
  await closePool()
}
console.log(`\n${passed} réussi(s), ${failed} échec(s)`)
process.exit(failed ? 1 : 0)
