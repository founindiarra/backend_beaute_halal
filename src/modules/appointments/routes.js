import { Router } from 'express'
import { z } from 'zod'

import {
  deleteAppointment,
  findById,
  findByReference,
  getStats,
  insertAppointment,
  listAppointments,
  serializeAppointment,
  serializePublicAppointment,
  updateAppointment,
  updateStatus,
} from './model.js'
import { execute, queryOne } from '../../config/database.js'
import { ApiError } from '../../lib/ApiError.js'
import {
  paginationMeta,
  readPagination,
  sendCreated,
  sendData,
  sendNoContent,
} from '../../lib/http.js'
import {
  appointmentCreatedToSalon,
  sendMail,
} from '../../lib/mailer.js'
import {
  EVENEMENT_PAR_STATUT,
  EVENEMENT_PAR_STATUT_DEMANDE,
  envoyerEmailStatut,
  envoyerRecapPaiement,
  notifierCliente,
} from '../messaging/notifications.js'
import { whatsappProvider } from '../../lib/whatsapp.js'
import { generateReference } from '../../lib/reference.js'
import { issueProforma } from '../documents/routes.js'
import { upsertFromAppointment } from '../customers/model.js'
import { getQuery, validate } from '../../middleware/validate.js'
import { bookingLimiter } from '../../middleware/rateLimit.js'
import { assertSlotBookable } from '../availability/service.js'
import { assertDayQuota } from '../availability/quotas.js'
import { findServiceById, findServiceBySlug } from '../services/model.js'

/**
 * « rejected » : le salon refuse une demande encore en attente.
 * Distinct de « cancelled », qui annule un rendez-vous déjà pris en compte —
 * les deux ne méritent ni le même message à la cliente ni le même décompte.
 */
const STATUSES = [
  'pending',
  'contacted',
  'confirmed',
  'rejected',
  'cancelled',
  'arrived',
  'in_progress',
  'completed',
  'no_show',
]

const createBody = z
  .object({
    serviceId: z.coerce.number().int().positive().optional(),
    serviceSlug: z.string().min(1).max(140).optional(),
    date: z.iso.date(),
    time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Format attendu : HH:MM'),
    firstName: z.string().trim().min(2, 'Prénom trop court.').max(80),
    lastName: z.string().trim().min(2, 'Nom trop court.').max(80),
    phone: z.string().trim().min(8, 'Numéro de téléphone incomplet.').max(40),
    /** Facultatif : une première cliente n'a pas à donner d'e-mail. */
    email: z.email('Adresse e-mail invalide.').max(160).or(z.literal('')).nullish().transform((v) => v ?? ''),
    note: z.string().trim().max(2000).nullish(),
    staffId: z.coerce.number().int().positive().nullish(),
    /*
     * Date de naissance — facultative, recueillie dès la première
     * réservation pour que le salon puisse souhaiter les anniversaires.
     * Bornée des deux côtés : une date dans le futur ou un siècle et demi
     * en arrière est une faute de frappe, pas une naissance.
     */
    birthDate: z.iso
      .date()
      .refine(
        (valeur) => {
          const jour = new Date(`${valeur}T00:00:00`)
          const aujourdhui = new Date()
          const limite = new Date()
          limite.setFullYear(limite.getFullYear() - 120)
          return jour <= aujourdhui && jour >= limite
        },
        { message: 'Date de naissance invalide.' },
      )
      .nullish(),
  })
  .refine((data) => data.serviceId || data.serviceSlug, {
    message: 'Indiquez la prestation (serviceId ou serviceSlug).',
    path: ['serviceId'],
  })

const referenceParam = z.object({
  reference: z.string().regex(/^[A-Za-z]{2}-[A-Za-z0-9]{4,10}$/, 'Référence invalide.'),
})

const idParam = z.object({ id: z.coerce.number().int().positive() })

// ══════════════ Public ══════════════
export const publicRouter = Router()

