import { execute, queryOne } from '../../config/database.js'
import * as defaults from './defaults.js'

/**
 * Le catalogue tarifaire : types de locks, volumes, prix, délais, états,
 * réparation, consultation. Une seule ligne JSON dans `pricing_catalogue`.
 *
 * Tant que la ligne n'existe pas, le serveur la crée à partir de la grille des
 * documents du salon (defaults.js) : la migration suffit, aucun seed n'est requis.
 */

export function defaultCatalogue() {
  return JSON.parse(
    JSON.stringify({
      brand: { tagline: defaults.BRAND_TAGLINE, intro: defaults.BRAND_INTRO },
      whatsapp: defaults.WHATSAPP,
      volumes: defaults.VOLUMES,
      longueurs: defaults.LONGUEURS,
      lockTypes: defaults.LOCK_TYPES,
      formules: defaults.FORMULES,
      besoins: defaults.BESOINS,
      prestations: defaults.PRESTATIONS,
      reparations: defaults.REPARATIONS,
      installations: defaults.INSTALLATIONS,
      /** Clientes par jour : { types: { idType: n }, coiffures: { idPrestation: n } }. Absent ou 0 = sans limite. */
      quotas: { types: {}, coiffures: {}, rules: [] },
      site: defaults.SITE,
      engagement: defaults.engagement,
      consultation: defaults.consultation,
      videoAdvice: defaults.videoAdvice,
      goodToKnow: defaults.goodToKnow,
      soins: defaults.soins,
    }),
  )
}

/**
 * Met à jour, À LA LECTURE et sans rien écrire en base, les libellés qui ont changé : Installation de locks,
 * réparation comme troisième besoin, tailles en centimètres. Une valeur n'est remplacée que si elle est encore
 * celle d'origine : tout ce que le salon a modifié lui-même dans le dashboard est conservé.
 */
const ANCIEN_VERS_NOUVEAU = {
  sizes: { traditionnels: ['1 cm à 1,5 cm', 'À partir de 1 cm'], small: ['0,4 cm à 0,8 cm', '0,6 cm à 0,8 cm'], micro: ['0,1 cm à 0,4 cm', '0,2 cm à 0,4 cm'] },
}
export function upgradeCatalogue(data) {
  const sortie = JSON.parse(JSON.stringify(data))
  const neuf = defaultCatalogue()
  for (const t of sortie.lockTypes ?? []) {
    const [ancien, nouveau] = ANCIEN_VERS_NOUVEAU.sizes[t.id] ?? []
    if (ancien && t.size === ancien) t.size = nouveau
  }
  const remplacerSiAncien = (liste, defauts, cles) => {
    for (const element of liste ?? []) {
      const reference = defauts.find((d) => d.id === element.id)
      if (!reference) continue
      for (const cle of cles) {
        const anciens = ANCIENS_TEXTES[element.id]?.[cle] ?? []
        // Comparaison tolérante : majuscules, apostrophes typographiques et espaces (insécables compris) ne comptent pas.
        if (typeof element[cle] === 'string' && anciens.some((a) => normaliser(a) === normaliser(element[cle]))) element[cle] = reference[cle]
      }
    }
  }
  remplacerSiAncien(sortie.besoins, neuf.besoins, ['name', 'text', 'note'])
  remplacerSiAncien(sortie.prestations, neuf.prestations, ['name', 'description'])
  if (Array.isArray(sortie.besoins) && !sortie.besoins.some((b) => b.id === 'reparation')) {
    sortie.besoins.push(neuf.besoins.find((b) => b.id === 'reparation'))
  }
  // Catalogue enregistré avant les deux niveaux de réparation : on complète avec les prix d'origine (rien n'est écrit en base).
  if (!Array.isArray(sortie.reparations) || !sortie.reparations.length) sortie.reparations = neuf.reparations
  // Fourchettes d'installation (ajoutées après l'enregistrement du catalogue) : valeurs d'origine tant que le salon n'en a pas.
  if (!Array.isArray(sortie.installations) || !sortie.installations.length) sortie.installations = neuf.installations
  // Places par jour (ajoutées après l'enregistrement du catalogue) : sans limite tant que le salon n'en fixe pas.
  sortie.quotas = { types: sortie.quotas?.types ?? {}, coiffures: sortie.quotas?.coiffures ?? {}, rules: Array.isArray(sortie.quotas?.rules) ? sortie.quotas.rules : [] }
  // Textes et règles du site : on ne complète que ce qui manque, jamais ce que le salon a écrit.
  sortie.site = completer(sortie.site, neuf.site)
  return sortie
}
/** Complète `valeur` avec les clés absentes de `defaut` (récursif, objets seulement ; tableaux et textes du salon intacts). */
export function completer(valeur, defaut) {
  if (valeur === undefined || valeur === null) return JSON.parse(JSON.stringify(defaut))
  if (defaut && typeof defaut === 'object' && !Array.isArray(defaut) && typeof valeur === 'object' && !Array.isArray(valeur)) {
    for (const cle of Object.keys(defaut)) valeur[cle] = completer(valeur[cle], defaut[cle])
  }
  return valeur
}
const normaliser = (texte) => String(texte ?? '').replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()
const ANCIENS_TEXTES = {
  creation: {
    name: ['Création complète'],
    note: ['Le tarif d’une création est annoncé par le salon après diagnostic.'],
    text: ['Vous démarrez vos locks : le salon évalue avec vous le type, le volume et la longueur.', 'Micro-locks et small locks.\nVous démarrez vos locks : le salon évalue avec vous le type, le volume et la longueur.', 'Locks, micro-locks et small locks.\nVous démarrez vos locks : le salon évalue avec vous le type, le volume et la longueur.'],
    description: ['Création de vos locks de A à Z, dans le type choisi (traditionnels, small ou micro-locks).'],
  },
  resserrage: { text: ['Vous avez déjà des locks : resserrage complet, reprise de racines ou réparation.'] },
  reparation: { description: ['Remise en état des locks abîmées ou cassées : tarif indicatif selon l’ampleur des dégâts.'] },
}

