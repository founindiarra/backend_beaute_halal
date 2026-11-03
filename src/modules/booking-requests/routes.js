import { Router } from 'express'
import { z } from 'zod'

import {
  STATUSES,
  deleteRequest,
  findById,
  findByReference,
  insertRequest,
  listClients,
  listRequests,
  requestStats,
  serialize,
  serializePublic,
  updateRequest,
} from './model.js'
import { execute, queryOne } from '../../config/database.js'
import { config } from '../../config/env.js'
import { jekoPret } from '../../lib/jeko.js'
import { findByPhone } from '../customers/model.js'
import { getSettings } from '../salon/model.js'
import { ApiError } from '../../lib/ApiError.js'
import {
  paginationMeta,
  readPagination,
  sendCreated,
  sendData,
  sendNoContent,
} from '../../lib/http.js'
import { bookingRequestToSalon, sendMail } from '../../lib/mailer.js'
import { generateReference } from '../../lib/reference.js'
import { requireAnyPermission } from '../../middleware/auth.js'
import { bookingLimiter } from '../../middleware/rateLimit.js'
import { getQuery, validate } from '../../middleware/validate.js'
import { findById as findAppointment, insertAppointment, serializeAppointment } from '../appointments/model.js'
import { assertSlotBookable } from '../availability/service.js'
import { assertDayQuota } from '../availability/quotas.js'
import { upsertFromAppointment } from '../customers/model.js'
import { issueProforma } from '../documents/routes.js'
import { METHODE_IDS, libelleMethode } from './methodes.js'
import { RAISONS, avecVerrouCreneau, confirmerRendezVous, creneauChoisi, decider, tracer, A_REGULARISER } from './autoConfirm.js'
import { whatsappProvider } from '../../lib/whatsapp.js'
import { EVENEMENT_PAR_STATUT_DEMANDE, envoyerEmailStatut, envoyerRecapPaiement, notifierDemande, notifierDemandeTousCanaux } from '../messaging/notifications.js'
import { estimate, findFormule, findType, findVolume, getCatalogue } from '../tarifs/catalogue.js'

/*
 * Demandes de rendez-vous du site v3 — SANS créneau horaire.
 *
 * La cliente choisit « création complète » ou « resserrage », décrit ses locks,
 * propose un jour (jamais une heure) et laisse ses coordonnées. Le salon la
 * rappelle ensuite pour fixer le jour et l'heure.
 *
 * Trois règles :
 *  – le montant indicatif est calculé ICI, depuis la grille de la base ; le
 *    navigateur n'envoie ni prix ni total ;
 *  – la fiche cliente se crée ou se retrouve par le numéro de téléphone, et la
 *    date de naissance saisie y est conservée ;
 *  – la demande n'est PLUS recopiée dans « Messages » : cette page ne montre que
 *    les messages du formulaire de contact du site ; les demandes ont leurs
 *    propres écrans (Demandes, Rendez-vous, Soins capillaires).
 */

const birthDate = z.iso
  .date()
  .refine(
    (valeur) => {
      const jour = new Date(`${valeur}T00:00:00`)
      const limite = new Date()
      limite.setFullYear(limite.getFullYear() - 120)
      return jour <= new Date() && jour >= limite
    },
    { message: 'Date de naissance invalide.' },
  )

const createBody = z.object({
  /** Obligatoire, sauf pour une consultation prise sur place (le parcours s'arrête alors au paiement). */
  besoin: z.enum(['creation', 'resserrage']).optional(),
  /** Slug d'un type de locks, ou « inconnu » (« je ne sais pas »). Obligatoire, sauf consultation sur place. */
  type: z.string().trim().min(1).max(40).optional(),
  /** Méthode de pose (installation de locks seulement) : interlocking, braid, twist ou broderie. Facultative (« le salon me conseille »). */
  methode: z.enum(METHODE_IDS).nullish().or(z.literal('')),
  volume: z.string().trim().max(8).optional().default(''),
  longueur: z.string().trim().max(20).optional().default(''),
  formule: z.string().trim().max(20).optional().default('complet'),
  delai: z.string().trim().max(30).optional().default(''),
  etat: z.string().trim().max(30).optional().default(''),
  /** Niveau de réparation (formule « réparation ») : partielle ou globale. Facultatif (anciens sites). */
  reparation: z.enum(['partielle', 'globale']).optional(),
  /** Jour souhaité : une date (l'heure éventuelle est dans desiredTime). */
  desiredDate: z.iso.date('Choisissez un jour souhaité.').optional(),
  /** Créneau souhaité (facultatif) : une heure parmi celles que le salon propose, vérifiée côté serveur. */
  desiredTime: z.string().regex(/^\d{2}:\d{2}$/, 'Format attendu : HH:MM').nullish().or(z.literal('')),
  inspiration: z
    .object({
      id: z.coerce.number().int().positive().nullish(),
      title: z.string().trim().min(1).max(200),
    })
    .nullish(),
  firstName: z.string().trim().min(2, 'Prénom trop court.').max(80),
  lastName: z.string().trim().min(2, 'Nom trop court.').max(80),
  phone: z.string().trim().min(8, 'Numéro de téléphone incomplet.').max(40),
  /** Facultatif : une cliente qui n'est jamais venue n'a pas à donner d'e-mail (elle est jointe par téléphone / WhatsApp). */
  email: z.email('Adresse e-mail invalide.').max(160).or(z.literal('')).nullish().transform((v) => v ?? ''),
  birthDate: birthDate.nullish().or(z.literal('')),
  note: z.string().trim().max(2000).nullish(),
  /** Profil déclaré par la cliente. Le serveur ne s'y fie pas pour le paiement : il regarde sa propre base. */
  customerKind: z.enum(['ancienne', 'nouvelle']).nullish(),
  /** Consultation capillaire : ignorée, par téléphone / WhatsApp (hors site), ou sur place (jour + heure). */
  consultation: z
    .object({
      mode: z.enum(['ignoree', 'telephone', 'whatsapp', 'sur_place']),
      hasLocks: z.boolean().nullish(),
      date: z.iso.date().nullish(),
      time: z.string().regex(/^\d{2}:\d{2}$/, 'Format attendu : HH:MM').nullish(),
    })
    .nullish(),
  /**
   * Consultation prise en rendez-vous + prestation souhaitée : la cliente a choisi de poursuivre vers un service.
   * La prestation peut avoir lieu le jour de la consultation (à une autre heure) ou plus tard, jamais avant.
   */
  avecPrestation: z.boolean().optional(),
  serviceDate: z.iso.date('Choisissez un jour pour la prestation.').optional(),
  serviceTime: z.string().regex(/^\d{2}:\d{2}$/, 'Format attendu : HH:MM').nullish().or(z.literal('')),
  // Champ piège invisible : s'il est rempli, c'est un robot.
  website: z.string().max(0).optional(),
}).superRefine((v, ctx) => {
  // Consultation sur place = parcours « consultation seule » : seuls le profil et le créneau comptent.
  if (v.consultation?.mode && v.consultation.mode !== 'ignoree') {
    if (v.avecPrestation) {
      if (!v.besoin) ctx.addIssue({ code: 'custom', path: ['besoin'], message: 'Choisissez votre besoin.' })
      if (!v.type) ctx.addIssue({ code: 'custom', path: ['type'], message: 'Choisissez un type de locks.' })
      if (!v.serviceDate) ctx.addIssue({ code: 'custom', path: ['serviceDate'], message: 'Choisissez un jour pour la prestation.' })
    }
    return
  }
  if (!v.besoin) ctx.addIssue({ code: 'custom', path: ['besoin'], message: 'Choisissez votre besoin.' })
  if (!v.type) ctx.addIssue({ code: 'custom', path: ['type'], message: 'Choisissez un type de locks.' })
  if (!v.desiredDate) ctx.addIssue({ code: 'custom', path: ['desiredDate'], message: 'Choisissez un jour souhaité.' })
})

