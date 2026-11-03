import { query } from '../../config/database.js'
import { getCatalogue } from '../tarifs/catalogue.js'

/**
 * Places par jour, par type de locks et par coiffure.
 *
 * Le salon fixe (« Tarifs du site » → « Clientes par jour ») combien de clientes il prend au plus chaque jour pour un
 * type de locks, et/ou pour une coiffure précise. 0 ou rien = sans limite. Quand le quota d'un jour est atteint, ce
 * jour est fermé (grisé) pour les nouvelles demandes de ce type / de cette coiffure ; le calendrier du site indique
 * combien de places restent.
 *
 * Ce qui compte : les demandes du site qui visent une prestation ce jour-là (en attente, contactées, confirmées,
 * terminées). Ne comptent pas : annulées, refusées, consultations seules, demandes qui attendent un paiement depuis
 * plus de 30 minutes. Une consultation suivie d'une prestation compte pour le jour de la PRESTATION.
 * Les rendez-vous saisis au salon (comptoir) comptent aussi, avec la même règle (le salon peut passer outre en confirmant).
 */

const JOUR = "CASE WHEN br.service_date IS NOT NULL THEN br.service_date ELSE br.desired_date END"

const cle = (valeur) => String(valeur instanceof Date ? valeur.toISOString() : valeur).slice(0, 10)

/** Besoin « effectif » d'une demande : la réparation est enregistrée comme un resserrage de formule « reparation ». */
const BESOIN = "CASE WHEN br.formule = 'reparation' THEN 'reparation' ELSE br.besoin END"

/** Quotas du salon : { types: Map, coiffures: Map, rules: [{ besoin, type, limit }] } (limites > 0 seulement). */
export async function loadQuotas() {
  let brut = {}
  try {
    brut = (await getCatalogue())?.quotas ?? {}
  } catch {
    brut = {}
  }
  const vers = (objet) => new Map(Object.entries(objet ?? {}).map(([k, v]) => [String(k), Number(v)]).filter(([, v]) => Number.isFinite(v) && v > 0))
  const rules = (Array.isArray(brut.rules) ? brut.rules : [])
    .map((r) => ({ besoin: String(r?.besoin ?? ''), type: String(r?.type ?? ''), limit: Number(r?.limit) }))
    .filter((r) => Number.isFinite(r.limit) && r.limit > 0)
  return { types: vers(brut.types), coiffures: vers(brut.coiffures), rules }
}

/** Demandes comptées sur une plage : Map(jour → { types, coiffures, rows: [{ besoin, type, n }] }). */
export async function loadUsage(fromKey, toKey, { excludeRequestId = null, excludeAppointmentId = null } = {}) {
  const rows = await query(
    `SELECT ${JOUR} AS jour, br.lock_type, br.inspiration_id, ${BESOIN} AS besoin, COUNT(*) AS n
     FROM booking_requests br
     WHERE br.status IN ('pending', 'contacted', 'confirmed', 'completed')
       AND (br.awaiting_payment = 0 OR br.created_at > NOW() - INTERVAL 30 MINUTE)
       AND NOT (br.consultation_mode IS NOT NULL AND br.consultation_mode <> 'ignoree' AND br.service_date IS NULL)
       AND ${JOUR} BETWEEN ? AND ?
       ${excludeRequestId ? 'AND br.id <> ?' : ''}
     GROUP BY jour, br.lock_type, br.inspiration_id, besoin`,
    [fromKey, toKey, ...(excludeRequestId ? [Number(excludeRequestId)] : [])],
  )
  /* Rendez-vous pris au salon (comptoir) : comptés aussi. Leur besoin et leur type ne sont pas connus (seules les règles « tous » et la coiffure s'y appliquent). */
  const comptoir = await query(
    `SELECT a.appointment_date AS jour, a.service_id, COUNT(*) AS n
     FROM appointments a
     WHERE a.source = 'comptoir'
       AND a.status IN ('pending', 'contacted', 'confirmed', 'arrived', 'in_progress', 'completed')
       AND a.appointment_date BETWEEN ? AND ?
       ${excludeAppointmentId ? 'AND a.id <> ?' : ''}
     GROUP BY jour, a.service_id`,
    [fromKey, toKey, ...(excludeAppointmentId ? [Number(excludeAppointmentId)] : [])],
  )
  const parJour = new Map()
  for (const row of comptoir) {
    const jour = cle(row.jour)
    if (!parJour.has(jour)) parJour.set(jour, { types: new Map(), coiffures: new Map(), rows: [] })
    const entree = parJour.get(jour)
    const n = Number(row.n)
    if (row.service_id) entree.coiffures.set(String(row.service_id), (entree.coiffures.get(String(row.service_id)) ?? 0) + n)
    entree.rows.push({ besoin: '', type: '', n })
  }
  for (const row of rows) {
    const jour = cle(row.jour)
    if (!parJour.has(jour)) parJour.set(jour, { types: new Map(), coiffures: new Map(), rows: [] })
    const entree = parJour.get(jour)
    const n = Number(row.n)
    const type = row.lock_type && row.lock_type !== 'inconnu' ? row.lock_type : ''
    if (type) entree.types.set(type, (entree.types.get(type) ?? 0) + n)
    if (row.inspiration_id) entree.coiffures.set(String(row.inspiration_id), (entree.coiffures.get(String(row.inspiration_id)) ?? 0) + n)
    entree.rows.push({ besoin: row.besoin ?? '', type, n })
  }
  return parJour
}

