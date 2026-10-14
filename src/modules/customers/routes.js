import { Router } from 'express'
import { z } from 'zod'

import {
  birthdaysOn,
  upcomingBirthdays,
  customerStats,
  deleteCustomer,
  findById,
  findByPhone,
  insertCustomer,
  listCustomers,
  listMessages,
  listVisits,
  serializeCustomer,
  serializePublicCustomer,
  updateCustomer,
} from './model.js'
import { query } from '../../config/database.js'
import { ApiError } from '../../lib/ApiError.js'
import { paginationMeta, readPagination, sendCreated, sendData, sendList, sendNoContent } from '../../lib/http.js'
import { telephoneValide } from '../../lib/phone.js'
import { requirePermission } from '../../middleware/auth.js'
import { getQuery, validate } from '../../middleware/validate.js'
import { lookupLimiter } from '../../middleware/rateLimit.js'

const idParam = z.object({ id: z.coerce.number().int().positive() })

const customerBody = z.object({
  phone: z.string().trim().min(8).max(40),
  firstName: z.string().trim().min(2).max(80),
  lastName: z.string().trim().min(2).max(80),
  email: z.union([z.email(), z.literal('')]).nullish(),
  birthDate: z.iso.date().nullish(),
  note: z.string().trim().max(2000).nullish(),
  smsOptIn: z.boolean().optional(),
  emailOptIn: z.boolean().optional(),
})

/* ═══════════════════════════════ Public ═══════════════════════════════ */

export const publicRouter = Router()

/**
 * GET /customers/lookup?phone=…
 *
 * « Êtes-vous déjà cliente ? » — la première étape de la réservation. Si le
 * numéro est connu, le formulaire se pré-remplit ; sinon la cliente continue
 * normalement.
 *
 * Deux précautions, parce que cette route est publique et qu'elle répond sur
 * des numéros de téléphone :
 *
 *  1. Elle ne renvoie QUE ce que la personne a elle-même saisi lors d'un
 *     rendez-vous — prénom, nom, e-mail. Ni historique, ni montants, ni date
 *     de naissance, ni identifiant interne.
 *  2. Elle est limitée en fréquence. Sans cela, on pourrait balayer les
 *     numéros d'un opérateur pour savoir lesquels appartiennent à des
 *     clientes du salon, ce qui n'est pas une information à donner.
 */
publicRouter.get(
  '/customers/lookup',
  lookupLimiter,
  validate({ query: z.object({ phone: z.string().trim().min(6).max(40) }) }),
  async (request, response) => {
    const { phone } = getQuery(request)

    if (!telephoneValide(phone)) {
      return sendData(response, { found: false, reason: 'invalid' })
    }

    const row = await findByPhone(phone)
    if (!row) return sendData(response, { found: false })

    return sendData(response, { found: true, customer: serializePublicCustomer(row) })
  },
)

/* ═══════════════════════════════ Admin ════════════════════════════════ */

export const adminRouter = Router()

adminRouter.use('/customers', requirePermission('customers'))

const listQuery = z.object({
  search: z.string().max(120).optional(),
  segment: z.enum(['new', 'returning', 'birthday']).optional(),
  order: z.enum(['recent', 'name', 'visits']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
})

adminRouter.get('/customers', validate({ query: listQuery }), async (request, response) => {
  const filters = getQuery(request)
  const pagination = readPagination({ query: filters })
  const { total, rows } = await listCustomers({ ...filters, ...pagination })
  return response.json({ success: true, data: rows, meta: paginationMeta(pagination, total) })
})

adminRouter.get('/customers/stats', async (_request, response) =>
  sendData(response, await customerStats()),
)

/** Anniversaires du jour, ou d'une date donnée. */
adminRouter.get(
  '/customers/birthdays',
  validate({ query: z.object({ date: z.iso.date().optional() }) }),
  async (request, response) => sendList(response, await birthdaysOn(getQuery(request).date ?? null)),
)

/**
 * GET /admin/customers/birthdays/upcoming?days=7
 *
 * Les anniversaires d'aujourd'hui et des jours suivants, pour la cloche du
 * tableau de bord. Chaque ligne porte `inDays` : 0 aujourd'hui, 1 demain —
 * l'écran n'a donc aucune date à recalculer.
 *
 * Déclarée AVANT « /customers/:id » : sans cela, « birthdays » serait pris
 * pour un identifiant et la route ne répondrait jamais.
 */
adminRouter.get(
  '/customers/birthdays/upcoming',
  validate({ query: z.object({ days: z.coerce.number().int().min(1).max(60).optional() }) }),
  async (request, response) =>
    sendList(response, await upcomingBirthdays({ days: getQuery(request).days ?? 7 })),
)

adminRouter.get('/customers/:id', validate({ params: idParam }), async (request, response) => {
  const row = await findById(request.params.id)
  if (!row) throw ApiError.notFound('Cette cliente n’existe pas.')

  const [visites, messages] = await Promise.all([
    listVisits(row.id),
    listMessages(row.id),
  ])

  return sendData(response, {
    ...serializeCustomer(row),
    visitHistory: visites,
    messages: messages.map((m) => ({
      id: m.id,
      channel: m.channel,
      kind: m.kind,
      subject: m.subject,
      body: m.body,
      status: m.status,
      error: m.error,
      sentByName: m.sent_by_name,
      createdAt: m.created_at,
      sentAt: m.sent_at,
    })),
  })
})

adminRouter.post('/customers', validate({ body: customerBody }), async (request, response) => {
  if (!telephoneValide(request.body.phone)) {
    throw ApiError.unprocessable('Ce numéro de téléphone est incomplet.')
  }
  const existante = await findByPhone(request.body.phone)
  if (existante) {
    throw ApiError.conflict(
      `Ce numéro est déjà celui de ${existante.first_name} ${existante.last_name}.`,
    )
  }
  return sendCreated(response, serializeCustomer(await insertCustomer(request.body)))
})

adminRouter.patch(
  '/customers/:id',
  validate({ params: idParam, body: customerBody.partial() }),
  async (request, response) => {
    const row = await findById(request.params.id)
    if (!row) throw ApiError.notFound('Cette cliente n’existe pas.')

    if (request.body.phone !== undefined) {
      if (!telephoneValide(request.body.phone)) {
        throw ApiError.unprocessable('Ce numéro de téléphone est incomplet.')
      }
      const autre = await findByPhone(request.body.phone)
      if (autre && autre.id !== row.id) {
        throw ApiError.conflict(
          `Ce numéro est déjà celui de ${autre.first_name} ${autre.last_name}.`,
        )
      }
    }

    return sendData(response, serializeCustomer(await updateCustomer(row.id, request.body)))
  },
)

adminRouter.delete('/customers/:id', validate({ params: idParam }), async (request, response) => {
  /*
   * Une cliente déjà venue n'est pas supprimée : son nom figure sur des
   * reçus, et sa fiche est le seul endroit où son historique se lit d'un
   * bloc. On le dit plutôt que d'effacer en silence.
   */
  const [{ total }] = await query(
    'SELECT COUNT(*) AS total FROM appointments WHERE customer_id = ?',
    [request.params.id],
  )
  if (Number(total) > 0) {
    throw ApiError.conflict(
      `Cette cliente a ${total} rendez-vous à son nom. Sa fiche ne peut pas être supprimée.`,
    )
  }

  if (!(await deleteCustomer(request.params.id))) {
    throw ApiError.notFound('Cette cliente n’existe pas.')
  }
  return sendNoContent(response)
})