/** Montant de la consultation (FCFA) : réglage « consultation_fee » du salon, sinon la valeur par défaut du serveur. */
export async function consultationFee() {
  const reglages = await getSettings().catch(() => ({}))
  const n = Number(reglages?.consultation_fee)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : config.consultationFeeDefault
}

/**
 * Cette demande doit-elle être payée avant d'exister pour le salon ?
 * Règle : TOUT LE MONDE règle la consultation (nouvelles clientes et clientes déjà venues), que la consultation soit
 * prise en rendez-vous (le parcours s'arrête alors au paiement) ou que la cliente continue jusqu'à son rendez-vous.
 * Seul un montant à 0 (réglage du salon) supprime le paiement.
 * `disponible` dit si le paiement en ligne (Jèko) est utilisable : la page de paiement s'affiche dans tous les cas,
 * mais sans Jèko elle ne peut pas encaisser — et la demande n'est alors jamais confirmée sans paiement.
 */
export async function paiementRequis() {
  const montant = await consultationFee()
  if (montant <= 0) return { requis: false, montant: 0, disponible: jekoPret() }
  return { requis: true, montant, disponible: jekoPret() }
}

const money = (n) => `${new Intl.NumberFormat('fr-FR').format(n).replace(/[  ]/g, ' ')} FCFA`
const formatDay = (iso) => {
  const [y, m, d] = String(iso).split('-')
  return `${d}/${m}/${y}`
}

/** Texte lisible par le salon (e-mail, page « Messages » du dashboard). */
function buildMessage({ reference, c, besoin, methode, type, volume, formule, delai, etat, longueur, est, reparation, soloConsultation = false, avecPrestation = false, serviceDate = null, serviceTime = null }) {
  const lines = [`DEMANDE DE RENDEZ-VOUS ${reference} (site v3)`]
  if (soloConsultation && avecPrestation) lines.push('Demande : CONSULTATION CAPILLAIRE, puis PRESTATION SOUHAITÉE (le même jour à une autre heure, ou un autre jour)')
  if (soloConsultation && (c.consultation?.mode === 'telephone' || c.consultation?.mode === 'whatsapp')) lines.push('À FAIRE : recontacter la cliente pour fixer le jour et l’heure de la consultation.')
  if (soloConsultation && !avecPrestation) {
    lines.push('Demande : CONSULTATION CAPILLAIRE SEULE (le parcours s’est arrêté au paiement)')
  } else if (besoin === 'creation') {
    lines.push('Besoin : Installation de locks')
    lines.push(`Type de locks : ${type ? `${type.name} (${type.size})` : 'je ne sais pas'}`)
    lines.push(`Méthode : ${libelleMethode(type?.id, methode) ?? 'à conseiller par le salon'}`)
    lines.push(`Volume : ${volume ? volume.hint : 'à évaluer sur place'}`)
    if (longueur) lines.push(`Longueur : ${longueur}`)
  } else {
    lines.push(`Besoin : ${formule?.label ?? 'Resserrage'}`)
    lines.push(`Type de locks : ${type ? `${type.name} (${type.size})` : 'je ne sais pas'}`)
    if (formule?.id === 'reparation' && reparation) lines.push(`Niveau de réparation : ${reparation === 'globale' ? 'globale' : 'partielle'}`)
    if (formule?.id !== 'reparation') {
      lines.push(`Volume : ${volume ? volume.hint : 'à évaluer sur place'}`)
      if (longueur) lines.push(`Longueur : ${longueur}`)
      if (type) {
        lines.push(`Dernière séance : ${type.delais?.find((d) => d.id === delai)?.label ?? '—'}`)
        lines.push(`État des locks : ${type.etats?.find((e) => e.id === etat)?.label ?? '—'}`)
      }
    }
    if (est) lines.push(`Tarif indicatif : ${est.partial ? 'à partir de ' : ''}${money(est.total)}`)
  }
  if (c.customerKind) lines.push(`Profil : ${c.customerKind === 'nouvelle' ? 'nouvelle cliente' : 'ancienne cliente'}`)
  if (c.consultation) {
    const k = c.consultation
    const modes = { ignoree: 'ignorée', telephone: 'par téléphone', whatsapp: 'par WhatsApp', sur_place: 'sur place' }
    lines.push(`Consultation capillaire : ${modes[k.mode] ?? k.mode}${k.hasLocks === true ? ' · a déjà des locks' : k.hasLocks === false ? ' · n’a pas de locks' : ''}`)
    if (k.mode === 'sur_place' && k.date) lines.push(`Rendez-vous de consultation : ${formatDay(k.date)}${k.time ? ` à ${k.time}` : ''}`)
  }
  if (c.inspiration?.title) lines.push(`Coiffure souhaitée : « ${c.inspiration.title} »`)
  if (soloConsultation && avecPrestation && serviceDate) {
    lines.push(`Prestation souhaitée le : ${formatDay(serviceDate)} ${serviceTime ? `à ${serviceTime} (créneau souhaité, à confirmer)` : '(heure à confirmer avec la cliente)'}`)
  }
  if (!soloConsultation) {
    lines.push(`Jour souhaité : ${formatDay(c.desiredDate)} ${c.desiredTime ? `à ${c.desiredTime} (créneau souhaité, à confirmer)` : '(heure à confirmer avec la cliente)'}`)
  }
  lines.push(`Cliente : ${c.firstName} ${c.lastName} · ${c.phone} · ${c.email || 'e-mail non renseigné'}`)
  if (c.birthDate) lines.push(`Date de naissance : ${formatDay(c.birthDate)}`)
  if (c.note?.trim()) lines.push(`Message : ${c.note.trim()}`)
  return lines.join('\n')
}