publicRouter.post(
  '/appointments',
  bookingLimiter,
  validate({ body: createBody }),
  async (request, response) => {
    const body = request.body

    const service = body.serviceId
      ? await findServiceById(body.serviceId, { onlyActive: true })
      : await findServiceBySlug(body.serviceSlug)

    if (!service) throw ApiError.unprocessable('Cette prestation n’est pas disponible.')

    if (body.staffId) {
      const staff = await queryOne(
        'SELECT id FROM team_members WHERE id = ? AND is_active = 1 LIMIT 1',
        [body.staffId],
      )
      if (!staff) throw ApiError.unprocessable('Ce membre de l’équipe n’est pas disponible.')
    }

    /*
     * Seule question posée ici : le salon est-il ouvert à cette date et à
     * cette heure ? Une demande déjà déposée sur le même créneau n'empêche
     * plus rien — le tri se fait ensuite, à la main, dans le dashboard.
     * La demande est créée avec le statut « pending » (valeur par défaut de
     * la colonne) et le reste ainsi jusqu'à la décision de l'administrateur.
     */
    const slot = await assertSlotBookable(body.date, body.time, { serviceId: service.id })
    if (!slot.ok) {
      throw new ApiError(409, slot.message, { code: `SLOT_${slot.reason.toUpperCase()}` })
    }

    // Jusqu'à 5 tentatives : la référence est aléatoire, une collision reste possible.
    let appointment = null
    for (let attempt = 0; attempt < 5 && !appointment; attempt += 1) {
      try {
        appointment = await insertAppointment({
          reference: generateReference(),
          serviceId: service.id,
          staffId: body.staffId ?? null,
          serviceName: service.name,
          date: body.date,
          time: slot.time,
          durationMinutes: service.durationMinutes,
          price: service.price,
          currency: service.currency,
          firstName: body.firstName,
          lastName: body.lastName,
          phone: body.phone,
          email: body.email,
          note: body.note ?? null,
        })
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error
        // Filet de sécurité : ne se déclenche que si la migration 003 n'a pas
        // encore été appliquée et que l'ancien index unique bloque encore.
        if (String(error.message).includes('uq_appointments_slot')) {
          throw ApiError.conflict(
            'Ce créneau vient d’être réservé. Merci d’en choisir un autre.',
            { code: 'SLOT_BOOKED' },
          )
        }
      }
    }

    if (!appointment) {
      throw new ApiError(500, 'Impossible de générer une référence unique. Réessayez.')
    }

    /*
     * La fiche cliente se crée ou se retrouve toute seule, par le numéro de
     * téléphone. Personne n'a à « saisir une cliente » : une corvée n'est
     * jamais faite, et la liste des clientes finirait vide.
     * Un échec ici ne doit pas faire perdre la demande de rendez-vous.
     */
    try {
      const cliente = await upsertFromAppointment({
        phone: body.phone,
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        birthDate: body.birthDate ?? null,
      })
      if (cliente) {
        await execute('UPDATE appointments SET customer_id = ? WHERE id = ?', [
          cliente.id,
          appointment.id,
        ])
      }
    } catch (error) {
      console.error('Fiche cliente non rattachée :', error.message)
    }

    /*
     * Seul le salon est prévenu : c'est lui qui doit agir. La cliente, elle,
     * ne reçoit rien tant qu'aucune décision n'a été prise — pas d'accusé de
     * réception qui pourrait se lire comme une confirmation.
     * Un e-mail en échec ne doit jamais faire échouer la demande.
     */
    Promise.allSettled([sendMail(appointmentCreatedToSalon(appointment))]).catch(() => {})

    return sendCreated(response, serializePublicAppointment(appointment))
  },
)

publicRouter.get(
  '/appointments/:reference',
  validate({ params: referenceParam }),
  async (request, response) => {
    const appointment = await findByReference(request.params.reference.toUpperCase())
    if (!appointment) throw ApiError.notFound('Aucun rendez-vous ne correspond à cette référence.')
    return sendData(response, serializePublicAppointment(appointment))
  },
)

// ══════════════ Admin ══════════════
export const adminRouter = Router()

const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  search: z.string().max(120).optional(),
  /** Sens du tri par date. Absent = « desc », le comportement historique. */
  order: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

adminRouter.get('/stats', async (_request, response) => {
  return sendData(response, await getStats())
})