const VIDE = { types: new Map(), coiffures: new Map(), rows: [] }

/** Une règle (besoin / type, vides = « tous ») s'applique-t-elle à ce choix ? Besoin ou type inconnu : seules les règles « tous » s'appliquent. */
const concerne = (regle, besoin, type) => (!regle.besoin || regle.besoin === besoin) && (!regle.type || regle.type === type)
/** Une règle concerne-t-elle une demande déjà enregistrée (ligne d'usage) ? */
const compte = (regle, ligne) => concerne(regle, ligne.besoin, ligne.type)

/** Libellé court d'une règle : « Installation · Micro-locks », « Toutes les prestations »… */
export const BESOINS = { creation: 'Installation', resserrage: 'Resserrage', reparation: 'Réparation' }

/**
 * Places d'un jour pour un choix (type, coiffure, besoin) : TOUTES les limites qui le concernent sont examinées,
 * la plus serrée l'emporte.
 * @returns {{ limit: number, used: number, remaining: number, by: 'type'|'coiffure'|'regle', rule?: object } | null} null = aucune limite applicable
 */
export function quotaForDay(jour, { type = null, coiffureId = null, besoin = null } = {}, quotas, usage) {
  const prises = usage.get(jour) ?? VIDE
  const candidats = []
  const limiteType = type ? quotas.types.get(String(type)) : null
  if (limiteType) candidats.push({ limit: limiteType, used: prises.types.get(String(type)) ?? 0, by: 'type' })
  const limiteCoiffure = coiffureId ? quotas.coiffures.get(String(coiffureId)) : null
  if (limiteCoiffure) candidats.push({ limit: limiteCoiffure, used: prises.coiffures.get(String(coiffureId)) ?? 0, by: 'coiffure' })
  for (const regle of quotas.rules ?? []) {
    if (!concerne(regle, besoin ?? '', type ?? '')) continue
    const used = prises.rows.filter((ligne) => compte(regle, ligne)).reduce((somme, ligne) => somme + ligne.n, 0)
    candidats.push({ limit: regle.limit, used, by: 'regle', rule: regle })
  }
  if (!candidats.length) return null
  return candidats.map((c) => ({ ...c, remaining: Math.max(c.limit - c.used, 0) })).sort((a, b) => a.remaining - b.remaining)[0]
}

const nomRegle = (r) =>
  !r.besoin && !r.type ? 'toutes les prestations' : [BESOINS[r.besoin], r.type ? `type « ${r.type} »` : null].filter(Boolean).join(' · ').toLowerCase()

/** Refuse une demande si le quota du jour est atteint. `{ ok: true }` sinon. */
export async function assertDayQuota(jour, { type = null, coiffureId = null, besoin = null, excludeRequestId = null, excludeAppointmentId = null } = {}) {
  if (!jour) return { ok: true }
  const quotas = await loadQuotas()
  if (!quotas.types.size && !quotas.coiffures.size && !quotas.rules.length) return { ok: true }
  const usage = await loadUsage(jour, jour, { excludeRequestId, excludeAppointmentId })
  const q = quotaForDay(jour, { type, coiffureId, besoin }, quotas, usage)
  if (!q || q.remaining > 0) return { ok: true, quota: q }
  return {
    ok: false,
    reason: 'quota_full',
    message:
      q.by === 'coiffure'
        ? 'Cette coiffure n’a plus de place ce jour-là : choisissez un autre jour.'
        : q.by === 'regle'
          ? 'Le nombre de clientes prévu ce jour-là est atteint pour ce choix de prestation : choisissez un autre jour.'
          : 'Le salon a atteint le nombre de clientes prévu ce jour-là pour ce type de locks : choisissez un autre jour.',
  }
}

/** Vue salon : pour chaque jour de la plage, places prises / limite (types, coiffures, règles besoin / combinaison / total). */
export async function getQuotaOverview(fromKey, toKey) {
  const quotas = await loadQuotas()
  const usage = await loadUsage(fromKey, toKey)
  const jours = []
  let curseur = new Date(`${fromKey}T00:00:00Z`)
  const fin = new Date(`${toKey}T00:00:00Z`)
  while (curseur <= fin && jours.length < 62) {
    const jour = curseur.toISOString().slice(0, 10)
    const prises = usage.get(jour) ?? VIDE
    jours.push({
      date: jour,
      types: Object.fromEntries([...new Set([...quotas.types.keys(), ...prises.types.keys()])].map((t) => [t, { used: prises.types.get(t) ?? 0, limit: quotas.types.get(t) ?? 0 }])),
      coiffures: Object.fromEntries([...quotas.coiffures.keys()].map((c) => [c, { used: prises.coiffures.get(c) ?? 0, limit: quotas.coiffures.get(c) ?? 0 }])),
      rules: quotas.rules.map((regle, index) => ({
        index,
        besoin: regle.besoin,
        type: regle.type,
        label: nomRegle(regle),
        limit: regle.limit,
        used: prises.rows.filter((ligne) => compte(regle, ligne)).reduce((somme, ligne) => somme + ligne.n, 0),
      })),
    })
    curseur = new Date(curseur.getTime() + 86400000)
  }
  return jours
}
