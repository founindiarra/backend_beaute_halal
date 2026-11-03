import { Router } from 'express'
import { z } from 'zod'

import { defaultCatalogue, getCatalogue, saveCatalogue } from './catalogue.js'
import { execute, query } from '../../config/database.js'
import { ApiError } from '../../lib/ApiError.js'
import { absoluteUrl } from '../../lib/url.js'
import { sendData } from '../../lib/http.js'
import { requireAnyPermission } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'

/*
 * Catalogue tarifaire (types de locks, volumes, prix, délais, états,
 * réparation, consultation) servi au site v3 et modifiable par le salon.
 */

const text = z.string().trim().max(2000)
const soinsBloc = z.object({
  title: z.string().max(160),
  lead: text,
  points: z.array(z.object({ title: z.string().max(160), text })).max(10),
  outro: text,
})
const money = z.number().int().min(0).max(10_000_000)
const image = z.string().trim().max(500)

const lockType = z.object({
  id: z.string().trim().regex(/^[a-z0-9-]{2,40}$/, 'Identifiant : lettres minuscules, chiffres, tirets.'),
  name: z.string().trim().min(2).max(120),
  tagline: text.optional().default(''),
  description: text.optional().default(''),
  size: z.string().trim().max(60).optional().default(''),
  rhythm: z.string().trim().max(120).optional().default(''),
  /** Photo du type (chemin « /uploads/… » ou adresse complète). */
  image: z.string().trim().max(500).nullish(),
  /** { XS: [complet, racines], … } */
  prices: z.record(z.string().max(8), z.tuple([money, money])),
  delais: z.array(
    z.object({
      id: z.string().max(30),
      label: z.string().max(120),
      detail: z.string().max(120).optional().default(''),
      amount: z.number().int().min(-1_000_000).max(1_000_000),
      orMore: z.boolean().optional(),
    }),
  ),
  etats: z.array(
    z.object({
      id: z.string().max(30),
      label: z.string().max(120),
      detail: z.string().max(160).optional().default(''),
      pct: z.number().min(0).max(300),
      orMore: z.boolean().optional(),
    }),
  ),
  repair: z.object({ from: money, text: z.string().trim().max(160) }),
})

const catalogueBody = z
  .object({
    brand: z.object({ tagline: text, intro: text }),
    whatsapp: z.object({ display: z.string().max(40), number: z.string().regex(/^\d{8,15}$/) }),
    /** `image` : photo qui illustre le choix dans le parcours de rendez-vous (chemin « /uploads/… » ou adresse complète). */
    volumes: z.array(z.object({ id: z.string().max(8), label: z.string().max(80), hint: z.string().max(200), image: image.nullish() })).min(1),
    longueurs: z.array(z.object({ label: z.string().max(40), hint: z.string().max(120), image: image.nullish() })),
    /** Photos du site : bannières par page (ordinateur / mobile) et photos de l'accueil du salon (page À propos). */
    media: z
      .object({
        heroes: z.record(z.string().max(20), z.object({ desktop: image.nullish(), mobile: image.nullish(), video: image.nullish(), poster: image.nullish() })).optional(),
        aboutPhotos: z.array(image).max(8).optional(),
      })
      .optional(),
    lockTypes: z.array(lockType).min(1).max(12),
    /** Clientes par jour, par type de locks et par coiffure (0 = sans limite). */
    quotas: z
      .object({
        types: z.record(z.string().max(40), z.coerce.number().int().min(0).max(100)),
        coiffures: z.record(z.string().max(12), z.coerce.number().int().min(0).max(100)),
        /** Besoin et type vides = « tous ». Ex. : { besoin: 'creation', type: 'micro', limit: 1 } ; { besoin: '', type: '', limit: 5 } = 5 clientes par jour au total. */
        rules: z
          .array(z.object({ besoin: z.enum(['', 'creation', 'resserrage', 'reparation']), type: z.string().max(40), limit: z.coerce.number().int().min(1).max(100) }))
          .max(40)
          .optional(),
      })
      .optional(),
    formules: z
      .array(
        z.object({
          id: z.string().max(20),
          label: z.string().max(80),
          short: z.string().max(40),
          detail: z.string().max(60),
          index: z.number().int().min(-1).max(1),
          help: z.string().max(400),
        }),
      )
      .min(1),
    besoins: z.array(z.object({ id: z.string().max(20), name: z.string().max(60), text: text, note: text })),
    prestations: z.array(z.object({ id: z.string().max(20), name: z.string().max(80), description: text })),
    /** Niveaux de réparation : prix « à partir de » de la partielle et de la globale. */
    /** Textes et règles du site (page « Textes et règles du site ») : objet libre, borné en taille. */
    site: z
      .record(z.string(), z.any())
      .refine((v) => JSON.stringify(v).length <= 60_000, { message: 'Textes du site trop volumineux.' })
      .optional(),
    /** Fourchettes de prix d'installation, par type de locks et méthode (min/max en FCFA, ou une note : « Sur demande »…). */
    installations: z
      .array(
        z.object({
          id: z.string().max(30),
          title: z.string().max(80),
          size: z.string().max(40).optional().default(''),
          methods: z.array(z.object({ name: z.string().max(80), min: money.nullish(), max: money.nullish(), note: z.string().max(60).optional().default('') })).max(12),
        }),
      )
      .max(12)
      .optional(),
    reparations: z.array(z.object({ id: z.string().max(20), name: z.string().max(80), from: money, text })).optional(),
    engagement: text,
    consultation: z.object({ nouvelle: text, ancienne: text, final: text }),
    videoAdvice: text,
    goodToKnow: z.array(z.object({ title: z.string().max(120), text: text })),
    soins: z
      .object({
        propose: z.object({ title: z.string().max(160), text, faireLabel: z.string().max(120), faireHint: z.string().max(200), ignorerLabel: z.string().max(120), ignorerHint: z.string().max(200), ignoreeMessage: text }),
        locks: z.object({ title: z.string().max(160), text, ouiLabel: z.string().max(120), ouiHint: z.string().max(200), nonLabel: z.string().max(120), nonHint: z.string().max(200) }),
        modes: z.object({ title: z.string().max(160), telephoneLabel: z.string().max(120).optional(), telephoneHint: z.string().max(200).optional(), whatsappLabel: z.string().max(120), whatsappHint: z.string().max(200), placeLabel: z.string().max(120), placeHint: z.string().max(200), confirmation: text }),
        etapes: z.record(z.string().max(20), z.object({ label: z.string().max(40), title: z.string().max(160), intro: text })).optional(),
        avecLocks: soinsBloc,
        sansLocks: soinsBloc,
      })
      .optional(),
  })
  .passthrough()