/**
 * POST /admin/appointments — rendez-vous pris sur place.
 *
 * Une cliente qui pousse la porte du salon n'a pas à passer par le site. Ce
 * rendez-vous se distingue de ceux du site sur deux points, et sur deux
 * seulement :
 *
 *  – il naît CONFIRMÉ, puisque c'est le salon lui-même qui le prend ;
 *  – sa provenance est « comptoir », ce qui permet de savoir plus tard ce qui
 *    vient du site et ce qui vient de la boutique.
 *
 * Tout le reste suit exactement les mêmes règles que le site public : même
 * vérification de créneau, même fiche cliente rattachée par le numéro, même
 * proforma établi à la confirmation. Un rendez-vous pris au comptoir qui
 * échapperait au calcul de capacité ferait un salon en surbooking.
 */
adminRouter.post(
  '/appointments',
  validate({
    body: z.object({
      serviceId: z.coerce.number().int().positive(),
      date: z.iso.date(),
      time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Format attendu : HH:MM'),
      firstName: z.string().trim().min(2).max(80),
      lastName: z.string().trim().min(2).max(80),
      phone: z.string().trim().min(8).max(40),
      email: z.email('Adresse e-mail invalide.').max(160).or(z.literal('')).nullish().transform((v) => v ?? ''),
      note: z.string().trim().max(2000).nullish(),
      birthDate: z.iso.date().nullish(),
      staffId: z.coerce.number().int().positive().nullish(),
      officeId: z.coerce.number().int().positive().nullish(),
      /** Décochée quand le créneau est tenu malgré une alerte de capacité. */
      force: z.boolean().optional(),
    }),
  }),
  async (request, response) => {
    const body = request.body

    const service = await findServiceById(body.serviceId, { onlyActive: true })
    if (!service) throw ApiError.unprocessable('Cette prestation n’est pas disponible.')

    if (body.staffId) {
      const agent = await queryOne(
        'SELECT id FROM team_members WHERE id = ? AND is_active = 1 LIMIT 1',
        [body.staffId],
      )
      if (!agent) throw ApiError.unprocessable('Cet agent n’est pas disponible.')
    }
    if (body.officeId) {
      const bureau = await queryOne(
        'SELECT id FROM offices WHERE id = ? AND is_active = 1 LIMIT 1',
        [body.officeId],
      )
      if (!bureau) throw ApiError.unprocessable('Ce bureau n’est pas disponible.')
    }

    /*
     * Le salon peut passer outre — une cliente est devant le comptoir, et
     * refuser en invoquant un calcul serait absurde. Mais il doit le décider
     * sciemment : sans `force`, la règle s'applique comme pour le site.
     */
    const slot = await assertSlotBookable(body.date, body.time, { serviceId: service.id })
    if (!slot.ok && !body.force) {
      throw new ApiError(409, slot.message, {
        code: `SLOT_${String(slot.reason).toUpperCase()}`,
        details: { forceable: true },
      })
    }

    /* Même règle de places par jour que sur le site (coiffure, total…) ; le salon peut la lever sciemment. */
    const quota = await assertDayQuota(body.date, { coiffureId: service.id })
    if (!quota.ok && !body.force) {
      throw new ApiError(409, quota.message, { code: 'SLOT_QUOTA_FULL', details: { forceable: true } })
    }

    const heure = body.time.length === 5 ? `${body.time}:00` : body.time

    let appointment = null
    for (let essai = 0; essai < 5 && !appointment; essai += 1) {
      try {
        appointment = await insertAppointment({
          reference: generateReference(),
          serviceId: service.id,
          staffId: body.staffId ?? null,
          serviceName: service.name,
          date: body.date,
          time: slot.ok ? slot.time : heure,
          durationMinutes: service.durationMinutes,
          price: service.price,
          currency: service.currency,
          firstName: body.firstName,
          lastName: body.lastName,
          phone: body.phone,
          email: body.email,
          note: body.note ?? null,
          source: 'comptoir',
        })
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error
      }
    }
    if (!appointment) throw new ApiError(500, 'Impossible de générer une référence unique.')

    /* Confirmé d'emblée : le salon vient de le prendre lui-même. */
    await execute(
      "UPDATE appointments SET status = 'confirmed', confirmed_at = NOW(), office_id = ? WHERE id = ?",
      [body.officeId ?? null, appointment.id],
    )

    try {
      const cliente = await upsertFromAppointment({
        phone: body.phone,
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        birthDate: body.birthDate ?? null,
      })
      if (cliente) {
        await execute('UPDATE appointments SET customer_id = ? WHERE id = ?', [
          cliente.id,
          appointment.id,
        ])
      }
    } catch (error) {
      console.error('Fiche cliente non rattachée :', error.message)
    }

    let proforma = null
    try {
      proforma = await issueProforma(appointment.id, request.user)
    } catch (error) {
      console.error('Proforma non établi :', error.message)
    }

    const frais = await findById(appointment.id)
    return sendCreated(response, { ...serializeAppointment(frais), proforma })
  },
)

