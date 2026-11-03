/**
 * Textes et règles du site : le catalogue expose « site » (complété avec les valeurs d'origine), le dashboard peut le
 * modifier, le site public le relit, et une valeur trop volumineuse est refusée. Restaure le catalogue à la fin.
 */
import { config } from '../src/config/env.js'
import { closePool } from '../src/config/database.js'

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
  const original = (await api('GET', '/admin/tarifs', { token })).body?.data
  check('le catalogue admin contient « site » complété', original?.site?.accueil?.titre && original.site.conditions?.lines?.length >= 3 && original.site.creneaux?.autres?.length === 2 && original.site.etapes?.liste?.length === 4)
  check('titres des sections, page 404 et référencement présents', Boolean(original?.site?.sections?.types?.titre && original.site.sections.introuvable?.texte && original.site.seo?.home?.title && original.site.seo?.contact?.description && original.site.accueil?.bouton))
  check('les textes d’origine ne parlent plus de « création complète »', !JSON.stringify(original?.site).toLowerCase().includes('création complète'))
  try {
    const modifie = JSON.parse(JSON.stringify(original))
    modifie.site.conditions.lines = ['Condition de test.']
    modifie.site.creneaux.autres = ['15:00']
    modifie.site.pages.contact.titre = 'Titre *test*'
    modifie.site.detailsCoiffure.soins[0].image = '/uploads/zz-shampooing-test.webp'
    const put = await api('PUT', '/admin/tarifs', { token, body: modifie })
    check('enregistrement des textes du site (200)', put.status === 200, JSON.stringify(put.body).slice(0, 160))
    const pub = (await api('GET', '/tarifs')).body?.data
    check('le site public relit les conditions modifiées', JSON.stringify(pub?.site?.conditions?.lines) === JSON.stringify(['Condition de test.']))
    check('la photo d’un soin (shampooing) est renvoyée en adresse complète', /^https?:\/\/.+\/uploads\/zz-shampooing-test\.webp$/.test(pub?.site?.detailsCoiffure?.soins?.[0]?.image ?? ''), String(pub?.site?.detailsCoiffure?.soins?.[0]?.image))
    check('heures par profil modifiées', JSON.stringify(pub?.site?.creneaux?.autres) === '["15:00"]')
    check('les autres textes restent intacts', pub?.site?.pages?.contact?.titre === 'Titre *test*' && pub?.site?.accueil?.titre === original.site.accueil.titre)

    const enorme = JSON.parse(JSON.stringify(original))
    enorme.site.conditions.lines = ['x'.repeat(70000)]
    const refus = await api('PUT', '/admin/tarifs', { token, body: enorme })
    check('textes trop volumineux → 422', refus.status === 422, String(refus.status))

    // Vidéo de la page Rendez-vous : dépôt MP4, refus d'un autre format, relecture par le site public.
    const form = new FormData()
    form.append('video', new Blob([Buffer.from('0000001866747970', 'hex'), Buffer.alloc(64)], { type: 'video/mp4' }), 'ambiance.mp4')
    const dep = await fetch(`${BASE}/api/admin/uploads/video`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
    const depJson = await dep.json().catch(() => null)
    check('dépôt d’une vidéo MP4 (201)', dep.status === 201 && depJson?.data?.path?.endsWith('.mp4'), String(dep.status))
    const mauvais = new FormData()
    mauvais.append('video', new Blob(['x'], { type: 'text/plain' }), 'x.txt')
    const refusVideo = await fetch(`${BASE}/api/admin/uploads/video`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: mauvais })
    check('format de vidéo refusé (400)', refusVideo.status === 400, String(refusVideo.status))
    const avecVideo = JSON.parse(JSON.stringify(original))
    avecVideo.media = { ...(avecVideo.media ?? {}), heroes: { ...(avecVideo.media?.heroes ?? {}), booking: { desktop: null, mobile: null, video: depJson?.data?.path, poster: null } } }
    const putVideo = await api('PUT', '/admin/tarifs', { token, body: avecVideo })
    check('enregistrement de la vidéo (200)', putVideo.status === 200, JSON.stringify(putVideo.body).slice(0, 160))
    const pub2 = (await api('GET', '/tarifs')).body?.data
    check('le site public reçoit l’adresse complète de la vidéo', /^https?:\/\/.+\.mp4$/.test(pub2?.media?.heroes?.booking?.video ?? ''))
    const servie = await fetch(`${BASE}${depJson?.data?.path}`)
    check('la vidéo est servie en statique', servie.status === 200)
    if (depJson?.data?.filename) await fetch(`${BASE}/api/admin/uploads/${depJson.data.filename}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
  } finally {
    const rest = await api('PUT', '/admin/tarifs', { token, body: original })
    check('catalogue restauré', rest.status === 200)
  }
}
main().catch((e) => { failed++; console.error(e) }).finally(async () => { await closePool(); console.log(`\n${passed} OK, ${failed} échec(s)`); process.exit(failed ? 1 : 0) })