const referenceParam = z.object({
  reference: z.string().regex(/^[A-Za-z]{2}-[A-Za-z0-9]{4,10}$/, 'Référence invalide.'),
})
const idParam = z.object({ id: z.coerce.number().int().positive() })

/**
 * Le salon vient de confirmer le rendez-vous : la cliente reçoit le récapitulatif COMPLET (rendez-vous, prestation,
 * coiffure et modèle choisis, durée, tarif, paiement) par e-mail, WhatsApp ET SMS, en même temps. Sans attendre, sans jamais
 * bloquer. Si le récapitulatif est désactivé (Messagerie) ou si la demande d'origine n'existe pas, on garde l'ancien envoi.
 */
function annoncerConfirmation({ maj, frais, rdvId, date, time, price, user }) {
  const ancien = () => {
    envoyerEmailStatut(frais)
    if (maj) {
      notifierDemande('request_confirmed', serialize(maj), user, { appointmentId: rdvId, date, time: String(time).slice(0, 5), price }).catch(() => {})
    }
  }
  if (!maj) return ancien()
  // Fournisseur Meta : un texte libre n'est admis que dans les 24 h après un message de la cliente → WhatsApp passe par le modèle approuvé.
  const meta = whatsappProvider() === 'meta'
  return envoyerRecapPaiement(
    maj,
    { rendezVous: serializeAppointment(frais), confirme: true, creneau: { date, time: String(time).slice(0, 5) }, sansWhatsapp: meta },
    user,
  )
    .then((r) => {
      if (r === null) return ancien()
      if (meta) {
        return notifierDemandeTousCanaux('request_confirmed', serialize(maj), user, { appointmentId: rdvId, date, time: String(time).slice(0, 5), price, canaux: ['whatsapp'] })
      }
      return r
    })
    .catch(() => ancien())
}

/**
 * Tout ce qui fait exister la demande pour le salon et pour la cliente : fiche cliente, rendez-vous « en attente »,
 * copie dans « Messages », e-mail au salon, accusé à la cliente (SMS + e-mail + WhatsApp).
 * Appelée à l'enregistrement (cliente connue) ou une fois le paiement confirmé (nouvelle cliente).
 * Chaque étape peut échouer sans faire perdre la demande.
 */
