import { Router } from 'express'
import { z } from 'zod'

import {
  DISCOUNT_REASONS,
  OPERATION_STATUSES,
  TRANSITIONS,
  applyStep,
  computeTotals,
  deletePayment,
  formatMontant,
  findRow,
  getOperation,
  insertPayment,
  listHistory,
  listPayments,
  logEvent,
  markThanked,
  setAssignment,
  setDiscount,
} from './model.js'
import { query, queryOne } from '../../config/database.js'
import { ApiError } from '../../lib/ApiError.js'
import { paginationMeta, readPagination, sendData, sendList } from '../../lib/http.js'
import { appointmentThanksToCustomer, sendMail } from '../../lib/mailer.js'
import { notifierCliente } from '../messaging/notifications.js'
import { paymentEntryRemovable, recordPayment, removePaymentEntry } from '../accounting/model.js'
import { getQuery, validate } from '../../middleware/validate.js'

/**
 * Le parcours d'un rendez-vous confirmé, une route par étape.
 *
 *   confirmé → présence → en cours → terminé
 *
 * Chaque étape vérifie d'où elle part : on ne peut pas encaisser un
 * rendez-vous refusé, ni terminer une prestation qui n'a jamais commencé.
 * Refuser tôt vaut mieux que corriger après coup.
 *
 * L'auteur de chaque opération est TOUJOURS `request.user`, c'est-à-dire le
 * compte authentifié. Aucune de ces routes n'accepte un identifiant
 * d'utilisateur dans son corps : il n'existe aucun moyen d'enregistrer une
 * opération au nom de quelqu'un d'autre.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() })
const paymentParams = z.object({
  id: z.coerce.number().int().positive(),
  paymentId: z.coerce.number().int().positive(),
})

export const adminRouter = Router()

/** Charge le rendez-vous ou s'arrête net. */
async function loadRow(id) {
  const row = await findRow(id)
  if (!row) throw ApiError.notFound('Ce rendez-vous n’existe pas.')
  return row
}

/* ══════════════════ Liste des rendez-vous à traiter ══════════════════ */