adminRouter.get('/appointments', validate({ query: listQuery }), async (request, response) => {
  const filters = getQuery(request)
  const pagination = readPagination({ query: filters })
  const { total, rows } = await listAppointments({ ...filters, ...pagination })
  return response.json({ success: true, data: rows, meta: paginationMeta(pagination, total) })
})

adminRouter.get('/appointments/:id', validate({ params: idParam }), async (request, response) => {
  const appointment = await findById(request.params.id)
  if (!appointment) throw ApiError.notFound('Ce rendez-vous n’existe pas.')
  return sendData(response, serializeAppointment(appointment))
})

adminRouter.patch(
  '/appointments/:id/status',
  validate({
    params: idParam,
    body: z.object({
      status: z.enum(STATUSES),
      cancelReason: z.string().max(255).nullish(),
      notify: z.boolean().optional(),
    }),
  }),
  async (request, response) => {
    const existing = await findById(request.params.id)
    if (!existing) throw ApiError.notFound('Ce rendez-vous n’existe pas.')

    /*
     * Une demande du site n'a pas encore d'heure ni de prix : on ne la confirme
     * pas d'un simple changement de statut, mais en la planifiant (jour, heure,
     * prix convenus avec la cliente) — c'est ce qui est annoncé à la cliente.
     */
    if (
      existing.source === 'site-v3' &&
      request.body.status === 'confirmed' &&
      ['pending', 'contacted'].includes(existing.status)
    ) {
      throw ApiError.unprocessable(
        'Cette demande du site se confirme avec « Confirmer et planifier » : jour, heure et prix convenus avec la cliente.',
      )
    }

    const updated = await updateStatus(request.params.id, request.body.status, {
      cancelReason: request.body.cancelReason ?? null,
    })

    /*
     * La cliente est prévenue du changement, sauf si l'administratrice a
     * décoché la case — utile pour rattraper une erreur de saisie sans
     * envoyer un second message contradictoire.
     *
     * Deux canaux, et c'est voulu. L'e-mail porte le détail (et existait
     * déjà) ; le SMS porte l'essentiel et se lit vraiment. À Abidjan, une
     * confirmation qui n'arrive que par e-mail n'arrive pas.
     *
     * Aucun des deux n'est attendu : un fournisseur SMS lent ne doit pas
     * faire patienter le salon devant son écran, et un envoi raté n'annule
     * pas la confirmation. La page Messagerie garde la trace de ce qui est
     * parti et de ce qui a échoué.
     */
    // Demande du site : le suivi (contactée, refusée…) est aussi reporté sur la demande d'origine.
    if (existing.source === 'site-v3') {
      await execute(
        `UPDATE booking_requests
            SET status = ?, handled_at = COALESCE(handled_at, NOW())
          WHERE appointment_id = ? AND ? IN ('pending','contacted','confirmed','rejected','cancelled','completed')`,
        [request.body.status, existing.id, request.body.status],
      ).catch(() => {})
    }

    if (request.body.notify !== false) {
      /*
       * Demande du site confirmée par le salon : récapitulatif COMPLET (rendez-vous, coiffure et modèle, durée, tarif,
       * paiement) par e-mail, WhatsApp ET SMS, à la place de l'ancien e-mail seul. Désactivé dans la Messagerie → ancien envoi.
       */
      if (request.body.status === 'confirmed' && existing.status !== 'confirmed' && existing.source === 'site-v3') {
        const ligne = await queryOne('SELECT * FROM booking_requests WHERE appointment_id = ? LIMIT 1', [existing.id]).catch(() => null)
        if (ligne) {
          const rdv = serializeAppointment(updated)
          const envoi = await envoyerRecapPaiement(
            ligne,
            { rendezVous: rdv, confirme: true, creneau: { date: rdv.date, time: String(rdv.time ?? '').slice(0, 5) }, sansWhatsapp: whatsappProvider() === 'meta' },
            request.user,
          ).catch(() => null)
          // Meta : l'ancien message WhatsApp (modèle approuvé) est conservé ; seuls e-mail + SMS passent par le récapitulatif.
          if (envoi !== null) {
            request.body.notify = 'recap'
            if (whatsappProvider() === 'meta') notifierCliente('request_confirmed', { appointment: rdv }, request.user, { canal: 'whatsapp' }).catch(() => {})
          }
        }
      }
    }

    if (request.body.notify !== false && request.body.notify !== 'recap') {
      // « Contactée » est une étape interne : pas d'e-mail, seulement le message WhatsApp prévu.
      if (request.body.status !== 'contacted') envoyerEmailStatut(updated)

      // Demande du site : les messages « demande » (WhatsApp) remplacent ceux d'un rendez-vous pris sur place.
      const evenement =
        (existing.source === 'site-v3' && EVENEMENT_PAR_STATUT_DEMANDE[request.body.status]) ||
        EVENEMENT_PAR_STATUT[request.body.status]
      if (evenement) {
        notifierCliente(
          evenement,
          { appointment: serializeAppointment(updated) },
          request.user,
        ).catch(() => {})
      }
    }

    /*
     * Une confirmation établit son proforma dans la foulée : c'est le
     * document qui annonce à la cliente ce qui est prévu et ce que cela
     * coûtera. Il n'est édité qu'au passage « en attente → confirmé », pour
     * qu'un aller-retour de statut n'en empile pas plusieurs.
     * Un échec d'édition n'annule jamais la confirmation elle-même.
     */
    let proforma = null
    if (request.body.status === 'confirmed' && existing.status !== 'confirmed') {
      try {
        proforma = await issueProforma(updated.id, request.user)
      } catch (error) {
        console.error('Proforma non établi :', error.message)
      }
    }

    return sendData(response, { ...serializeAppointment(updated), proforma })
  },
)