// ══════════════ Public ══════════════
export const publicRouter = Router()

publicRouter.get('/tarifs', async (_request, response) => {
  response.set('Cache-Control', 'public, max-age=300')
  const catalogue = await getCatalogue()
  // Le site a besoin d'adresses complètes pour les photos des types.
  catalogue.lockTypes = catalogue.lockTypes.map((t) => ({ ...t, image: absoluteUrl(t.image) }))
  catalogue.volumes = catalogue.volumes.map((v) => ({ ...v, image: absoluteUrl(v.image) }))
  catalogue.longueurs = catalogue.longueurs.map((l) => ({ ...l, image: absoluteUrl(l.image) }))
  if (catalogue.media) {
    const heroes = {}
    for (const [page, h] of Object.entries(catalogue.media.heroes ?? {})) {
      heroes[page] = { desktop: absoluteUrl(h?.desktop), mobile: absoluteUrl(h?.mobile), video: absoluteUrl(h?.video), poster: absoluteUrl(h?.poster) }
    }
    catalogue.media = { heroes, aboutPhotos: (catalogue.media.aboutPhotos ?? []).map(absoluteUrl).filter(Boolean) }
  }
  // Photos des soins (shampooings…) : réglées depuis « Textes et règles du site », renvoyées en adresse complète.
  const soins = catalogue.site?.detailsCoiffure?.soins
  if (Array.isArray(soins)) {
    catalogue.site.detailsCoiffure.soins = soins.map((s) => (s && typeof s === 'object' ? { ...s, image: absoluteUrl(s.image) || '' } : s))
  }
  return sendData(response, catalogue)
})

// ══════════════ Admin ══════════════
export const adminRouter = Router()
/*
 * Le catalogue est un seul objet, édité par quatre écrans : Tarifs, Soins capillaires (étapes), Textes et règles,
 * Images des pages. Chacun a son droit ; la lecture est ouverte aux quatre, et l'ÉCRITURE est contrôlée section par
 * section (ce qui change réellement) : un agent « Textes » ne peut pas modifier les prix, ni l'inverse.
 */
const DROITS_CATALOGUE = ['tarifs', 'soins', 'site_texts', 'site_photos']
adminRouter.use('/tarifs', requireAnyPermission(...DROITS_CATALOGUE))

/** Forme canonique pour comparer deux catalogues : clés triées, null / undefined ignorés. */
const canonique = (valeur) => {
  if (Array.isArray(valeur)) return valeur.map(canonique)
  if (valeur && typeof valeur === 'object') {
    return Object.fromEntries(
      Object.keys(valeur).sort().filter((k) => valeur[k] !== null && valeur[k] !== undefined).map((k) => [k, canonique(valeur[k])]),
    )
  }
  return valeur
}
const different = (a, b) => JSON.stringify(canonique(a ?? null)) !== JSON.stringify(canonique(b ?? null))

adminRouter.get('/tarifs', async (_request, response) => sendData(response, await getCatalogue()))

