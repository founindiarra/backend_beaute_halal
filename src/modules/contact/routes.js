import { Router } from 'express'
import { z } from 'zod'

import { query, queryOne, execute } from '../../config/database.js'
import { ApiError } from '../../lib/ApiError.js'
import {
  paginationMeta,
  readPagination,
  sendCreated,
  sendData,
  sendNoContent,
} from '../../lib/http.js'
import { contactMessageToSalon, sendMail } from '../../lib/mailer.js'
import { getQuery, validate } from '../../middleware/validate.js'
import { contactLimiter } from '../../middleware/rateLimit.js'

const serialize = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  phone: row.phone,
  message: row.message,
  status: row.status,
  readAt: row.read_at,
  createdAt: row.created_at,
})

const createBody = z.object({
  name: z.string().trim().min(2, 'Merci d’indiquer votre nom.').max(120),
  email: z.email('Adresse e-mail invalide.').max(160),
  phone: z.string().trim().max(40).nullish(),
  message: z.string().trim().min(10, 'Votre message est un peu court.').max(4000),
  // Champ piège invisible : s'il est rempli, c'est un robot.
  website: z.string().max(0).optional(),
})

const idParam = z.object({ id: z.coerce.number().int().positive() })

// ══════════════ Public ══════════════
export const publicRouter = Router()

publicRouter.post(
  '/contact',
  contactLimiter,
  validate({ body: createBody }),
  async (request, response) => {
    const { name, email, phone, message } = request.body

    const result = await execute(
      'INSERT INTO contact_messages (name, email, phone, message, ip_address) VALUES (?, ?, ?, ?, ?)',
      [name, email, phone || null, message, request.ip?.slice(0, 45) ?? null],
    )

    sendMail(contactMessageToSalon({ name, email, phone, message })).catch(() => {})

    return sendCreated(response, {
      id: result.insertId,
      message: 'Votre message a bien été enregistré. Nous vous répondons rapidement.',
    })
  },
)

// ══════════════ Admin ══════════════
export const adminRouter = Router()

const listQuery = z.object({
  status: z.enum(['new', 'read', 'archived']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

adminRouter.get('/messages', validate({ query: listQuery }), async (request, response) => {
  const filters = getQuery(request)
  const pagination = readPagination({ query: filters })

  const where = filters.status ? 'WHERE status = ?' : ''
  const params = filters.status ? [filters.status] : []

  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM contact_messages ${where}`, params)
  const rows = await query(
    `SELECT id, name, email, phone, message, status, read_at, created_at
     FROM contact_messages ${where}
     ORDER BY created_at DESC
     LIMIT ${Number(pagination.limit)} OFFSET ${Number(pagination.offset)}`,
    params,
  )

  return response.json({
    success: true,
    data: rows.map(serialize),
    meta: paginationMeta(pagination, Number(total)),
  })
})

adminRouter.get('/messages/:id', validate({ params: idParam }), async (request, response) => {
  const row = await queryOne(
    'SELECT id, name, email, phone, message, status, read_at, created_at FROM contact_messages WHERE id = ?',
    [request.params.id],
  )
  if (!row) throw ApiError.notFound('Ce message n’existe pas.')
  return sendData(response, serialize(row))
})

adminRouter.patch(
  '/messages/:id',
  validate({ params: idParam, body: z.object({ status: z.enum(['new', 'read', 'archived']) }) }),
  async (request, response) => {
    const result = await execute(
      `UPDATE contact_messages
       SET status = ?, read_at = IF(? <> 'new' AND read_at IS NULL, NOW(), read_at)
       WHERE id = ?`,
      [request.body.status, request.body.status, request.params.id],
    )
    if (!result.affectedRows) throw ApiError.notFound('Ce message n’existe pas.')

    const row = await queryOne(
      'SELECT id, name, email, phone, message, status, read_at, created_at FROM contact_messages WHERE id = ?',
      [request.params.id],
    )
    return sendData(response, serialize(row))
  },
)

adminRouter.delete('/messages/:id', validate({ params: idParam }), async (request, response) => {
  const result = await execute('DELETE FROM contact_messages WHERE id = ?', [request.params.id])
  if (!result.affectedRows) throw ApiError.notFound('Ce message n’existe pas.')
  return sendNoContent(response)
})