export async function finaliserDemande(created, { ip, controle = { ok: true }, transactionId = null } = {}) {
  const phone = created.phone
  const body = { phone, firstName: created.first_name, lastName: created.last_name, email: created.email }
  const birthDate = created.birth_date ? String(created.birth_date).slice(0, 10) : null
  // Fiche cliente (par le numéro) — un échec ici ne doit pas faire perdre la demande.
  try {
    const cliente = await upsertFromAppointment({
      phone: body.phone,
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      birthDate: birthDate,
    })
    if (cliente) {
      await execute('UPDATE booking_requests SET customer_id = ? WHERE id = ?', [cliente.id, created.id])
    }
  } catch (error) {
    console.error('Fiche cliente non rattachée :', error.message)
  }

  /*
   * La demande devient aussitôt un rendez-vous (page Rendez-vous). Si la consultation est payée (webhook Jèko signé ou
   * lecture directe chez Jèko — jamais le navigateur) et que tout est en règle, il est confirmé AUTOMATIQUEMENT :
   * montant et devise conformes, créneau choisi et encore libre, demande ni refusée ni annulée.
   * La décision est prise AVANT de créer le rendez-vous, pour que la demande ne se bloque pas elle-même son créneau.
   */
  let issue = { confirmer: false, raison: 'non_paye', creneau: null }
  let rendezVous = null
  let ligneRdv = null
  try {
    ligneRdv = await findById(created.id)
    if (ligneRdv) {
      await avecVerrouCreneau(creneauChoisi(ligneRdv), async (verrou) => {
        issue = await decider(ligneRdv, controle)
        // Verrou du créneau indisponible (très rare) : on ne prend aucun risque, le salon régularisera.
        if (!verrou && issue.confirmer) issue = { ...issue, confirmer: false, raison: 'creneau_indisponible' }
        rendezVous = await creerRendezVousDeDemande(ligneRdv, { repere: ['creneau_indisponible', 'demande_annulee'].includes(issue.raison) })
        if (rendezVous?.creneauPris) issue = { ...issue, confirmer: false, raison: 'creneau_indisponible' }
        if (rendezVous && issue.confirmer) {
          const resultat = await confirmerRendezVous({
            appointmentId: rendezVous.id,
            ligne: ligneRdv,
            creneau: issue.creneau,
            dureeMinutes: estConsultationSeule(ligneRdv) ? 30 : 180,
          })
          if (resultat === 'creneau_pris') issue = { ...issue, confirmer: false, raison: 'creneau_indisponible' }
          else if (resultat === 'deja') issue = { ...issue, confirmer: false, raison: 'deja' }
        }
      })
      if (ligneRdv.payment_status === 'paid' && issue.raison !== 'deja') {
        await tracer(rendezVous?.id, ligneRdv, {
          confirme: issue.confirmer, raison: issue.raison, transactionId, motifControle: controle?.motif ?? null,
        })
      }
    }
  } catch (error) {
    console.error('Rendez-vous non créé pour la demande :', error.message)
  }

  // Paiement reçu mais rendez-vous à régulariser : alerte au salon (la cliente a payé, on ne l'oublie pas).
  if (ligneRdv?.payment_status === 'paid' && A_REGULARISER.has(issue.raison)) {
    sendMail({
      to: config.mail.adminRecipient,
      subject: `À régulariser — paiement reçu, rendez-vous non confirmé (${created.reference})`,
      text: [
        `${created.first_name} ${created.last_name} (${created.phone}) a payé sa consultation (${created.payment_amount} FCFA) mais son rendez-vous n’a PAS été confirmé automatiquement.`,
        `Motif : ${RAISONS[issue.raison]}`,
        issue.creneau ? `Créneau demandé : ${issue.creneau.date} à ${issue.creneau.time.slice(0, 5)}` : '',
        `Référence : ${created.reference}${transactionId ? ` · transaction ${transactionId}` : ''}`,
        'Contactez la cliente pour fixer un autre créneau, ou procédez au remboursement depuis votre espace Jèko.',
      ].filter(Boolean).join('\n'),
    }).catch(() => {})
  }

  sendMail(bookingRequestToSalon(created)).catch(() => {})

  // Accusé de réception à la cliente (WhatsApp par défaut) — sans attendre, sans jamais bloquer.
  findById(created.id)
    .then((ligne) => {
      if (!ligne) return null
      const d = serialize(ligne)
      const paye = ligne.payment_status === 'paid'
      // La cliente a choisi son jour et son heure : les messages les rappellent.
      const quand = { date: d.consultation?.date || d.desiredDate, time: d.consultation?.date ? d.consultation.time : d.desiredTime }
      // Message « rendez-vous confirmé » UNIQUEMENT si la confirmation a réellement eu lieu ; sinon, simple accusé de paiement.
      const c = issue.confirmer ? creneauChoisi(ligne) : null
      const ancien = () => {
        if (paye && issue.confirmer) {
          return notifierDemandeTousCanaux('payment_confirmed', d, null, {
            appointmentId: rendezVous?.id ?? null,
            date: c?.date ?? quand.date,
            time: c?.time?.slice(0, 5) ?? quand.time,
            paid: ligne.payment_amount,
            service: rendezVous?.service?.name ?? (estConsultationSeule(ligne) ? 'Consultation capillaire' : null),
            canaux: ['sms'],
          })
        }
        return notifierDemandeTousCanaux(paye ? 'request_paid' : 'request_received', d, null, { ...quand, paid: ligne.payment_amount, ...(paye ? { canaux: ['sms'] } : {}) })
      }
      if (paye) {
        // Récapitulatif COMPLET : e-mail, WhatsApp ET SMS en même temps. S'il est désactivé dans la Messagerie, on garde l'ancien SMS court.
        return envoyerRecapPaiement(ligne, { rendezVous, confirme: Boolean(issue.confirmer), creneau: c ? { date: c.date, time: c.time } : null }).then((r) => (r === null ? ancien() : r))
      }
      return ancien()
    })
    .catch(() => {})

}

// ══════════════ Public ══════════════
export const publicRouter = Router()

