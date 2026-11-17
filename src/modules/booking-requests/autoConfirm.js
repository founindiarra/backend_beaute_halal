import { execute, pool } from '../../config/database.js'
import { assertSlotBookable } from '../availability/service.js'
import { logEvent } from '../operations/model.js'

/**
 * Confirmation AUTOMATIQUE d'un rendez-vous dont la consultation vient d'être payée.
 *
 * Règle : paiement de la consultation confirmé par Jèko (webhook signé ou vérification serveur à serveur)
 *         ⇒ rendez-vous « confirmé », sans action de l'administratrice.
 * Rien ici ne lit le navigateur : cette logique n'est appelée que par `finaliserDemande`, elle-même déclenchée
 * uniquement par `confirmerPaiement` (payments/service.js), seul endroit qui marque un paiement réussi.
 *
 * La confirmation n'a lieu que si TOUT est vrai :
 *   1. la demande est bien payée (payment_status = paid) ;
 *   2. le montant et la devise annoncés par Jèko correspondent aux frais attendus ;
 *   3. la demande n'est ni refusée ni annulée ;
 *   4. la cliente a choisi un jour ET une heure (consultation sur place, ou créneau du soin) ;
 *   5. ce créneau est encore disponible (mêmes règles que la réservation : horaires, fermetures, agents, capacité).
 * Sinon le paiement reste enregistré, le rendez-vous reste « en attente » et le cas est signalé « à régulariser »
 * (historique du rendez-vous + e-mail au salon) : jamais de confirmation silencieuse d'un rendez-vous impossible.
 */

export const RAISONS = {
  non_paye: 'La demande n’est pas marquée payée.',
  montant: 'Le montant ou la devise annoncés par Jèko ne correspondent pas aux frais de consultation attendus.',
  demande_annulee: 'La demande avait été refusée ou annulée avant l’arrivée du paiement.',
  sans_creneau: 'La cliente n’a pas choisi de jour et d’heure : le salon doit convenir du rendez-vous avec elle.',
  creneau_indisponible: 'Le créneau choisi n’est plus disponible.',
}
/** Raisons qui demandent une action du salon (alerte) — « sans_creneau » est un cas normal (téléphone / WhatsApp). */
export const A_REGULARISER = new Set(['montant', 'demande_annulee', 'creneau_indisponible'])

const cleDate = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10))
const cleHeure = (v) => (v ? String(v).slice(0, 8).padEnd(8, ':00').slice(0, 8) : '')

/** Jour et heure réellement choisis par la cliente, ou null. */
export function creneauChoisi(ligne) {
  if (['telephone', 'whatsapp'].includes(ligne.consultation_mode)) return null
  const date = cleDate(ligne.consultation_date || ligne.desired_date)
  const time = cleHeure(ligne.consultation_time || ligne.desired_time)
  return date && time ? { date, time } : null
}

/** Frais attendus et annoncés : en FCFA ou en centimes ; devise absente tolérée, devise annoncée contrôlée. */
export function controlerPaiement({ montant = null, devise = null, attendu = null }) {
  const devises = ['XOF', 'FCFA', 'CFA']
  if (devise && !devises.includes(String(devise).toUpperCase())) return { ok: false, motif: `devise ${devise}` }
  if (montant === null || montant === undefined) return { ok: true, motif: null }
  if (!attendu) return { ok: true, motif: null }
  const bon = [Number(attendu), Number(attendu) * 100].includes(Number(montant))
  return bon ? { ok: true, motif: null } : { ok: false, motif: `montant ${montant} au lieu de ${attendu}` }
}

/**
 * Décide si la confirmation automatique est permise, SANS rien modifier.
 * @returns {Promise<{ confirmer: boolean, raison: string|null, creneau: {date:string,time:string}|null }>}
 */