export async function getCatalogue() {
  const row = await queryOne('SELECT data, updated_at FROM pricing_catalogue WHERE id = 1')
  if (row) {
    try {
      const data = JSON.parse(row.data)
      // Catalogue enregistré avant l'ajout des étapes de soin : on complète avec le texte d'origine.
      data.soins ??= JSON.parse(JSON.stringify(defaults.soins))
      data.soins.etapes ??= JSON.parse(JSON.stringify(defaults.soins.etapes))
      // Étape « Méthode » (ajoutée après l'enregistrement du catalogue) : texte d'origine tant que le salon n'en a pas.
      data.soins.etapes.methode ??= defaults.soins.etapes.methode
      return { ...upgradeCatalogue(data), updatedAt: row.updated_at }
    } catch {
      // JSON corrompu : on retombe sur la grille par défaut plutôt que de casser le site.
    }
  }
  const data = defaultCatalogue()
  await execute(
    'INSERT INTO pricing_catalogue (id, data) VALUES (1, ?) ON DUPLICATE KEY UPDATE id = id',
    [JSON.stringify(data)],
  )
  return { ...data, updatedAt: null }
}

export async function saveCatalogue(data) {
  const { updatedAt: _ignored, ...clean } = data
  await execute(
    `INSERT INTO pricing_catalogue (id, data) VALUES (1, ?)
     ON DUPLICATE KEY UPDATE data = VALUES(data)`,
    [JSON.stringify(clean)],
  )
  return getCatalogue()
}

export const findType = (catalogue, id) => catalogue.lockTypes.find((t) => t.id === id) ?? null
export const findVolume = (catalogue, id) => catalogue.volumes.find((v) => v.id === id) ?? null
export const findFormule = (catalogue, id) => catalogue.formules.find((f) => f.id === id) ?? null

/** Tarif de base (FCFA) ou null si la combinaison est incomplète. */
export function tarifFor(catalogue, type, volume, formule, reparation = '') {
  const t = findType(catalogue, type)
  const f = findFormule(catalogue, formule)
  if (!t || !f) return null
  if (f.id === 'reparation') {
    // Le prix dépend du niveau de réparation (partielle / globale) ; sans niveau (ancien site), le tarif du type.
    if (reparation) return catalogue.reparations?.find((x) => x.id === reparation)?.from ?? null
    return t.repair.from
  }
  const row = t.prices?.[volume]
  return row ? (row[f.index] ?? null) : null
}

/**
 * Estimation indicative : base ± ajustement de délai, puis majoration d'état
 * (% du tarif de base). `partial` = « et plus » : le montant est un minimum.
 * Même règle que le site v3 — mais calculée ICI, jamais reprise du navigateur.
 */
export function estimate(catalogue, { type, volume, formule, delai, etat, reparation = '' }) {
  const base = tarifFor(catalogue, type, volume, formule, reparation)
  if (base === null) return null
  const t = findType(catalogue, type)
  if (formule === 'reparation') return { base, delta: 0, majoration: 0, total: base, partial: true }
  const d = t.delais?.find((x) => x.id === delai)
  const e = t.etats?.find((x) => x.id === etat)
  const delta = d?.amount ?? 0
  const majoration = Math.round((base * (e?.pct ?? 0)) / 100)
  return {
    base,
    delta,
    majoration,
    total: base + delta + majoration,
    partial: Boolean(d?.orMore || e?.orMore),
  }
}