publicRouter.post(
  '/booking-requests',
  bookingLimiter,
  validate({ body: createBody }),
  async (request, response) => {
    const body = request.body
    const catalogue = await getCatalogue()

    /*
     * Consultation prise sur place : le parcours s'arrête ici (profil + créneau + paiement). Le serveur ignore tout
     * le reste (besoin, type, volume…) et retient le créneau de la consultation comme jour et heure du rendez-vous.
     */
    const soloConsultation = Boolean(body.consultation?.mode) && body.consultation.mode !== 'ignoree'
    const avecPrestation = soloConsultation && body.avecPrestation === true
    if (soloConsultation) {
      if (body.consultation.mode === 'sur_place' && (!body.consultation.date || !body.consultation.time)) {
        throw ApiError.unprocessable('Choisissez le jour et l’heure de votre consultation.', {
          details: [{ field: 'consultation', message: 'Jour et heure de consultation requis.' }],
        })
      }
      if (avecPrestation) {
        // Prestation : le jour de la consultation (autre heure) ou après.
        const dans = new Date().toISOString().slice(0, 10)
        const plafond = new Date(Date.now() + 2 * 365 * 86400000).toISOString().slice(0, 10)
        if (body.serviceDate < dans || body.serviceDate > plafond) {
          throw ApiError.unprocessable('Le jour de la prestation est invalide.', {
            details: [{ field: 'serviceDate', message: 'Choisissez un jour à venir.' }],
          })
        }
        // La prestation peut avoir lieu le jour même de la consultation (à une autre heure), jamais avant.
        if (body.consultation.mode === 'sur_place' && body.serviceDate < body.consultation.date) {
          throw ApiError.unprocessable('La prestation ne peut pas avoir lieu avant la consultation.', {
            details: [{ field: 'serviceDate', message: 'Choisissez le jour de la consultation ou un jour après.' }],
          })
        }
        if (
          body.consultation.mode === 'sur_place' &&
          body.serviceDate === body.consultation.date &&
          body.serviceTime &&
          body.serviceTime === body.consultation.time
        ) {
          throw ApiError.unprocessable('Choisissez une autre heure que celle de votre consultation.', {
            details: [{ field: 'serviceTime', message: 'Cette heure est celle de votre consultation.' }],
          })
        }
        if (body.serviceTime) {
          const creneau = await assertSlotBookable(body.serviceDate, body.serviceTime)
          if (!creneau.ok) {
            throw ApiError.unprocessable(creneau.message, { details: [{ field: 'serviceTime', message: creneau.message }] })
          }
        }
      }
      Object.assign(body, avecPrestation ? {} : {
        besoin: 'creation', type: 'inconnu', volume: '', longueur: '', formule: 'complet', delai: '', etat: '',
        inspiration: null,
      }, {
        // Téléphone / WhatsApp : pas de créneau, le salon recontacte la cliente pour fixer la consultation.
        desiredDate: body.consultation.mode === 'sur_place' ? body.consultation.date : null,
        desiredTime: body.consultation.mode === 'sur_place' ? body.consultation.time : null,
      })
    }

    // Le jour souhaité ne peut pas être dans le passé (ni à plus de deux ans).
    const today = new Date().toISOString().slice(0, 10)
    const max = new Date(Date.now() + 2 * 365 * 86400000).toISOString().slice(0, 10)
    if (body.desiredDate && (body.desiredDate < today || body.desiredDate > max)) {
      throw ApiError.unprocessable('Le jour souhaité est invalide.', {
        details: [{ field: 'desiredDate', message: 'Choisissez un jour à venir.' }],
      })
    }

    // Créneau souhaité : il doit être l'un des créneaux encore libres (le salon confirme ensuite).
    const desiredTime = body.desiredTime || null
    if (desiredTime) {
      const check = await assertSlotBookable(body.desiredDate, desiredTime)
      if (!check.ok) {
        throw ApiError.unprocessable(check.message, {
          details: [{ field: 'desiredTime', message: check.message }],
        })
      }
    }

    const type = body.type === 'inconnu' ? null : findType(catalogue, body.type)
    if (body.type !== 'inconnu' && !type) {
      throw ApiError.unprocessable('Ce type de locks n’existe pas.', {
        details: [{ field: 'type', message: 'Type de locks inconnu.' }],
      })
    }
    // Places du jour : le quota du type de locks / de la coiffure choisis est-il atteint ce jour-là ?
    const jourPrestation = soloConsultation ? (avecPrestation ? body.serviceDate : null) : body.desiredDate
    const quota = await assertDayQuota(jourPrestation, {
      type: type?.id ?? null,
      coiffureId: body.inspiration?.id ?? null,
      besoin: body.formule === 'reparation' ? 'reparation' : body.besoin ?? null,
    })
    if (!quota.ok) {
      throw ApiError.unprocessable(quota.message, {
        details: [{ field: avecPrestation ? 'serviceDate' : 'desiredDate', message: quota.message }],
      })
    }
    const volume = findVolume(catalogue, body.volume)
    if (body.volume && !volume) {
      throw ApiError.unprocessable('Ce volume n’existe pas.', {
        details: [{ field: 'volume', message: 'Volume inconnu (XS à XL).' }],
      })
    }

    const isCreation = body.besoin === 'creation'
    const formule = isCreation ? null : findFormule(catalogue, body.formule)
    if (!isCreation && !formule) {
      throw ApiError.unprocessable('Cette prestation n’existe pas.', {
        details: [{ field: 'formule', message: 'Prestation inconnue.' }],
      })
    }

    // Pas de tarif de création dans la grille : seul le resserrage est estimé.
    const est =
      !isCreation && type
        ? estimate(catalogue, {
            type: type.id,
            volume: body.volume,
            formule: body.formule,
            delai: body.delai,
            etat: body.etat,
            reparation: body.reparation,
          })
        : null

    // Consultation sur place : jour + heure obligatoires, et l'heure doit être un créneau encore libre.
    const k = body.consultation ?? null
    if (k?.mode === 'sur_place') {
      if (!k.date || !k.time) {
        throw ApiError.unprocessable('Choisissez le jour et l’heure de votre consultation.', {
          details: [{ field: 'consultation', message: 'Jour et heure de consultation requis.' }],
        })
      }
      if (k.date < today || k.date > max) {
        throw ApiError.unprocessable('Le jour de consultation est invalide.', {
          details: [{ field: 'consultation', message: 'Choisissez un jour à venir.' }],
        })
      }
      const slot = await assertSlotBookable(k.date, k.time)
      if (!slot.ok) {
        throw ApiError.unprocessable(slot.message, { details: [{ field: 'consultation', message: slot.message }] })
      }
    }

    const paiement = await paiementRequis()
    const input = { ...body, birthDate: body.birthDate || null }

    let created = null
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      const reference = generateReference('DM')
      try {
        created = await insertRequest({
          reference,
          besoin: body.besoin,
          lockType: type?.id ?? null,
          volume: volume?.id ?? null,
          longueur: body.longueur || null,
          methode: isCreation && body.methode ? body.methode : null,
          formule: isCreation ? null : formule.id,
          delai: !isCreation && formule.id !== 'reparation' ? body.delai || null : null,
          etat: !isCreation && formule.id !== 'reparation' ? body.etat || null : null,
          estimateTotal: est?.total ?? null,
          estimatePartial: Boolean(est?.partial),
          desiredDate: body.desiredDate,
          desiredTime,
          inspirationId: body.inspiration?.id ?? null,
          inspirationTitle: body.inspiration?.title ?? null,
          firstName: body.firstName,
          lastName: body.lastName,
          phone: body.phone,
          email: body.email,
          birthDate: input.birthDate,
          note: body.note?.trim() || null,
          ip: request.ip?.slice(0, 45) ?? null,
          customerKind: body.customerKind ?? null,
          consultationMode: k?.mode ?? null,
          hasLocks: k?.hasLocks ?? null,
          consultationDate: k?.mode === 'sur_place' ? k.date : null,
          consultationTime: k?.mode === 'sur_place' ? k.time : null,
          serviceDate: avecPrestation ? body.serviceDate : null,
          serviceTime: avecPrestation ? body.serviceTime || null : null,
          awaitingPayment: paiement.requis,
          paymentAmount: paiement.requis ? paiement.montant : null,
          message: buildMessage({
            reference,
            c: input,
            besoin: body.besoin,
            methode: isCreation ? body.methode || null : null,
            type,
            volume,
            formule,
            delai: body.delai,
            etat: body.etat,
            longueur: body.longueur,
            est,
            reparation: body.reparation,
            soloConsultation,
            avecPrestation,
            serviceDate: body.serviceDate ?? null,
            serviceTime: body.serviceTime || null,
          }),
        })
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error
      }
    }
    if (!created) throw new ApiError(500, 'Impossible de générer une référence unique. Réessayez.')

    /*
     * Une demande qui attend son paiement reste invisible du salon : rien n'est créé (fiche, rendez-vous,
     * messages, e-mail) tant que Jèko n'a pas confirmé. Le paiement confirmé appelle `finaliserDemande`.
     */
    if (!paiement.requis) await finaliserDemande(created, { ip: request.ip })
    else if (!paiement.disponible) {
      // Paiement en ligne indisponible : la demande n'est PAS confirmée, mais le salon est prévenu pour recontacter la cliente.
      sendMail({
        to: config.mail.adminRecipient,
        subject: `Paiement en ligne indisponible — demande ${created.reference} non confirmée`,
        text: `Une cliente a voulu régler sa consultation, mais le paiement en ligne n'est pas configuré. Sa demande n'est pas confirmée.\n\n${created.message}`,
      }).catch(() => {})
    }

    return sendCreated(response, {
      ...serializePublic(created),
      message: paiement.requis
        ? `Votre demande est enregistrée : réglez la consultation (${paiement.montant} FCFA) pour la valider.`
        : 'Votre demande est bien reçue. Le salon vous confirme le jour et l’heure par téléphone ou WhatsApp.',
    })
  },
)