const listQuery = z.object({
  status: z.enum([...OPERATION_STATUSES, 'cancelled', 'rejected', 'no_show']).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  search: z.string().max(120).optional(),
  officeId: z.coerce.number().int().positive().optional(),
  agentId: z.coerce.number().int().positive().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

/**
 * GET /admin/operations
 *
 * Les rendez-vous dont le salon s'occupe vraiment : confirmés, cliente
 * arrivée, prestation en cours, prestation terminée. Sans filtre de statut,
 * ces quatre-là et eux seuls — un rendez-vous encore en attente appartient à
 * la page « Rendez-vous », pas à celle-ci.
 */
adminRouter.get('/operations', validate({ query: listQuery }), async (request, response) => {
  const filters = getQuery(request)
  const pagination = readPagination({ query: filters })

  const conditions = []
  const params = []

  if (filters.status) {
    conditions.push('a.status = ?')
    params.push(filters.status)
  } else {
    conditions.push(`a.status IN (${OPERATION_STATUSES.map(() => '?').join(', ')})`)
    params.push(...OPERATION_STATUSES)
  }
  if (filters.from) {
    conditions.push('a.appointment_date >= ?')
    params.push(filters.from)
  }
  if (filters.to) {
    conditions.push('a.appointment_date <= ?')
    params.push(filters.to)
  }
  if (filters.officeId) {
    conditions.push('a.office_id = ?')
    params.push(filters.officeId)
  }
  if (filters.agentId) {
    conditions.push('a.staff_id = ?')
    params.push(filters.agentId)
  }
  if (filters.search) {
    conditions.push(
      '(a.reference LIKE ? OR a.first_name LIKE ? OR a.last_name LIKE ? OR a.email LIKE ? OR a.phone LIKE ?)',
    )
    const like = `%${filters.search}%`
    params.push(like, like, like, like, like)
  }

  const where = `WHERE ${conditions.join(' AND ')}`
  const direction = String(filters.order ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC'

  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM appointments a ${where}`, params)

  const rows = await query(
    `SELECT a.id, a.reference, a.status, a.appointment_date, a.appointment_time,
            a.duration_minutes, a.service_name, a.price, a.currency, a.discount_amount,
            a.first_name, a.last_name, a.phone, a.email, a.arrived_at,
            t.name AS staff_name, o.number AS office_number, o.name AS office_name,
            (SELECT COALESCE(SUM(p.amount), 0) FROM appointment_payments p
              WHERE p.appointment_id = a.id) AS paid
     FROM appointments a
     LEFT JOIN team_members t ON t.id = a.staff_id
     LEFT JOIN offices      o ON o.id = a.office_id
     ${where}
     ORDER BY a.appointment_date ${direction}, a.appointment_time ${direction}
     LIMIT ${Number(pagination.limit)} OFFSET ${Number(pagination.offset)}`,
    params,
  )

  const data = rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    status: row.status,
    date: row.appointment_date,
    time: String(row.appointment_time).slice(0, 5),
    durationMinutes: Number(row.duration_minutes),
    serviceName: row.service_name,
    customer: {
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone,
      email: row.email,
    },
    agentName: row.staff_name,
    office: row.office_number ? { number: row.office_number, name: row.office_name } : null,
    present: Boolean(row.arrived_at),
    totals: computeTotals(row, [{ amount: row.paid }]),
  }))

  return response.json({
    success: true,
    data,
    meta: paginationMeta(pagination, Number(total)),
  })
})

/** Les motifs de réduction proposés — la liste vit ici, pas dans l'écran. */
adminRouter.get('/operations/discount-reasons', async (_request, response) =>
  sendList(response, DISCOUNT_REASONS),
)

/* ══════════════════════ Fiche d'un rendez-vous ══════════════════════ */

adminRouter.get(
  '/appointments/:id/operation',
  validate({ params: idParam }),
  async (request, response) => {
    const operation = await getOperation(request.params.id)
    if (!operation) throw ApiError.notFound('Ce rendez-vous n’existe pas.')
    return sendData(response, operation)
  },
)

/* ═══════════════════ Bureau et agent affectés ═══════════════════ */

const assignmentBody = z.object({
  officeId: z.coerce.number().int().positive().nullish(),
  staffId: z.coerce.number().int().positive().nullish(),
})

/** Ni bureau ni agent désactivé, ni l'un ni l'autre inexistant. */
async function resolveAssignment(body) {
  const result = {}

  if (body.officeId !== undefined) {
    if (body.officeId === null) result.officeId = null
    else {
      const office = await queryOne(
        'SELECT id, number, name, is_active, agent_id FROM offices WHERE id = ? LIMIT 1',
        [body.officeId],
      )
      if (!office) throw ApiError.unprocessable('Ce bureau n’existe pas.')
      if (!Number(office.is_active)) throw ApiError.unprocessable('Ce bureau est désactivé.')
      result.officeId = office.id
      result.office = office
    }
  }

  if (body.staffId !== undefined) {
    if (body.staffId === null) result.staffId = null
    else {
      const agent = await queryOne(
        'SELECT id, name, is_active FROM team_members WHERE id = ? LIMIT 1',
        [body.staffId],
      )
      if (!agent) throw ApiError.unprocessable('Cet agent n’existe pas.')
      if (!Number(agent.is_active)) throw ApiError.unprocessable('Cet agent est désactivé.')
      result.staffId = agent.id
      result.agent = agent
    }
  }

  return result
}

adminRouter.patch(
  '/appointments/:id/assignment',
  validate({ params: idParam, body: assignmentBody }),
  async (request, response) => {
    const row = await loadRow(request.params.id)
    if (!OPERATION_STATUSES.includes(row.status)) {
      throw ApiError.conflict('Ce rendez-vous n’est pas au stade du traitement.')
    }

    const resolved = await resolveAssignment(request.body)
    await setAssignment(row.id, resolved)

    const parts = []
    if (resolved.officeId !== undefined) {
      parts.push(
        resolved.office
          ? `bureau ${resolved.office.number} — ${resolved.office.name}`
          : 'bureau retiré',
      )
    }
    if (resolved.staffId !== undefined) {
      parts.push(resolved.agent ? `agent ${resolved.agent.name}` : 'agent retiré')
    }
    if (parts.length) await logEvent(row.id, 'assignment', `Affectation : ${parts.join(', ')}`, request.user)

    return sendData(response, await getOperation(row.id))
  },
)

/* ══════════════════════════ Étapes ══════════════════════════ */

/**
 * POST /admin/appointments/:id/arrival — « Client présent ».
 *
 * Enregistre la présence, l'instant et l'utilisateur connecté. Le bureau et
 * l'agent peuvent être posés dans le même geste : c'est ce que fait l'écran,
 * pour que l'administratrice n'ait qu'un bouton à actionner à l'accueil.
 */
adminRouter.post(
  '/appointments/:id/arrival',
  validate({ params: idParam, body: assignmentBody.optional().default({}) }),
  async (request, response) => {
    const row = await loadRow(request.params.id)

    if (row.status === 'arrived') throw ApiError.conflict('La présence est déjà enregistrée.')
    if (!TRANSITIONS.arrival.from.includes(row.status)) {
      throw ApiError.conflict(
        'Seul un rendez-vous confirmé peut recevoir la présence de la cliente.',
      )
    }

    const resolved = await resolveAssignment(request.body ?? {})
    if (Object.keys(resolved).length) await setAssignment(row.id, resolved)

    await applyStep(row.id, 'arrival', request.user)
    await logEvent(row.id, 'arrival', TRANSITIONS.arrival.label, request.user)

    return sendData(response, await getOperation(row.id))
  },
)

adminRouter.post(
  '/appointments/:id/start',
  validate({ params: idParam }),
  async (request, response) => {
    const row = await loadRow(request.params.id)
    if (row.status === 'in_progress') throw ApiError.conflict('La prestation est déjà en cours.')
    if (!TRANSITIONS.start.from.includes(row.status)) {
      throw ApiError.conflict('Enregistrez d’abord la présence de la cliente.')
    }

    await applyStep(row.id, 'start', request.user)
    await logEvent(row.id, 'start', TRANSITIONS.start.label, request.user)

    return sendData(response, await getOperation(row.id))
  },
)

/**
 * POST /admin/appointments/:id/complete — fin de la prestation.
 *
 * Déclenche le remerciement, par e-mail ET par SMS : l'e-mail porte le
 * détail, le SMS se lit vraiment. `thanked_at` garantit qu'il ne part qu'une
 * fois — repasser par « Terminé » après coup ne renverra rien.
 *
 * Le marquage se fait APRÈS avoir lancé les deux envois, et sans attendre
 * qu'ils réussissent. C'est délibéré : si le drapeau ne se posait qu'en cas
 * de succès, une passerelle capricieuse remercierait la même cliente deux
 * ou trois fois. Mieux vaut un remerciement manquant — que le salon voit
 * dans la page Messagerie et peut renvoyer à la main — qu'un remerciement
 * répété. Un échec d'envoi n'annule jamais la fin de prestation.
 */
adminRouter.post(
  '/appointments/:id/complete',
  validate({ params: idParam, body: z.object({ notify: z.boolean().optional() }).optional().default({}) }),
  async (request, response) => {
    const row = await loadRow(request.params.id)
    if (row.status === 'completed') throw ApiError.conflict('Cette prestation est déjà terminée.')
    if (!TRANSITIONS.complete.from.includes(row.status)) {
      throw ApiError.conflict('Enregistrez d’abord la présence de la cliente.')
    }

    await applyStep(row.id, 'complete', request.user)
    await logEvent(row.id, 'complete', TRANSITIONS.complete.label, request.user)

    const notify = request.body?.notify !== false
    if (notify && !row.thanked_at) {
      const fresh = await findRow(row.id)

      sendMail(appointmentThanksToCustomer(fresh)).catch(() => {})
      notifierCliente(
        'thanks',
        {
          appointment: {
            id: fresh.id,
            customerId: fresh.customer_id,
            reference: fresh.reference,
            date: fresh.appointment_date,
            time: fresh.appointment_time,
            price: Number(fresh.price),
            currency: fresh.currency,
            service: { name: fresh.service_name },
            customer: {
              firstName: fresh.first_name,
              lastName: fresh.last_name,
              phone: fresh.phone,
              email: fresh.email,
            },
          },
        },
        request.user,
      ).catch(() => {})

      await markThanked(row.id)
      await logEvent(row.id, 'mail', 'Remerciement envoyé à la cliente', request.user)
    }

    return sendData(response, await getOperation(row.id))
  },
)

/* ═══════════════════════════ Réduction ═══════════════════════════ */

const discountBody = z.object({
  amount: z.coerce.number().min(0),
  reason: z.enum(DISCOUNT_REASONS.map((item) => item.value)).nullish(),
  note: z.string().trim().max(255).nullish(),
})

/**
 * PUT /admin/appointments/:id/discount
 *
 * Deux garde-fous, tous deux nécessaires :
 *  – la réduction ne peut pas dépasser le prix, sinon le montant final
 *    deviendrait négatif ;
 *  – elle ne peut pas descendre le montant à payer sous ce qui a déjà été
 *    encaissé, ce qui laisserait un trop-perçu que rien ne sait traiter.
 */
adminRouter.put(
  '/appointments/:id/discount',
  validate({ params: idParam, body: discountBody }),
  async (request, response) => {
    const row = await loadRow(request.params.id)
    if (!OPERATION_STATUSES.includes(row.status)) {
      throw ApiError.conflict('Ce rendez-vous n’est pas au stade du traitement.')
    }

    const price = Number(row.price)
    const amount = Math.round(Number(request.body.amount) * 100) / 100

    if (amount > price) {
      throw ApiError.unprocessable(
        'La réduction ne peut pas dépasser le montant de la prestation.',
      )
    }

    const payments = await listPayments(row.id)
    const paid = payments.reduce((sum, payment) => sum + Number(payment.amount), 0)
    if (price - amount < paid) {
      throw ApiError.unprocessable(
        `Cette réduction ramènerait le total sous les ${formatMontant(paid, row.currency)} déjà encaissés.`,
      )
    }

    if (amount > 0 && !request.body.reason) {
      throw ApiError.unprocessable('Indiquez le motif de la réduction.')
    }

    await setDiscount(
      row.id,
      {
        amount,
        reason: amount > 0 ? request.body.reason : null,
        note: amount > 0 ? (request.body.note ?? null) : null,
      },
      request.user,
    )

    const label =
      amount > 0
        ? `Réduction de ${formatMontant(amount, row.currency)} (${
            DISCOUNT_REASONS.find((item) => item.value === request.body.reason)?.label ?? 'motif non précisé'
          })`
        : 'Réduction retirée'
    await logEvent(row.id, 'discount', label, request.user)

    return sendData(response, await getOperation(row.id))
  },
)

/* ═══════════════════════════ Paiements ═══════════════════════════ */

const paymentBody = z.object({
  amount: z.coerce.number().positive('Le montant doit être supérieur à zéro.'),
  note: z.string().trim().max(255).nullish(),
})

/**
 * POST /admin/appointments/:id/payments — un versement, en espèces.
 *
 * Plusieurs versements sont possibles : c'est ainsi que se règle un paiement
 * partiel. Le total encaissé ne peut jamais dépasser le montant à payer — un
 * trop-perçu n'a pas de sens ici et n'aurait aucune issue dans le reçu.
 */
adminRouter.post(
  '/appointments/:id/payments',
  validate({ params: idParam, body: paymentBody }),
  async (request, response) => {
    const row = await loadRow(request.params.id)
    if (!OPERATION_STATUSES.includes(row.status)) {
      throw ApiError.conflict('Ce rendez-vous n’est pas au stade du traitement.')
    }
    if (!row.arrived_at) {
      throw ApiError.conflict('Enregistrez d’abord la présence de la cliente.')
    }

    const payments = await listPayments(row.id)
    const totals = computeTotals(row, payments)
    const amount = Math.round(Number(request.body.amount) * 100) / 100

    if (totals.balance <= 0) {
      throw ApiError.conflict('Cette prestation est déjà entièrement réglée.')
    }
    if (amount > totals.balance) {
      throw ApiError.unprocessable(
        `Le versement dépasse le reste à payer (${formatMontant(totals.balance, row.currency)}).`,
      )
    }

    const paymentId = await insertPayment(
      row.id,
      { amount, note: request.body.note ?? null },
      request.user,
    )
    await logEvent(
      row.id,
      'payment',
      `Versement de ${formatMontant(amount, row.currency)} en espèces`,
      request.user,
    )

    /*
     * L'argent encaissé entre en caisse dans le même geste. Le salon ne
     * saisit jamais deux fois la même recette : la comptabilité se remplit
     * toute seule à partir des versements, et c'est la seule façon que la
     * caisse et les reçus disent la même chose.
     * Un échec ici ne doit pas annuler l'encaissement lui-même.
     */
    try {
      await recordPayment(
        { payment: { id: paymentId, amount }, appointment: row },
        request.user,
      )
    } catch (error) {
      console.error('Écriture de caisse non enregistrée :', error.message)
    }

    return sendData(response, await getOperation(row.id))
  },
)

/**
 * DELETE …/payments/:paymentId — annule un versement saisi par erreur.
 * L'opération reste inscrite au journal : le versement disparaît des
 * comptes, pas de l'historique.
 */
adminRouter.delete(
  '/appointments/:id/payments/:paymentId',
  validate({ params: paymentParams }),
  async (request, response) => {
    const row = await loadRow(request.params.id)
    const payment = await queryOne(
      'SELECT amount FROM appointment_payments WHERE id = ? AND appointment_id = ? LIMIT 1',
      [request.params.paymentId, row.id],
    )
    if (!payment) throw ApiError.notFound('Ce versement n’existe pas.')

    /*
     * Retirer ce versement videra la caisse d'autant. Si l'argent a déjà
     * servi, la caisse passerait sous zéro — un compte qui affirme contenir
     * moins que rien. On refuse, en disant par quoi commencer.
     */
    const possible = await paymentEntryRemovable(request.params.paymentId)
    if (!possible.ok) {
      throw ApiError.conflict(
        `Annuler ce versement ferait passer « ${possible.account} » à ${-possible.shortfall} FCFA. ` +
          'Retirez d’abord les dépenses réglées avec cet argent, puis revenez annuler le versement.',
        { code: 'CASH_WOULD_GO_NEGATIVE', details: possible },
      )
    }

    await deletePayment(row.id, request.params.paymentId)
    // L'écriture de caisse suit le versement qu'elle représentait.
    await removePaymentEntry(request.params.paymentId)
    await logEvent(
      row.id,
      'payment',
      `Versement de ${formatMontant(payment.amount, row.currency)} annulé`,
      request.user,
    )

    return sendData(response, await getOperation(row.id))
  },
)

/* ══════════════════════ Historique des clientes ══════════════════════ */

const historyQuery = z.object({
  search: z.string().max(120).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  status: z.enum(['completed', 'no_show']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

adminRouter.get('/history', validate({ query: historyQuery }), async (request, response) => {
  const filters = getQuery(request)
  const pagination = readPagination({ query: filters })
  const { total, rows } = await listHistory({ ...filters, ...pagination })
  return response.json({ success: true, data: rows, meta: paginationMeta(pagination, total) })
})

export default adminRouter
