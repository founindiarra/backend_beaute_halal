import { Router } from 'express'
import { z } from 'zod'

import { execute, query, queryOne } from '../../config/database.js'
import { ApiError } from '../../lib/ApiError.js'
import { sendCreated, sendData, sendList, sendNoContent } from '../../lib/http.js'
import { absoluteUrl, toBool } from '../../lib/url.js'
import { validate } from '../../middleware/validate.js'

/**
 * Bureaux / salons.
 *
 * Le numéro est unique et c'est la base qui le garantit — un index UNIQUE,
 * pas une vérification applicative qui laisserait passer deux créations
 * simultanées. La route traduit seulement l'erreur MySQL en message lisible.
 *
 * Un bureau peut porter un agent « habituel ». Ce n'est qu'une proposition :
 * au moment de traiter un rendez-vous, l'agent reste modifiable.
 */

const SELECT = `
  SELECT o.id, o.number, o.name, o.agent_id, o.phone, o.email, o.address,
         o.description, o.image_url, o.is_active, o.position,
         t.name AS agent_name, t.is_active AS agent_active
  FROM offices o
  LEFT JOIN team_members t ON t.id = o.agent_id
`

const serialize = (row) => ({
  id: row.id,
  number: row.number,
  name: row.name,
  phone: row.phone,
  email: row.email,
  address: row.address,
  description: row.description,
  imageUrl: absoluteUrl(row.image_url),
  isActive: toBool(row.is_active),
  position: Number(row.position),
  /** L'agent habituellement affecté ; `isActive` dit s'il est encore en poste. */
  agent: row.agent_id
    ? { id: row.agent_id, name: row.agent_name, isActive: toBool(row.agent_active) }
    : null,
})

const idParam = z.object({ id: z.coerce.number().int().positive() })

const officeBody = z.object({
  number: z.string().trim().min(1, 'Le numéro est obligatoire.').max(20),
  name: z.string().trim().min(2, 'Le nom est trop court.').max(120),
  agentId: z.coerce.number().int().positive().nullish(),
  phone: z.string().trim().max(40).nullish(),
  email: z.union([z.email(), z.literal('')]).nullish(),
  address: z.string().trim().max(255).nullish(),
  description: z.string().trim().max(4000).nullish(),
  imageUrl: z.string().max(500).nullish(),
  isActive: z.boolean().optional(),
  position: z.coerce.number().int().min(0).max(9999).optional(),
})

async function findOffice(id) {
  const row = await queryOne(`${SELECT} WHERE o.id = ? LIMIT 1`, [id])
  return row ? serialize(row) : null
}

/** L'agent doit exister et être actif : on n'affecte pas un bureau à un partant. */
async function assertAgent(agentId) {
  if (agentId === null || agentId === undefined) return
  const agent = await queryOne('SELECT id, is_active FROM team_members WHERE id = ? LIMIT 1', [
    agentId,
  ])
  if (!agent) throw ApiError.unprocessable('Cet agent n’existe pas.')
  if (!Number(agent.is_active)) throw ApiError.unprocessable('Cet agent est désactivé.')
}

const emptyToNull = (value) => (value === '' || value === undefined ? null : value)

export const adminRouter = Router()

adminRouter.get('/offices', async (_request, response) => {
  const rows = await query(`${SELECT} ORDER BY o.position, o.number`)
  return sendList(response, rows.map(serialize))
})

adminRouter.get('/offices/:id', validate({ params: idParam }), async (request, response) => {
  const office = await findOffice(request.params.id)
  if (!office) throw ApiError.notFound('Ce bureau n’existe pas.')
  return sendData(response, office)
})

adminRouter.post('/offices', validate({ body: officeBody }), async (request, response) => {
  await assertAgent(request.body.agentId)
  try {
    const result = await execute(
      `INSERT INTO offices
         (number, name, agent_id, phone, email, address, description, image_url, is_active, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        request.body.number,
        request.body.name,
        request.body.agentId ?? null,
        emptyToNull(request.body.phone),
        emptyToNull(request.body.email),
        emptyToNull(request.body.address),
        emptyToNull(request.body.description),
        emptyToNull(request.body.imageUrl),
        request.body.isActive === false ? 0 : 1,
        request.body.position ?? 0,
      ],
    )
    return sendCreated(response, await findOffice(result.insertId))
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      throw ApiError.conflict(`Le bureau n° ${request.body.number} existe déjà.`)
    }
    throw error
  }
})

adminRouter.patch(
  '/offices/:id',
  validate({ params: idParam, body: officeBody.partial() }),
  async (request, response) => {
    if (!(await findOffice(request.params.id))) throw ApiError.notFound('Ce bureau n’existe pas.')
    if (request.body.agentId !== undefined) await assertAgent(request.body.agentId)

    const columns = {
      number: 'number',
      name: 'name',
      agentId: 'agent_id',
      phone: 'phone',
      email: 'email',
      address: 'address',
      description: 'description',
      imageUrl: 'image_url',
      isActive: 'is_active',
      position: 'position',
    }
    const fields = []
    const params = []
    for (const [key, column] of Object.entries(columns)) {
      if (request.body[key] === undefined) continue
      fields.push(`${column} = ?`)
      const value = request.body[key]
      params.push(typeof value === 'boolean' ? (value ? 1 : 0) : emptyToNull(value))
    }
    if (!fields.length) throw ApiError.badRequest('Aucun champ à mettre à jour.')

    params.push(request.params.id)
    try {
      await execute(`UPDATE offices SET ${fields.join(', ')} WHERE id = ?`, params)
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw ApiError.conflict(`Le bureau n° ${request.body.number} existe déjà.`)
      }
      throw error
    }
    return sendData(response, await findOffice(request.params.id))
  },
)

adminRouter.delete('/offices/:id', validate({ params: idParam }), async (request, response) => {
  /*
   * Un bureau déjà inscrit sur un rendez-vous n'est pas supprimé : l'effacer
   * ferait disparaître l'information d'un reçu déjà remis. On propose plutôt
   * de le désactiver — il quitte les listes de choix et garde son passé.
   */
  const [{ total }] = await query(
    'SELECT COUNT(*) AS total FROM appointments WHERE office_id = ?',
    [request.params.id],
  )
  if (Number(total) > 0) {
    throw ApiError.conflict(
      `Ce bureau apparaît sur ${total} rendez-vous. Désactivez-le plutôt que de le supprimer.`,
    )
  }

  const result = await execute('DELETE FROM offices WHERE id = ?', [request.params.id])
  if (!result.affectedRows) throw ApiError.notFound('Ce bureau n’existe pas.')
  return sendNoContent(response)
})
