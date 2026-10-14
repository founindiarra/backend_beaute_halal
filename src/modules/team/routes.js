import { Router } from 'express'
import { z } from 'zod'

import { query, queryOne, execute } from '../../config/database.js'
import { ApiError } from '../../lib/ApiError.js'
import { sendCreated, sendData, sendList, sendNoContent } from '../../lib/http.js'
import { uniqueSlug } from '../../lib/slug.js'
import { absoluteUrl, toBool, toShortTime } from '../../lib/url.js'
import { validate } from '../../middleware/validate.js'

/**
 * Agents / coiffeuses.
 *
 * C'est la table historique `team_members` : elle porte les agents depuis le
 * schéma initial et `appointments.staff_id` y renvoie déjà. Elle a seulement
 * gagné de quoi les joindre (téléphone, e-mail) et de quoi dire quand ils
 * travaillent (`works_from` / `works_to`).
 *
 * Ces deux horaires valent NULL par défaut, ce qui signifie « suit les
 * horaires du salon ». C'est le comportement de tous les agents déjà
 * enregistrés, et celui que le calcul de capacité applique sans rien
 * demander de plus.
 */
const serialize = (row) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  role: row.role,
  phone: row.phone ?? null,
  email: row.email ?? null,
  specialty: row.specialty,
  bio: row.bio,
  imageUrl: absoluteUrl(row.image_url),
  isActive: toBool(row.is_active),
  position: Number(row.position),
  worksFrom: toShortTime(row.works_from),
  worksTo: toShortTime(row.works_to),
})

const FIELDS =
  'id, slug, name, role, phone, email, specialty, bio, image_url, is_active, position, works_from, works_to FROM team_members'

async function listMembers({ onlyActive = true } = {}) {
  const rows = await query(
    `SELECT ${FIELDS} ${onlyActive ? 'WHERE is_active = 1' : ''} ORDER BY position, id`,
  )
  return rows.map(serialize)
}

async function findMember(id) {
  const row = await queryOne(`SELECT ${FIELDS} WHERE id = ? LIMIT 1`, [id])
  return row ? serialize(row) : null
}

const idParam = z.object({ id: z.coerce.number().int().positive() })

const time = z
  .string()
  .regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Format attendu : HH:MM')
  .nullish()

const memberBody = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(120).optional(),
  role: z.string().min(2).max(140),
  phone: z.string().trim().max(40).nullish(),
  email: z.union([z.email(), z.literal('')]).nullish(),
  specialty: z.string().max(180).nullish(),
  bio: z.string().max(4000).nullish(),
  imageUrl: z.string().max(500).nullish(),
  isActive: z.boolean().optional(),
  position: z.coerce.number().int().min(0).max(9999).optional(),
  worksFrom: time,
  worksTo: time,
})

const withSeconds = (value) =>
  value === '' || value === null || value === undefined
    ? null
    : value.length === 5
      ? `${value}:00`
      : value

const emptyToNull = (value) => (value === '' || value === undefined ? null : value)

// ══════════════ Public ══════════════
export const publicRouter = Router()

publicRouter.get('/team', async (_request, response) => {
  return sendList(response, await listMembers())
})

// ══════════════ Admin ══════════════
export const adminRouter = Router()

adminRouter.get('/team', async (_request, response) => {
  return sendList(response, await listMembers({ onlyActive: false }))
})

adminRouter.post('/team', validate({ body: memberBody }), async (request, response) => {
  const slug = await uniqueSlug(request.body.slug || request.body.name, async (value) =>
    Boolean(await queryOne('SELECT id FROM team_members WHERE slug = ? LIMIT 1', [value])),
  )
  const result = await execute(
    `INSERT INTO team_members
       (slug, name, role, phone, email, specialty, bio, image_url, is_active, position,
        works_from, works_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      slug,
      request.body.name,
      request.body.role,
      emptyToNull(request.body.phone),
      emptyToNull(request.body.email),
      emptyToNull(request.body.specialty),
      emptyToNull(request.body.bio),
      emptyToNull(request.body.imageUrl),
      request.body.isActive === false ? 0 : 1,
      request.body.position ?? 0,
      withSeconds(request.body.worksFrom),
      withSeconds(request.body.worksTo),
    ],
  )
  return sendCreated(response, await findMember(result.insertId))
})

adminRouter.patch(
  '/team/:id',
  validate({ params: idParam, body: memberBody.partial() }),
  async (request, response) => {
    if (!(await findMember(request.params.id))) {
      throw ApiError.notFound('Ce membre de l’équipe n’existe pas.')
    }

    const columns = {
      slug: 'slug',
      name: 'name',
      role: 'role',
      phone: 'phone',
      email: 'email',
      specialty: 'specialty',
      bio: 'bio',
      imageUrl: 'image_url',
      isActive: 'is_active',
      position: 'position',
      worksFrom: 'works_from',
      worksTo: 'works_to',
    }
    const fields = []
    const params = []
    for (const [key, column] of Object.entries(columns)) {
      if (request.body[key] === undefined) continue
      fields.push(`${column} = ?`)
      const value = request.body[key]
      if (typeof value === 'boolean') params.push(value ? 1 : 0)
      else if (key === 'worksFrom' || key === 'worksTo') params.push(withSeconds(value))
      else params.push(emptyToNull(value))
    }
    if (fields.length) {
      params.push(request.params.id)
      await execute(`UPDATE team_members SET ${fields.join(', ')} WHERE id = ?`, params)
    }
    return sendData(response, await findMember(request.params.id))
  },
)

adminRouter.delete('/team/:id', validate({ params: idParam }), async (request, response) => {
  /*
   * Un agent déjà inscrit sur un rendez-vous n'est pas supprimé : son nom
   * figure sur des reçus remis à des clientes, et l'effacer les rendrait
   * faux. On propose de le désactiver — il quitte les listes de choix et
   * garde tout son passé.
   */
  const [{ total }] = await query('SELECT COUNT(*) AS total FROM appointments WHERE staff_id = ?', [
    request.params.id,
  ])
  if (Number(total) > 0) {
    throw ApiError.conflict(
      `Cet agent apparaît sur ${total} rendez-vous. Désactivez-le plutôt que de le supprimer.`,
    )
  }

  const [{ bureaux }] = await query('SELECT COUNT(*) AS bureaux FROM offices WHERE agent_id = ?', [
    request.params.id,
  ])
  if (Number(bureaux) > 0) {
    throw ApiError.conflict(
      `Cet agent est affecté à ${bureaux} bureau(x). Retirez-le d’abord de ces bureaux.`,
    )
  }

  const result = await execute('DELETE FROM team_members WHERE id = ?', [request.params.id])
  if (!result.affectedRows) throw ApiError.notFound('Ce membre de l’équipe n’existe pas.')
  return sendNoContent(response)
})