publicRouter.get(
  '/booking-requests/:reference',
  validate({ params: referenceParam }),
  async (request, response) => {
    const row = await findByReference(request.params.reference.toUpperCase())
    if (!row) throw ApiError.notFound('Aucune demande ne correspond à cette référence.')
    return sendData(response, serializePublic(row))
  },
)

// ══════════════ Admin ══════════════
export const adminRouter = Router()
// « Rendez-vous » ou « Soins capillaires » : la page Soins lit les demandes de consultation et l'historique des clientes.
adminRouter.use('/booking-requests', requireAnyPermission('appointments', 'soins'))

const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  search: z.string().max(120).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  phoneKey: z.string().trim().max(30).optional(),
  kind: z.enum(['soin']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

adminRouter.get('/booking-requests', validate({ query: listQuery }), async (request, response) => {
  const filters = getQuery(request)
  const pagination = readPagination({ query: filters })
  const { total, rows } = await listRequests({ ...filters, ...pagination })
  return response.json({
    success: true,
    data: rows.map(serialize),
    meta: paginationMeta(pagination, total),
  })
})

/** Historique des clientes ayant fait une demande de soin (une ligne par cliente). */
adminRouter.get(
  '/booking-requests/clients',
  validate({ query: z.object({ search: z.string().max(120).optional(), page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().positive().max(100).optional() }) }),
  async (request, response) => {
    const filters = getQuery(request)
    const pagination = readPagination({ query: filters })
    const { total, rows } = await listClients({ search: filters.search, ...pagination })
    return response.json({ success: true, data: rows, meta: paginationMeta(pagination, total) })
  },
)

// Déclarée AVANT « /:id », sinon « stats » serait pris pour un identifiant.
adminRouter.get('/booking-requests/stats', async (_request, response) =>
  sendData(response, await requestStats()),
)

adminRouter.get('/booking-requests/:id', validate({ params: idParam }), async (request, response) => {
  const row = await findById(request.params.id)
  if (!row) throw ApiError.notFound('Cette demande n’existe pas.')
  return sendData(response, serialize(row))
})

adminRouter.patch(
  '/booking-requests/:id',
  validate({
    params: idParam,
    body: z.object({
      status: z.enum(STATUSES).optional(),
      adminNote: z.string().trim().max(2000).nullish(),
    }),
  }),
  async (request, response) => {
    const avant = await findById(request.params.id)
    if (!avant) throw ApiError.notFound('Cette demande n’existe pas.')
    const row = await updateRequest(request.params.id, request.body)

    // Le rendez-vous lié suit le statut de la demande (contactée, refusée…), sauf s'il est déjà confirmé.
    if (request.body.status && row.appointment_id && ['pending', 'contacted', 'rejected', 'cancelled'].includes(request.body.status)) {
      await execute(
        "UPDATE appointments SET status = ? WHERE id = ? AND status IN ('pending','contacted')",
        [request.body.status, row.appointment_id],
      ).catch(() => {})
    }

    const evenement = EVENEMENT_PAR_STATUT_DEMANDE[request.body.status]
    if (evenement && avant.status !== request.body.status) {
      notifierDemande(evenement, serialize(row), request.user).catch(() => {})
    }
    return sendData(response, serialize(row))
  },
)

/**
 * Prestation « sur mesure » qui porte les rendez-vous issus des demandes.
 *
 * `appointments.service_id` est obligatoire et relié à `services`. Plutôt que
 * de défaire cette règle (et tout ce qui en dépend : proforma, historique,
 * statistiques), on s'appuie sur une prestation INACTIVE rangée dans une
 * catégorie inactive : le public ne la voit jamais, le rendez-vous garde son
 * vrai libellé (`service_name`) et son vrai prix. Créée au premier besoin.
 */
async function ensureCustomService() {
  const existing = await queryOne("SELECT id, duration_minutes FROM services WHERE slug = 'prestation-sur-mesure-site' LIMIT 1")
  if (existing) return existing
  let category = await queryOne("SELECT id FROM service_categories WHERE slug = 'sur-mesure-site' LIMIT 1")
  if (!category) {
    const created = await execute(
      "INSERT INTO service_categories (slug, name, description, position, is_active) VALUES ('sur-mesure-site', 'Sur mesure (demandes du site)', 'Catégorie technique : rendez-vous issus des demandes du site.', 999, 0)",
    )
    category = { id: created.insertId }
  }
  const inserted = await execute(
    `INSERT INTO services (category_id, slug, name, description, duration_minutes, price, is_active, position)
     VALUES (?, 'prestation-sur-mesure-site', 'Prestation sur mesure (demande du site)', 'Technique : porte les rendez-vous créés depuis une demande du site.', 180, 0, 0, 999)`,
    [category.id],
  )
  return { id: inserted.insertId, duration_minutes: 180 }
}

const estConsultationSeule = (demande) => ['sur_place', 'telephone', 'whatsapp'].includes(demande.consultation_mode)

function libelleDemande(catalogue, demande) {
  if (estConsultationSeule(demande)) return 'Consultation capillaire'
  const type = findType(catalogue, demande.lock_type)
  const formule = findFormule(catalogue, demande.formule)
  return demande.besoin === 'creation'
    ? `Installation de locks — ${type?.name ?? demande.lock_type ?? 'locks'}`
    : `${formule?.label ?? 'Resserrage'} — ${type?.name ?? demande.lock_type ?? 'locks'}${demande.volume ? ` · volume ${demande.volume}` : ''}`
}

/**
 * Une demande du site devient tout de suite un rendez-vous « en attente »,
 * visible dans la page Rendez-vous. L'heure n'est pas encore connue : on pose
 * un repère technique unique (entre 00:00 et 05:33, hors horaires d'ouverture)
 * que le tableau de bord n'affiche pas — « heure à fixer ».
 */
export async function creerRendezVousDeDemande(demande, { repere = false } = {}) {
  // Consultation par téléphone / WhatsApp : aucun jour choisi, donc pas de rendez-vous tant que le salon n'a pas fixé la date.
  if (estConsultationSeule(demande) && !demande.desired_date) return null
  const catalogue = await getCatalogue()
  const service = await ensureCustomService()
  const secondes = Number(demande.id) % 20000
  const hh = String(Math.floor(secondes / 3600)).padStart(2, '0')
  const mm = String(Math.floor((secondes % 3600) / 60)).padStart(2, '0')
  const ss = String(secondes % 60).padStart(2, '0')
  const date = String(demande.desired_date instanceof Date
    ? demande.desired_date.toISOString().slice(0, 10)
    : demande.desired_date).slice(0, 10)
  const consultation = estConsultationSeule(demande)
  const reperes = `${hh}:${mm}:${ss}`
  const heureReelle = consultation && demande.consultation_time ? String(demande.consultation_time).slice(0, 8).padEnd(8, ':00').slice(0, 8) : null
  const creer = (time) => insertAppointment({
    reference: demande.reference,
    serviceId: service.id,
    serviceName: libelleDemande(catalogue, demande).slice(0, 140),
    date,
    time,
    durationMinutes: consultation ? 30 : 15,
    price: consultation ? Number(demande.payment_amount ?? 0) : demande.estimate_total ?? 0,
    currency: 'FCFA',
    firstName: demande.first_name,
    lastName: demande.last_name,
    phone: demande.phone,
    email: demande.email,
    note: [`Demande ${demande.reference}`, demande.note].filter(Boolean).join(' — '),
    source: 'site-v3',
  })
  // Consultation seule : le créneau est connu et réel. Sinon (ou si le créneau est déjà pris), repère technique « heure à fixer ».
  let appointment
  let creneauPris = false
  try {
    appointment = await creer(!repere && heureReelle ? heureReelle : reperes)
  } catch (error) {
    if (error.code !== 'ER_DUP_ENTRY' || !heureReelle) throw error
    // Le créneau a été pris entre-temps : la demande (et son paiement) ne se perdent pas, le salon régularise.
    creneauPris = true
    appointment = await creer(reperes)
  }
  await execute('UPDATE appointments SET customer_id = ? WHERE id = ?', [demande.customer_id ?? null, appointment.id])
  await execute('UPDATE booking_requests SET appointment_id = ? WHERE id = ?', [appointment.id, demande.id])
  return creneauPris ? { ...appointment, creneauPris: true } : appointment
}

const convertBody = z.object({
  date: z.iso.date(),
  time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Format attendu : HH:MM'),
  /**
   * Prix convenu avec la cliente (FCFA) : OBLIGATOIRE. Pour une création il
   * n'existe aucune estimation, et pour un resserrage l'estimation du site
   * n'est qu'indicative : c'est le salon qui fixe le prix, et la cliente le
   * reçoit dans sa confirmation WhatsApp.
   */
  price: z.number().int().min(1, 'Indiquez le prix convenu.').max(10_000_000),
  durationMinutes: z.number().int().min(15).max(1440).optional(),
  staffId: z.coerce.number().int().positive().nullish(),
  officeId: z.coerce.number().int().positive().nullish(),
})

async function verifierAgentEtBureau(body) {
  for (const [table, id, label] of [
    ['team_members', body.staffId, 'Cet agent'],
    ['offices', body.officeId, 'Ce bureau'],
  ]) {
    if (!id) continue
    if (!(await queryOne(`SELECT id FROM ${table} WHERE id = ? AND is_active = 1 LIMIT 1`, [id]))) {
      throw ApiError.unprocessable(`${label} n’est pas disponible.`)
    }
  }
}

/**
 * « Confirmer et planifier » sur le rendez-vous issu d'une demande : jour,
 * heure et prix convenus avec la cliente. Le rendez-vous passe en « confirmé »
 * et la cliente reçoit le message (WhatsApp / e-mail) avec le prix.
 */
async function planifier(appointmentId, body, user) {
  const rdv = await findAppointment(appointmentId)
  if (!rdv) throw ApiError.notFound('Ce rendez-vous n’existe pas.')
  if (rdv.source !== 'site-v3') {
    throw ApiError.unprocessable('Seules les demandes du site se planifient ainsi.')
  }
  if (!['pending', 'contacted'].includes(rdv.status)) {
    throw new ApiError(409, 'Ce rendez-vous est déjà traité.', { code: 'ALREADY_PLANNED' })
  }
  await verifierAgentEtBureau(body)
  const demande = await queryOne('SELECT id FROM booking_requests WHERE appointment_id = ? LIMIT 1', [rdv.id])
  const heure = body.time.length === 5 ? `${body.time}:00` : body.time

  try {
    await execute(
      `UPDATE appointments
          SET appointment_date = ?, appointment_time = ?, duration_minutes = ?, price = ?,
              staff_id = ?, office_id = ?, status = 'confirmed', confirmed_at = NOW()
        WHERE id = ?`,
      [body.date, heure, body.durationMinutes ?? 180, body.price, body.staffId ?? null, body.officeId ?? null, rdv.id],
    )
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      throw new ApiError(409, 'Un rendez-vous existe déjà à ce jour et à cette heure.', { code: 'SLOT_TAKEN' })
    }
    throw error
  }
  if (demande) {
    await execute(
      "UPDATE booking_requests SET status = 'confirmed', desired_date = ?, handled_at = COALESCE(handled_at, NOW()) WHERE id = ?",
      [body.date, demande.id],
    )
  }

  let proforma = null
  try {
    proforma = await issueProforma(rdv.id, user)
  } catch (error) {
    console.error('Proforma non établi :', error.message)
  }

  const frais = await findAppointment(rdv.id)
  const maj = demande ? await findById(demande.id) : null
  annoncerConfirmation({ maj, frais, rdvId: rdv.id, date: body.date, time: body.time, price: body.price, user })
  return { appointment: serializeAppointment(frais), proforma }
}

