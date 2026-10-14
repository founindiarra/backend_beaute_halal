/**
 * Tests de bout en bout de l'API.
 * Le serveur doit tourner (npm run dev) et la base être migrée + seedée.
 *
 *   npm run test:api
 *
 * Les données créées pendant les tests sont supprimées à la fin.
 */
import { config } from '../src/config/env.js'

const BASE = process.env.TEST_API_URL || config.apiUrl
let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n── ${title} ──`)
}

async function call(method, path, { body, token, raw } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body && !raw) headers['Content-Type'] = 'application/json'

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  })

  let payload = null
  if (response.status !== 204) {
    const text = await response.text()
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = text
    }
  }
  return { status: response.status, body: payload }
}

const get = (path, options) => call('GET', path, options)
const post = (path, body, options) => call('POST', path, { body, ...options })
const patch = (path, body, options) => call('PATCH', path, { body, ...options })
const put = (path, body, options) => call('PUT', path, { body, ...options })
const del = (path, options) => call('DELETE', path, options)

async function main() {
  console.log(`API testée : ${BASE}\n`)

  // ════════ Santé ════════
  section('Santé')
  const health = await get('/api/health')
  check('GET /api/health → 200', health.status === 200, `reçu ${health.status}`)
  check('statut « ok »', health.body?.data?.status === 'ok')

  // ════════ Salon ════════
  section('Informations du salon')
  const salon = await get('/api/salon')
  check('GET /api/salon → 200', salon.status === 200)
  check('nom du salon présent', salon.body?.data?.name === 'Beauté Halal')
  check('7 jours d’horaires', salon.body?.data?.hours?.length === 7)
  check('semaine commençant le lundi', salon.body?.data?.hours?.[0]?.day === 'Lundi')
  check('adresse et WhatsApp exposés', Boolean(salon.body?.data?.address && salon.body?.data?.whatsapp))

  // ════════ Prestations ════════
  section('Prestations')
  const categories = await get('/api/service-categories')
  check('GET /api/service-categories → 6 catégories', categories.body?.data?.length === 6)

  const services = await get('/api/services')
  check('GET /api/services → 17 prestations', services.body?.data?.length === 17)

  const first = services.body?.data?.[0]
  check(
    'champs attendus sur une prestation',
    Boolean(first?.slug && first?.name && first?.durationMinutes && first?.category?.slug),
  )

  const featured = await get('/api/services?featured=true')
  check('filtre ?featured=true → 6 mises en avant', featured.body?.data?.length === 6)

  const byCategory = await get('/api/services?category=coloration')
  check(
    'filtre ?category=coloration → 3 prestations',
    byCategory.body?.data?.length === 3,
    `reçu ${byCategory.body?.data?.length}`,
  )

  const oneService = await get('/api/services/retwist')
  check('GET /api/services/retwist → 200', oneService.status === 200)
  check('prix du retwist = 20000', Number(oneService.body?.data?.price) === 20000)

  const missing = await get('/api/services/prestation-inexistante')
  check('prestation inconnue → 404', missing.status === 404)

  // ════════ Galerie ════════
  section('Galerie')
  const galleryCategories = await get('/api/gallery/categories')
  check(
    'catégories galerie avec « Toutes »',
    galleryCategories.body?.data?.[0]?.slug === 'all' && galleryCategories.body.data.length === 6,
  )
  const galleryAll = await get('/api/gallery')
  check('GET /api/gallery → 15 réalisations', galleryAll.body?.data?.length === 15)
  const galleryFiltered = await get('/api/gallery?category=coloration')
  check('filtre galerie → 3 réalisations', galleryFiltered.body?.data?.length === 3)

  // ════════ Équipe et avis ════════
  section('Équipe et avis')
  const team = await get('/api/team')
  check('GET /api/team → 4 membres', team.body?.data?.length === 4)
  const reviews = await get('/api/testimonials')
  check('GET /api/testimonials → 6 avis', reviews.body?.data?.length === 6)
  check(
    'note moyenne calculée',
    reviews.body?.meta?.averageRating > 4 && reviews.body?.meta?.averageRating <= 5,
    `reçu ${reviews.body?.meta?.averageRating}`,
  )

  // ════════ Disponibilités ════════
  section('Disponibilités')
  const days = await get('/api/availability/days')
  check('GET /api/availability/days → 200', days.status === 200)
  check('61 jours renvoyés (fenêtre de 60 jours)', days.body?.data?.days?.length === 61)

  const closedDay = days.body?.data?.days?.find((day) => day.weekday === 1)
  check('les lundis sont fermés', closedDay?.bookable === false && closedDay?.reason === 'closed')

  const bookable = days.body?.data?.days?.find((day) => day.bookable)
  check('au moins une date réservable', Boolean(bookable))

  const slots = await get(`/api/availability/slots?date=${bookable.date}`)
  check('GET /api/availability/slots → 6 créneaux', slots.body?.data?.slots?.length === 6)
  const freeSlot = slots.body?.data?.slots?.find((slot) => slot.available)
  check('au moins un créneau libre', Boolean(freeSlot))

  const badDate = await get('/api/availability/slots?date=pas-une-date')
  check('date invalide → 422', badDate.status === 422)

  // ════════ Réservation ════════
  section('Prise de rendez-vous')
  const booking = {
    serviceSlug: 'retwist',
    date: bookable.date,
    time: freeSlot.time,
    firstName: 'Awa',
    lastName: 'Traoré',
    phone: '+225 00 00 00 00',
    email: 'awa.test@exemple.com',
    note: 'Test automatisé',
  }

  const created = await post('/api/appointments', booking)
  check('POST /api/appointments → 201', created.status === 201, JSON.stringify(created.body))
  const reference = created.body?.data?.reference
  check('référence au format BH-XXXXXX', /^BH-[A-Z0-9]{6}$/.test(reference || ''), reference)
  check('durée et prix repris de la prestation', created.body?.data?.durationMinutes === 120)
  check('statut initial « pending »', created.body?.data?.status === 'pending')

  const duplicate = await post('/api/appointments', { ...booking, email: 'autre@exemple.com' })
  check('même créneau une 2ᵉ fois → 409', duplicate.status === 409, `reçu ${duplicate.status}`)
  check('code SLOT_BOOKED', duplicate.body?.error?.code?.startsWith('SLOT'))

  const invalidEmail = await post('/api/appointments', { ...booking, email: 'pas-un-email' })
  check('e-mail invalide → 422', invalidEmail.status === 422)

  const shortName = await post('/api/appointments', { ...booking, firstName: 'A' })
  check('prénom trop court → 422', shortName.status === 422)

  const pastBooking = await post('/api/appointments', { ...booking, date: '2020-01-06' })
  check('date passée → 409', pastBooking.status === 409, `reçu ${pastBooking.status}`)

  const unknownService = await post('/api/appointments', { ...booking, serviceSlug: 'inconnu' })
  check('prestation inconnue → 422', unknownService.status === 422)

  const lookup = await get(`/api/appointments/${reference}`)
  check('GET /api/appointments/:reference → 200', lookup.status === 200)
  check(
    'aucune donnée personnelle sensible exposée',
    lookup.body?.data?.email === undefined && lookup.body?.data?.phone === undefined,
  )

  const unknownRef = await get('/api/appointments/BH-ZZZZZZ')
  check('référence inconnue → 404', unknownRef.status === 404)

  // le créneau n'est plus proposé
  const slotsAfter = await get(`/api/availability/slots?date=${bookable.date}`)
  const takenSlot = slotsAfter.body?.data?.slots?.find((slot) => slot.time === freeSlot.time)
  check('le créneau réservé apparaît comme pris', takenSlot?.available === false)
  check('motif « booked »', takenSlot?.reason === 'booked')

  // ════════ Contact ════════
  section('Formulaire de contact')
  const message = await post('/api/contact', {
    name: 'Awa Traoré',
    email: 'awa.test@exemple.com',
    phone: '+225 00 00 00 00',
    message: 'Bonjour, je souhaite un renseignement sur le retwist.',
  })
  check('POST /api/contact → 201', message.status === 201)
  const messageId = message.body?.data?.id

  const shortMessage = await post('/api/contact', {
    name: 'Awa',
    email: 'awa@exemple.com',
    message: 'court',
  })
  check('message trop court → 422', shortMessage.status === 422)

  // ════════ Authentification ════════
  section('Authentification admin')
  const noToken = await get('/api/admin/services')
  check('route admin sans jeton → 401', noToken.status === 401)

  const badToken = await get('/api/admin/services', { token: 'jeton-bidon' })
  check('jeton invalide → 401', badToken.status === 401)

  const badLogin = await post('/api/admin/auth/login', {
    email: config.admin.email,
    password: 'mauvais-mot-de-passe',
  })
  check('mauvais mot de passe → 401', badLogin.status === 401)
  check(
    'message neutre (pas d’indice sur l’existence du compte)',
    badLogin.body?.error?.message === 'E-mail ou mot de passe incorrect.',
  )

  const login = await post('/api/admin/auth/login', {
    email: config.admin.email,
    password: config.admin.password,
  })
  check('connexion admin → 200', login.status === 200, JSON.stringify(login.body))
  const token = login.body?.data?.token
  check('jeton JWT renvoyé', typeof token === 'string' && token.split('.').length === 3)
  check('mot de passe jamais renvoyé', login.body?.data?.user?.password_hash === undefined)

  const me = await get('/api/admin/auth/me', { token })
  check('GET /api/admin/auth/me → rôle admin', me.body?.data?.role === 'admin')

  // ════════ Admin : rendez-vous ════════
  section('Admin — rendez-vous')
  const stats = await get('/api/admin/stats', { token })
  check('GET /api/admin/stats → compteurs', stats.body?.data?.appointments?.total >= 1)

  const list = await get('/api/admin/appointments', { token })
  check('liste des rendez-vous paginée', Array.isArray(list.body?.data) && list.body?.meta?.page === 1)
  const appointmentId = list.body?.data?.find((item) => item.reference === reference)?.id
  check('le rendez-vous créé est visible', Boolean(appointmentId))
  check(
    'les coordonnées sont visibles côté admin',
    list.body?.data?.[0]?.customer?.email !== undefined,
  )

  const filtered = await get('/api/admin/appointments?status=pending', { token })
  check('filtre par statut', filtered.body?.data?.every((item) => item.status === 'pending'))

  const searched = await get(`/api/admin/appointments?search=${reference}`, { token })
  check('recherche par référence', searched.body?.data?.length === 1)

  const confirmed = await patch(
    `/api/admin/appointments/${appointmentId}/status`,
    { status: 'confirmed', notify: false },
    { token },
  )
  check('passage au statut « confirmed »', confirmed.body?.data?.status === 'confirmed')
  check('date de confirmation enregistrée', Boolean(confirmed.body?.data?.confirmedAt))

  const cancelled = await patch(
    `/api/admin/appointments/${appointmentId}/status`,
    { status: 'cancelled', cancelReason: 'Test automatisé', notify: false },
    { token },
  )
  check('annulation → statut « cancelled »', cancelled.body?.data?.status === 'cancelled')

  const rebooked = await post('/api/appointments', { ...booking, email: 'rebook@exemple.com' })
  check(
    'le créneau est libéré après annulation → 201',
    rebooked.status === 201,
    `reçu ${rebooked.status}`,
  )
  const rebookedRef = rebooked.body?.data?.reference

  // ════════ Admin : contenus ════════
  section('Admin — contenus')
  const newCategory = await post(
    '/api/admin/service-categories',
    { name: 'Catégorie de test', description: 'Temporaire' },
    { token },
  )
  check('création d’une catégorie → 201', newCategory.status === 201)
  const categoryId = newCategory.body?.data?.id
  check('slug généré automatiquement', newCategory.body?.data?.slug === 'categorie-de-test')

  const newService = await post(
    '/api/admin/services',
    {
      categoryId,
      name: 'Prestation de test',
      description: 'Créée par les tests',
      durationMinutes: 45,
      price: 9000,
      isFeatured: false,
    },
    { token },
  )
  check('création d’une prestation → 201', newService.status === 201, JSON.stringify(newService.body))
  const serviceId = newService.body?.data?.id

  const publicSeesIt = await get('/api/services/prestation-de-test')
  check('la prestation est visible publiquement', publicSeesIt.status === 200)

  const patched = await patch(
    `/api/admin/services/${serviceId}`,
    { price: 11000, isActive: false },
    { token },
  )
  check('modification du prix', Number(patched.body?.data?.price) === 11000)
  check('désactivation prise en compte', patched.body?.data?.isActive === false)

  const hiddenNow = await get('/api/services/prestation-de-test')
  check('une prestation désactivée disparaît du site → 404', hiddenNow.status === 404)

  const badCategory = await post(
    '/api/admin/services',
    { categoryId: 99999, name: 'Erreur', durationMinutes: 30, price: 1000 },
    { token },
  )
  check('catégorie inexistante → 422', badCategory.status === 422)

  const newMember = await post(
    '/api/admin/team',
    { name: 'Testeuse', role: 'Loctician', specialty: 'Tests', bio: 'Créée par les tests' },
    { token },
  )
  check('création d’un membre d’équipe → 201', newMember.status === 201)
  const memberId = newMember.body?.data?.id

  const newReview = await post(
    '/api/admin/testimonials',
    { firstName: 'Testeuse', rating: 5, comment: 'Avis créé par les tests automatisés.' },
    { token },
  )
  check('création d’un avis → 201', newReview.status === 201)
  const reviewId = newReview.body?.data?.id

  const badRating = await post(
    '/api/admin/testimonials',
    { firstName: 'Testeuse', rating: 9, comment: 'Note hors limites.' },
    { token },
  )
  check('note > 5 → 422', badRating.status === 422)

  const galleryCategoryId = galleryCategories.body?.data?.[1]?.id
  const newGalleryItem = await post(
    '/api/admin/gallery',
    {
      categoryId: galleryCategoryId,
      title: 'Réalisation de test',
      imageUrl: 'https://example.com/test.jpg',
    },
    { token },
  )
  check('création d’une réalisation → 201', newGalleryItem.status === 201)
  const galleryItemId = newGalleryItem.body?.data?.id

  // ════════ Admin : upload ════════
  section('Admin — upload d’image')
  // PNG 1×1 valide
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const form = new FormData()
  form.append('image', new Blob([pngBytes], { type: 'image/png' }), 'test.png')
  const upload = await call('POST', '/api/admin/uploads', { body: form, raw: true, token })
  check('upload d’une image → 201', upload.status === 201, JSON.stringify(upload.body))
  const uploadedFilename = upload.body?.data?.filename
  check('chemin /uploads renvoyé', upload.body?.data?.path?.startsWith('/uploads/'))

  const fetched = await fetch(`${BASE}${upload.body?.data?.path}`)
  check('l’image est servie en statique', fetched.status === 200)

  const textForm = new FormData()
  textForm.append('image', new Blob(['pas une image'], { type: 'text/plain' }), 'test.txt')
  const badUpload = await call('POST', '/api/admin/uploads', { body: textForm, raw: true, token })
  check('fichier non image refusé → 400', badUpload.status === 400)

  // ════════ Admin : planning ════════
  section('Admin — planning')
  const closure = await post(
    '/api/admin/closures',
    { date: bookable.date, reason: 'Fermeture de test' },
    { token },
  )
  check('ajout d’une fermeture → 201', closure.status === 201)

  const closedSlots = await get(`/api/availability/slots?date=${bookable.date}`)
  check(
    'la journée fermée n’a plus aucun créneau libre',
    closedSlots.body?.data?.bookable === false,
  )
  check(
    'motif « closed_exceptionally »',
    closedSlots.body?.data?.slots?.[0]?.reason === 'closed_exceptionally',
  )

  const closures = await get('/api/admin/closures', { token })
  const closureId = closures.body?.data?.find((item) => item.date === bookable.date)?.id
  await del(`/api/admin/closures/${closureId}`, { token })
  const reopened = await get(`/api/availability/slots?date=${bookable.date}`)
  check('la journée redevient réservable après suppression', reopened.body?.data?.bookable === true)

  const hours = await get('/api/admin/opening-hours', { token })
  check('lecture des horaires admin', hours.body?.data?.length === 7)

  const badHours = await put(
    '/api/admin/opening-hours',
    { hours: [{ weekday: 2, isClosed: false }] },
    { token },
  )
  check('jour ouvert sans horaires → 422', badHours.status === 422)

  // ════════ Admin : messages ════════
  section('Admin — messages de contact')
  const messages = await get('/api/admin/messages', { token })
  check('liste des messages', Array.isArray(messages.body?.data))
  const readMessage = await patch(`/api/admin/messages/${messageId}`, { status: 'read' }, { token })
  check('passage en « lu »', readMessage.body?.data?.status === 'read')
  check('date de lecture enregistrée', Boolean(readMessage.body?.data?.readAt))

  // ════════ Sécurité ════════
  section('Sécurité et robustesse')
  const staffToken = token
  const forbiddenSelfDelete = await del(`/api/admin/auth/users/${me.body?.data?.id}`, {
    token: staffToken,
  })
  check('suppression de son propre compte refusée → 400', forbiddenSelfDelete.status === 400)

  const unknownRoute = await get('/api/nimporte-quoi')
  check('route inconnue → 404', unknownRoute.status === 404)

  const malformed = await fetch(`${BASE}/api/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ceci n est pas du json',
  })
  check('JSON malformé → 400', malformed.status === 400, `reçu ${malformed.status}`)

  const sqlAttempt = await get("/api/services?category=' OR 1=1 --")
  check(
    'tentative d’injection SQL neutralisée',
    sqlAttempt.status === 200 && sqlAttempt.body?.data?.length === 0,
  )

  // ════════ Nettoyage ════════
  section('Nettoyage des données de test')
  await del(`/api/admin/gallery/${galleryItemId}`, { token })
  await del(`/api/admin/testimonials/${reviewId}`, { token })
  await del(`/api/admin/team/${memberId}`, { token })
  await del(`/api/admin/services/${serviceId}`, { token })
  await del(`/api/admin/service-categories/${categoryId}`, { token })
  await del(`/api/admin/messages/${messageId}`, { token })
  if (uploadedFilename) await del(`/api/admin/uploads/${uploadedFilename}`, { token })

  const rebookedId = (await get(`/api/admin/appointments?search=${rebookedRef}`, { token })).body
    ?.data?.[0]?.id
  if (rebookedId) await del(`/api/admin/appointments/${rebookedId}`, { token })
  if (appointmentId) await del(`/api/admin/appointments/${appointmentId}`, { token })

  const finalServices = await get('/api/services')
  check('retour à 17 prestations après nettoyage', finalServices.body?.data?.length === 17)
  const finalGallery = await get('/api/gallery')
  check('retour à 15 réalisations après nettoyage', finalGallery.body?.data?.length === 15)

  // ════════ Résumé ════════
  console.log('\n══════════════════════════════════════')
  console.log(`  ${passed} test(s) réussi(s), ${failed} échec(s)`)
  if (failures.length) {
    console.log('\n  Échecs :')
    failures.forEach((failure) => console.log(`   • ${failure}`))
  }
  console.log('══════════════════════════════════════\n')

  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error('\n❌ Les tests n’ont pas pu s’exécuter :', error.message)
  console.error('   Le serveur est-il démarré ? (npm run dev)')
  process.exit(1)
})