export async function decider(ligne, controle = { ok: true }, { sansPaiement = false } = {}) {
  const creneau = creneauChoisi(ligne)
  // Rendez-vous pris au comptoir : aucun paiement d'avance, les autres contrôles (créneau libre, demande valide) restent les mêmes.
  if (!sansPaiement) {
    if (ligne.payment_status !== 'paid') return { confirmer: false, raison: 'non_paye', creneau }
    if (controle?.ok === false) return { confirmer: false, raison: 'montant', creneau }
  }
  if (['rejected', 'cancelled'].includes(ligne.status)) return { confirmer: false, raison: 'demande_annulee', creneau }
  if (!creneau) return { confirmer: false, raison: 'sans_creneau', creneau }
  const libre = await assertSlotBookable(creneau.date, creneau.time, { excludeRequestId: ligne.id })
  if (!libre.ok) return { confirmer: false, raison: 'creneau_indisponible', creneau }
  return { confirmer: true, raison: null, creneau }
}

/**
 * Sérialise les décisions portant sur UN MÊME créneau (verrou MySQL nommé, par date + heure) : deux paiements reçus
 * en même temps pour la dernière place ne peuvent pas être confirmés tous les deux.
 * `fn(verrouObtenu)` : si le verrou n'a pas pu être pris à temps, `verrouObtenu` vaut false et on ne confirme pas.
 */
export async function avecVerrouCreneau(creneau, fn) {
  if (!creneau) return fn(true)
  const nom = `bh_slot_${creneau.date}_${creneau.time.slice(0, 5)}`
  const connexion = await pool.getConnection()
  let obtenu = false
  try {
    const [[ligne]] = await connexion.query('SELECT GET_LOCK(?, 8) AS ok', [nom])
    obtenu = Number(ligne?.ok) === 1
    return await fn(obtenu)
  } finally {
    try { if (obtenu) await connexion.query('SELECT RELEASE_LOCK(?)', [nom]) } catch { /* la connexion libère le verrou en se fermant */ }
    connexion.release()
  }
}

/**
 * Passe le rendez-vous (créé « en attente ») et sa demande à « confirmé », à l'heure choisie.
 * Atomique et rejouable : la mise à jour exige `status = 'pending'`, donc une seconde exécution ne fait rien.
 * @returns {Promise<'confirme'|'deja'|'creneau_pris'>}
 */
export async function confirmerRendezVous({ appointmentId, ligne, creneau, dureeMinutes }) {
  try {
    const r = await execute(
      `UPDATE appointments
          SET appointment_date = ?, appointment_time = ?, duration_minutes = ?, status = 'confirmed', confirmed_at = NOW()
        WHERE id = ? AND status = 'pending'`,
      [creneau.date, creneau.time, dureeMinutes, appointmentId],
    )
    if (r.affectedRows === 0) return 'deja'
  } catch (error) {
    // L'index unique (date + heure) de la base interdit deux rendez-vous sur le même créneau : filet de sécurité ultime.
    if (error.code === 'ER_DUP_ENTRY') return 'creneau_pris'
    throw error
  }
  await execute(
    "UPDATE booking_requests SET status = 'confirmed', desired_date = ?, handled_at = COALESCE(handled_at, NOW()) WHERE id = ? AND status IN ('pending','contacted')",
    [creneau.date, ligne.id],
  )
  return 'confirme'
}

const fcfa = (n) => `${Math.round(Number(n) || 0).toLocaleString('fr-FR').replace(/[  ]/g, ' ')} FCFA`

/** Trace dans l'historique du rendez-vous (onglet « Historique des opérations »). Ne lève jamais. */
export async function tracer(appointmentId, ligne, { confirme, raison, transactionId, motifControle }) {
  if (!appointmentId) return
  try {
    const montant = fcfa(ligne.payment_amount)
    const transaction = transactionId ? `, transaction ${transactionId}` : ''
    if (confirme) {
      await logEvent(appointmentId, 'auto_confirm', `Confirmé automatiquement après paiement de la consultation (${montant}${transaction}).`, null)
    } else if (A_REGULARISER.has(raison)) {
      const detail = raison === 'montant' && motifControle ? ` (${motifControle})` : ''
      await logEvent(appointmentId, 'payment_review', `Paiement reçu (${montant}${transaction}) mais rendez-vous NON confirmé : ${RAISONS[raison]}${detail} À régulariser par le salon.`, null)
    } else {
      await logEvent(appointmentId, 'payment', `Paiement de la consultation reçu (${montant}${transaction}). ${RAISONS[raison] ?? ''}`.trim(), null)
    }
  } catch (error) {
    console.error('Historique du rendez-vous non écrit :', error.message)
  }
}
