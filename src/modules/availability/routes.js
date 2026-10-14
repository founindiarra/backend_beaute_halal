import { Router } from 'express'
import { z } from 'zod'

import { addDays, getDays, getSlots, toDateKey } from './service.js'
import { query, execute } from '../../config/database.js'
import { ApiError } from '../../lib/ApiError.js'
import { sendCreated, sendData, sendList, sendNoContent } from '../../lib/http.js'
import { toShortTime } from '../../lib/url.js'
import { getQuery, validate } from '../../middleware/validate.js'
import { getOpeningHours, serializeHours } from '../salon/model.js'

/*
 * `serviceId` est facultatif et additif : sans lui, l'API répond exactement
 * comme avant. Avec lui, la durée de CETTE prestation entre dans le calcul,
 * et une date peut être déclarée complète pour une coiffure longue tout en
 * restant ouverte pour une plus courte. C'est la seule façon d'être exact :
 * « complet » n'a pas de sens tant qu'on ignore ce qui est demandé.
 */
const daysQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  serviceId: z.coerce.number().int().positive().optional(),
})

const slotsQuery = z.object({
  date: z.iso.date(),
  serviceId: z.coerce.number().int().positive().optional(),
})

// ══════════════ Public ══════════════
export const publicRouter = Router()

publicRouter.get('/availability/days', validate({ query: daysQuery }), async (request, response) => {
  const { from, to, serviceId } = getQuery(request)
  const start = from || toDateKey()
  const end = to || addDays(start, 60)

  if (end < start) throw ApiError.badRequest('La date de fin précède la date de début.')
  if (end > addDays(start, 120)) {
    throw ApiError.badRequest('La plage demandée ne peut pas dépasser 120 jours.')
  }

  const result = await getDays(start, end, { serviceId: serviceId ?? null })
  return sendData(response, { from: start, to: end, ...result })
})

publicRouter.get(
  '/availability/slots',
  validate({ query: slotsQuery }),
  async (request, response) => {
    const { date, serviceId } = getQuery(request)
    return sendData(response, await getSlots(date, { serviceId: serviceId ?? null }))
  },
)

publicRouter.get('/availability/opening-hours', async (_request, response) => {
  return sendList(response, serializeHours(await getOpeningHours()))
})

// ══════════════ Admin ══════════════
export const adminRouter = Router()

const hoursBody = z.object({
  hours: z
    .array(
      z.object({
        weekday: z.coerce.number().int().min(0).max(6),
        isClosed: z.boolean(),
        opensAt: z
          .string()
          .regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Format attendu : HH:MM')
          .nullish(),
        closesAt: z
          .string()
          .regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Format attendu : HH:MM')
          .nullish(),
      }),
    )
    .min(1)
    .max(7),
})

const slotBody = z.object({
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Format attendu : HH:MM'),
  position: z.coerce.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional(),
})

const closureBody = z.object({
  date: z.iso.date(),
  reason: z.string().max(160).nullish(),
})

const idParam = z.object({ id: z.coerce.number().int().positive() })
const withSeconds = (time) => (time && time.length === 5 ? `${time}:00` : time)

adminRouter.get('/opening-hours', async (_request, response) => {
  return sendList(response, serializeHours(await getOpeningHours()))
})

adminRouter.put('/opening-hours', validate({ body: hoursBody }), async (request, response) => {
  for (const day of request.body.hours) {
    if (!day.isClosed && (!day.opensAt || !day.closesAt)) {
      throw ApiError.unprocessable(
        `Jour ${day.weekday} : indiquez une heure d’ouverture et de fermeture, ou marquez-le fermé.`,
      )
    }
    await execute(
      `INSERT INTO opening_hours (weekday, is_closed, opens_at, closes_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE is_closed = VALUES(is_closed),
                               opens_at  = VALUES(opens_at),
                               closes_at = VALUES(closes_at)`,
      [
        day.weekday,
        day.isClosed ? 1 : 0,
        day.isClosed ? null : withSeconds(day.opensAt),
        day.isClosed ? null : withSeconds(day.closesAt),
      ],
    )
  }
  return sendList(response, serializeHours(await getOpeningHours()))
})

const listSlots = async () => {
  const rows = await query(
    'SELECT id, start_time, position, is_active FROM time_slots ORDER BY position, start_time',
  )
  return rows.map((row) => ({
    id: row.id,
    startTime: toShortTime(row.start_time),
    position: Number(row.position),
    isActive: Boolean(Number(row.is_active)),
  }))
}

adminRouter.get('/time-slots', async (_request, response) => {
  return sendList(response, await listSlots())
})

adminRouter.post('/time-slots', validate({ body: slotBody }), async (request, response) => {
  await execute(
    'INSERT INTO time_slots (start_time, position, is_active) VALUES (?, ?, ?)',
    [
      withSeconds(request.body.startTime),
      request.body.position ?? 0,
      request.body.isActive === false ? 0 : 1,
    ],
  )
  return sendCreated(response, await listSlots())
})

adminRouter.patch(
  '/time-slots/:id',
  validate({ params: idParam, body: slotBody.partial() }),
  async (request, response) => {
    const fields = []
    const params = []
    if (request.body.startTime !== undefined) {
      fields.push('start_time = ?')
      params.push(withSeconds(request.body.startTime))
    }
    if (request.body.position !== undefined) {
      fields.push('position = ?')
      params.push(request.body.position)
    }
    if (request.body.isActive !== undefined) {
      fields.push('is_active = ?')
      params.push(request.body.isActive ? 1 : 0)
    }
    if (!fields.length) throw ApiError.badRequest('Aucun champ à mettre à jour.')

    params.push(request.params.id)
    const result = await execute(`UPDATE time_slots SET ${fields.join(', ')} WHERE id = ?`, params)
    if (!result.affectedRows) throw ApiError.notFound('Ce créneau n’existe pas.')
    return sendList(response, await listSlots())
  },
)

adminRouter.delete('/time-slots/:id', validate({ params: idParam }), async (request, response) => {
  const result = await execute('DELETE FROM time_slots WHERE id = ?', [request.params.id])
  if (!result.affectedRows) throw ApiError.notFound('Ce créneau n’existe pas.')
  return sendNoContent(response)
})

adminRouter.get('/closures', async (_request, response) => {
  const rows = await query(
    'SELECT id, closure_date, reason FROM closures ORDER BY closure_date DESC',
  )
  return sendList(
    response,
    rows.map((row) => ({ id: row.id, date: row.closure_date, reason: row.reason })),
  )
})

adminRouter.post('/closures', validate({ body: closureBody }), async (request, response) => {
  const result = await execute(
    'INSERT INTO closures (closure_date, reason) VALUES (?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason)',
    [request.body.date, request.body.reason ?? null],
  )
  return sendCreated(response, {
    id: result.insertId,
    date: request.body.date,
    reason: request.body.reason ?? null,
  })
})

adminRouter.delete('/closures/:id', validate({ params: idParam }), async (request, response) => {
  const result = await execute('DELETE FROM closures WHERE id = ?', [request.params.id])
  if (!result.affectedRows) throw ApiError.notFound('Cette fermeture n’existe pas.')
  return sendNoContent(response)
})