adminRouter.put('/tarifs', validate({ body: catalogueBody }), async (request, response) => {
  const droits = request.user?.permissions ?? []
  const actuel = await getCatalogue()
  const touche = Object.keys(request.body).filter((cle) => different(actuel[cle], request.body[cle]))
  const manque = (droit) => !droits.includes(droit)
  const refus = (droit, quoi) => {
    throw ApiError.forbidden(`Votre compte ne peut pas modifier ${quoi}.`, { code: 'MISSING_PERMISSION', details: { permission: droit } })
  }
  if (touche.includes('media') && manque('site_photos')) refus('site_photos', 'les images des pages')
  if (touche.includes('site') && manque('site_texts')) refus('site_texts', 'les textes et règles du site')
  const autres = touche.filter((cle) => !['media', 'site'].includes(cle))
  if (autres.length && manque('tarifs') && manque('soins')) refus('tarifs', 'les tarifs et les étapes du site')
  return sendData(response, await saveCatalogue(request.body))
})

/** Remet la grille des documents du salon (utile après une fausse manœuvre). */
adminRouter.post('/tarifs/reset', async (_request, response) => {
  // Les photos et textes des types de locks (page Catégories) ne sont pas des tarifs : on les garde.
  const actuel = await getCatalogue()
  const neuf = defaultCatalogue()
  // Photos et coiffures du site : ce ne sont pas des tarifs, on les garde aussi.
  const garderImages = (liste, cle, nouvelle) =>
    nouvelle.map((n) => ({ ...n, image: liste.find((a) => a[cle] === n[cle])?.image ?? n.image ?? null }))
  neuf.volumes = garderImages(actuel.volumes ?? [], 'id', neuf.volumes)
  neuf.longueurs = garderImages(actuel.longueurs ?? [], 'label', neuf.longueurs)
  if (actuel.media) neuf.media = actuel.media
  // Les places par jour ne sont pas des tarifs : on les garde.
  if (actuel.quotas) neuf.quotas = actuel.quotas
  neuf.lockTypes = neuf.lockTypes.map((t) => {
    const ancien = actuel.lockTypes.find((a) => a.id === t.id)
    return ancien
      ? {
          ...t,
          name: ancien.name,
          tagline: ancien.tagline,
          description: ancien.description,
          size: ancien.size,
          rhythm: ancien.rhythm,
          image: ancien.image ?? null,
        }
      : t
  })
  return sendData(response, await saveCatalogue(neuf))
})

/* ═══════════════ Types de locks — la page « Catégories » du dashboard ═══════════════ */

const typeBody = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  tagline: z.string().trim().max(160).optional(),
  description: text.optional(),
  size: z.string().trim().max(60).optional(),
  rhythm: z.string().trim().max(120).optional(),
  image: z.string().trim().max(500).nullish(),
})

const serializeType = (type, categorie) => ({
  id: type.id,
  name: type.name,
  tagline: type.tagline ?? '',
  description: type.description ?? '',
  size: type.size ?? '',
  rhythm: type.rhythm ?? '',
  image: type.image ?? null,
  imageUrl: absoluteUrl(type.image),
  categoryId: categorie?.id ?? null,
  /** Prix le plus bas de la grille : indicatif, il se règle dans « Tarifs du site ». */
  fromPrice: (() => {
    const montants = Object.values(type.prices ?? {}).flat().filter((n) => Number(n) > 0)
    return montants.length ? Math.min(...montants) : null
  })(),
})

const categoriesParSlug = async () =>
  new Map((await query('SELECT id, slug FROM service_categories')).map((c) => [c.slug, c]))

/** GET /admin/lock-types — les trois types, avec l'identifiant de catégorie à utiliser pour les prestations. */
adminRouter.get('/lock-types', async (_request, response) => {
  const [catalogue, categories] = await Promise.all([getCatalogue(), categoriesParSlug()])
  return sendData(
    response,
    catalogue.lockTypes.map((t) => serializeType(t, categories.get(t.id))),
  )
})

/**
 * PATCH /admin/lock-types/:id — modifie les informations et la photo d'un type.
 * Le nom et la description sont aussi reportés sur la catégorie de même
 * identifiant, pour que les anciens écrans et les prestations restent cohérents.
 */
adminRouter.patch('/lock-types/:id', validate({ body: typeBody }), async (request, response) => {
  const catalogue = await getCatalogue()
  const index = catalogue.lockTypes.findIndex((t) => t.id === request.params.id)
  if (index < 0) throw ApiError.notFound('Ce type de locks n’existe pas.')

  const type = catalogue.lockTypes[index]
  for (const cle of ['name', 'tagline', 'description', 'size', 'rhythm']) {
    if (request.body[cle] !== undefined) type[cle] = request.body[cle]
  }
  if (request.body.image !== undefined) type.image = request.body.image || null

  await saveCatalogue(catalogue)
  await execute('UPDATE service_categories SET name = ?, description = ? WHERE slug = ?', [
    type.name,
    type.description || null,
    type.id,
  ])

  const categories = await categoriesParSlug()
  return sendData(response, serializeType(type, categories.get(type.id)))
})