adminRouter.post(
  '/appointments/:id/plan',
  validate({ params: idParam, body: convertBody }),
  async (request, response) => sendData(response, await planifier(request.params.id, request.body, request.user)),
)

/**
 * POST /admin/booking-requests/:id/convert — « Confirmer et planifier ».
 *
 * La cliente a donné un JOUR ; le salon l'a rappelée et fixé l'HEURE. La
 * demande devient alors un rendez-vous confirmé, qui entre dans le suivi
 * habituel (arrivée, bureau, paiement, reçu, historique, comptabilité).
 * Le salon décide : aucun contrôle de capacité n'est imposé ici.
 */
adminRouter.post(
  '/booking-requests/:id/convert',
  validate({ params: idParam, body: convertBody }),
  async (request, response) => {
    const demande = await findById(request.params.id)
    if (!demande) throw ApiError.notFound('Cette demande n’existe pas.')
    if (['rejected', 'cancelled'].includes(demande.status)) {
      throw ApiError.unprocessable('Cette demande est déclinée ou annulée : rouvrez-la avant de la planifier.')
    }
    if (demande.appointment_id) {
      // Depuis la v3 de la page Rendez-vous, la demande a déjà son rendez-vous : on le planifie.
      const resultat = await planifier(demande.appointment_id, request.body, request.user)
      return sendData(response, { request: serialize(await findById(demande.id)), ...resultat })
    }
    const body = request.body

    for (const [table, id, label] of [
      ['team_members', body.staffId, 'Cet agent'],
      ['offices', body.officeId, 'Ce bureau'],
    ]) {
      if (!id) continue
      if (!(await queryOne(`SELECT id FROM ${table} WHERE id = ? AND is_active = 1 LIMIT 1`, [id]))) {
        throw ApiError.unprocessable(`${label} n’est pas disponible.`)
      }
    }

    const catalogue = await getCatalogue()
    const type = findType(catalogue, demande.lock_type)
    const formule = findFormule(catalogue, demande.formule)
    const label =
      demande.besoin === 'creation'
        ? `Installation de locks — ${type?.name ?? demande.lock_type ?? 'locks'}`
        : `${formule?.label ?? 'Resserrage'} — ${type?.name ?? demande.lock_type ?? 'locks'}${demande.volume ? ` · volume ${demande.volume}` : ''}`

    const service = await ensureCustomService()
    const heure = body.time.length === 5 ? `${body.time}:00` : body.time
    const note = [`Demande ${demande.reference}`, demande.note].filter(Boolean).join(' — ')

    let appointment = null
    for (let essai = 0; essai < 5 && !appointment; essai += 1) {
      try {
        appointment = await insertAppointment({
          reference: generateReference(),
          serviceId: service.id,
          staffId: body.staffId ?? null,
          serviceName: label.slice(0, 140),
          date: body.date,
          time: heure,
          durationMinutes: body.durationMinutes ?? service.duration_minutes ?? 180,
          price: body.price,
          currency: 'FCFA',
          firstName: demande.first_name,
          lastName: demande.last_name,
          phone: demande.phone,
          email: demande.email,
          note,
          source: 'site-v3',
        })
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error
      }
    }
    if (!appointment) throw new ApiError(500, 'Impossible de générer une référence unique.')

    await execute(
      "UPDATE appointments SET status = 'confirmed', confirmed_at = NOW(), office_id = ?, customer_id = ? WHERE id = ?",
      [body.officeId ?? null, demande.customer_id ?? null, appointment.id],
    )
    await execute(
      "UPDATE booking_requests SET status = 'confirmed', appointment_id = ?, handled_at = COALESCE(handled_at, NOW()) WHERE id = ?",
      [appointment.id, demande.id],
    )

    let proforma = null
    try {
      proforma = await issueProforma(appointment.id, request.user)
    } catch (error) {
      console.error('Proforma non établi :', error.message)
    }

    const frais = await findAppointment(appointment.id)
    const maj = await findById(demande.id)

    // La cliente est prévenue (WhatsApp / e-mail) sans que le salon attende.
    annoncerConfirmation({ maj, frais, rdvId: appointment.id, date: body.date, time: body.time, price: body.price, user: request.user })

    return sendData(response, { request: serialize(maj), appointment: serializeAppointment(frais), proforma })
  },
)

adminRouter.delete('/booking-requests/:id', validate({ params: idParam }), async (request, response) => {
  if (!(await deleteRequest(request.params.id))) throw ApiError.notFound('Cette demande n’existe pas.')
  return sendNoContent(response)
})