adminRouter.patch(
  '/appointments/:id',
  validate({
    params: idParam,
    body: z.object({
      date: z.iso.date().optional(),
      time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
      staffId: z.coerce.number().int().positive().nullish(),
      firstName: z.string().trim().min(2).max(80).optional(),
      lastName: z.string().trim().min(2).max(80).optional(),
      phone: z.string().trim().min(8).max(40).optional(),
      email: z.email().max(160).or(z.literal('')).optional(),
      note: z.string().max(2000).nullish(),
      force: z.boolean().optional(),
    }),
  }),
  async (request, response) => {
    const existing = await findById(request.params.id)
    if (!existing) throw ApiError.notFound('Ce rendez-vous n’existe pas.')

    const payload = { ...request.body }
    delete payload.force
    /* Un rendez-vous pris au salon déplacé vers un jour complet : même règle, le salon peut passer outre. */
    if (existing.source === 'comptoir' && payload.date && String(payload.date) !== String(existing.appointment_date instanceof Date ? existing.appointment_date.toISOString() : existing.appointment_date).slice(0, 10) && !request.body.force) {
      const quota = await assertDayQuota(payload.date, { coiffureId: existing.service_id, excludeAppointmentId: existing.id })
      if (!quota.ok) throw new ApiError(409, quota.message, { code: 'SLOT_QUOTA_FULL', details: { forceable: true } })
    }
    if (payload.time && payload.time.length === 5) payload.time = `${payload.time}:00`

    try {
      const updated = await updateAppointment(request.params.id, payload)
      return sendData(response, serializeAppointment(updated))
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw ApiError.conflict('Un autre rendez-vous occupe déjà ce créneau.')
      }
      throw error
    }
  },
)

adminRouter.delete('/appointments/:id', validate({ params: idParam }), async (request, response) => {
  if (!(await deleteAppointment(request.params.id))) {
    throw ApiError.notFound('Ce rendez-vous n’existe pas.')
  }
  return sendNoContent(response)
})
