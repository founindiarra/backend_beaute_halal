import { Router } from 'express'
import { z } from 'zod'

import { query, queryOne, execute } from '../../config/database.js'
import { ApiError } from '../../lib/ApiError.js'
import { sendCreated, sendData, sendList, sendNoContent } from '../../lib/http.js'
import { toBool } from '../../lib/url.js'
import { validate } from '../../middleware/validate.js'

/*
 * `appointmentId` rattache un avis à la prestation qui l'a inspiré.
 *
 * C'est un identifiant, jamais un rapprochement de noms : deux clientes
 * peuvent s'appeler pareil, et une correspondance approximative finirait par
 * afficher l'avis de l'une sous la prestation de l'autre.
 *
 * Le champ est facultatif. Un avis sans rendez-vous rattaché reste
 * parfaitement valide et s'affiche exactement comme avant sur le site
 * public — il n'apparaît simplement pas dans l'historique.
 */
const serialize = (row) => ({
  id: row.id,
  appointmentId: row.appointment_id ?? null,
  appointmentReference: row.appointment_reference ?? null,
  firstName: row.first_name,
  rating: Number(row.rating),
  comment: row.comment,
  serviceName: row.service_name,
  reviewedOn: row.reviewed_on,
  isPublished: toBool(row.is_published),
  position: Number(row.position),
})

const FIELDS = `t.id, t.appointment_id, t.first_name, t.rating, t.comment, t.service_name,
         t.reviewed_on, t.is_published, t.position, a.reference AS appointment_reference
  FROM testimonials t
  LEFT JOIN appointments a ON a.id = t.appointment_id`

async function listTestimonials({ onlyPublished = true } = {}) {
  const rows = await query(
    `SELECT ${FIELDS} ${onlyPublished ? 'WHERE t.is_published = 1' : ''}
     ORDER BY t.position, t.reviewed_on DESC, t.id DESC`,
  )
  return rows.map(serialize)
}

async function findTestimonial(id) {
  const row = await queryOne(`SELECT ${FIELDS} WHERE t.id = ? LIMIT 1`, [id])
  return row ? serialize(row) : null
}

const idParam = z.object({ id: z.coerce.number().int().positive() })

const body = z.object({
  appointmentId: z.coerce.number().int().positive().nullish(),
  firstName: z.string().min(2).max(80),
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().min(5).max(2000),
  serviceName: z.string().max(140).nullish(),
  reviewedOn: z.iso.date().nullish(),
  isPublished: z.boolean().optional(),
  position: z.coerce.number().int().min(0).max(9999).optional(),
})

// ══════════════ Public ══════════════
export const publicRouter = Router()

publicRouter.get('/testimonials', async (_request, response) => {
  const items = await listTestimonials()
  const average = items.length
    ? Math.round((items.reduce((sum, item) => sum + item.rating, 0) / items.length) * 10) / 10
    : 0
  return response.json({
    success: true,
    data: items,
    meta: { total: items.length, averageRating: average },
  })
})

// ══════════════ Admin ══════════════
export const adminRouter = Router()

adminRouter.get('/testimonials', async (_request, response) => {
  return sendList(response, await listTestimonials({ onlyPublished: false }))
})

adminRouter.post('/testimonials', validate({ body }), async (request, response) => {
  const result = await execute(
    `INSERT INTO testimonials
       (appointment_id, first_name, rating, comment, service_name, reviewed_on,
        is_published, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      request.body.appointmentId ?? null,
      request.body.firstName,
      request.body.rating,
      request.body.comment,
      request.body.serviceName ?? null,
      request.body.reviewedOn ?? null,
      request.body.isPublished === false ? 0 : 1,
      request.body.position ?? 0,
    ],
  )
  return sendCreated(response, await findTestimonial(result.insertId))
})

adminRouter.patch(
  '/testimonials/:id',
  validate({ params: idParam, body: body.partial() }),
  async (request, response) => {
    if (!(await findTestimonial(request.params.id))) {
      throw ApiError.notFound('Cet avis n’existe pas.')
    }

    const columns = {
      appointmentId: 'appointment_id',
      firstName: 'first_name',
      rating: 'rating',
      comment: 'comment',
      serviceName: 'service_name',
      reviewedOn: 'reviewed_on',
      isPublished: 'is_published',
      position: 'position',
    }
    const fields = []
    const params = []
    for (const [key, column] of Object.entries(columns)) {
      if (request.body[key] === undefined) continue
      fields.push(`${column} = ?`)
      const value = request.body[key]
      params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
    }
    if (fields.length) {
      params.push(request.params.id)
      await execute(`UPDATE testimonials SET ${fields.join(', ')} WHERE id = ?`, params)
    }
    return sendData(response, await findTestimonial(request.params.id))
  },
)

adminRouter.delete('/testimonials/:id', validate({ params: idParam }), async (request, response) => {
  const result = await execute('DELETE FROM testimonials WHERE id = ?', [request.params.id])
  if (!result.affectedRows) throw ApiError.notFound('Cet avis n’existe pas.')
  return sendNoContent(response)
})
