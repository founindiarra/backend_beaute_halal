import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'

import { query, queryOne, execute } from '../../config/database.js'
import { ApiError } from '../../lib/ApiError.js'
import { sendCreated, sendData, sendList, sendNoContent } from '../../lib/http.js'
import { requireAuth, requirePermission, signToken } from '../../middleware/auth.js'
import { loginLimiter } from '../../middleware/rateLimit.js'
import { ROLE_LABELS, permissionsFor } from '../../lib/permissions.js'
import { validate } from '../../middleware/validate.js'

/*
 * Les droits voyagent avec l'utilisateur.
 *
 * Le dashboard ne recalcule jamais la frontière de son côté : il lit cette
 * liste et masque ce qui n'y figure pas. Une seule table fait autorité, celle
 * du backend — et c'est elle, de toute façon, qui refuse les requêtes.
 */
const serializeUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  roleLabel: ROLE_LABELS[row.role] ?? row.role,
  permissions: permissionsFor(row.role),
  isActive: Boolean(Number(row.is_active)),
  lastLoginAt: row.last_login_at ?? null,
  createdAt: row.created_at ?? null,
})

const loginBody = z.object({
  email: z.email('Adresse e-mail invalide.').max(160),
  password: z.string().min(1, 'Mot de passe requis.').max(200),
})

const passwordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z
    .string()
    .min(10, 'Le nouveau mot de passe doit faire au moins 10 caractères.')
    .max(200),
})

const userBody = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().max(160),
  password: z.string().min(10, 'Au moins 10 caractères.').max(200),
  role: z.enum(['admin', 'staff']).optional(),
})

const idParam = z.object({ id: z.coerce.number().int().positive() })

/** Routes montées sous /api/admin/auth */
export const router = Router()

router.post('/login', loginLimiter, validate({ body: loginBody }), async (request, response) => {
  const email = request.body.email.toLowerCase()
  const user = await queryOne(
    'SELECT id, name, email, role, password_hash, is_active FROM users WHERE email = ? LIMIT 1',
    [email],
  )

  // Message identique dans les deux cas : on n'indique jamais si l'e-mail existe.
  const invalid = ApiError.unauthorized('E-mail ou mot de passe incorrect.', {
    code: 'INVALID_CREDENTIALS',
  })

  if (!user) {
    // Comparaison factice pour que la réponse prenne le même temps.
    await bcrypt.compare(request.body.password, '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidin')
    throw invalid
  }

  const valid = await bcrypt.compare(request.body.password, user.password_hash)
  if (!valid) throw invalid
  if (!Number(user.is_active)) throw ApiError.forbidden('Ce compte est désactivé.')

  await execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id])

  return sendData(response, {
    token: signToken(user),
    user: serializeUser(user),
  })
})

router.get('/me', requireAuth, async (request, response) => {
  const user = await queryOne(
    'SELECT id, name, email, role, is_active, last_login_at, created_at FROM users WHERE id = ?',
    [request.user.id],
  )
  return sendData(response, serializeUser(user))
})

router.post(
  '/change-password',
  requireAuth,
  validate({ body: passwordBody }),
  async (request, response) => {
    const user = await queryOne('SELECT id, password_hash FROM users WHERE id = ?', [
      request.user.id,
    ])
    const valid = await bcrypt.compare(request.body.currentPassword, user.password_hash)
    if (!valid) throw ApiError.unauthorized('Mot de passe actuel incorrect.')

    const hash = await bcrypt.hash(request.body.newPassword, 12)
    await execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id])

    return sendData(response, { message: 'Mot de passe modifié.' })
  },
)

// ── Gestion des comptes (réservée au rôle admin) ──
router.get('/users', requireAuth, requirePermission('users'), async (_request, response) => {
  const rows = await query(
    'SELECT id, name, email, role, is_active, last_login_at, created_at FROM users ORDER BY created_at',
  )
  return sendList(response, rows.map(serializeUser))
})

router.post(
  '/users',
  requireAuth,
  requirePermission('users'),
  validate({ body: userBody }),
  async (request, response) => {
    const email = request.body.email.toLowerCase()
    if (await queryOne('SELECT id FROM users WHERE email = ? LIMIT 1', [email])) {
      throw ApiError.conflict('Un compte utilise déjà cette adresse e-mail.')
    }

    const hash = await bcrypt.hash(request.body.password, 12)
    const result = await execute(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [request.body.name, email, hash, request.body.role ?? 'staff'],
    )

    const row = await queryOne(
      'SELECT id, name, email, role, is_active, last_login_at, created_at FROM users WHERE id = ?',
      [result.insertId],
    )
    return sendCreated(response, serializeUser(row))
  },
)

router.patch(
  '/users/:id',
  requireAuth,
  requirePermission('users'),
  validate({
    params: idParam,
    body: z.object({
      name: z.string().trim().min(2).max(120).optional(),
      email: z.email('Adresse e-mail invalide.').max(160).optional(),
      role: z.enum(['admin', 'staff']).optional(),
      isActive: z.boolean().optional(),
      password: z.string().min(10).max(200).optional(),
    }),
  }),
  async (request, response) => {
    const target = await queryOne('SELECT id, role FROM users WHERE id = ?', [request.params.id])
    if (!target) throw ApiError.notFound('Ce compte n’existe pas.')

    if (Number(request.params.id) === request.user.id && request.body.isActive === false) {
      throw ApiError.badRequest('Vous ne pouvez pas désactiver votre propre compte.')
    }

    // L'adresse identifie le compte à la connexion : elle doit rester unique.
    const email = request.body.email?.toLowerCase()
    if (email) {
      const taken = await queryOne('SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1', [
        email,
        request.params.id,
      ])
      if (taken) throw ApiError.conflict('Un autre compte utilise déjà cette adresse e-mail.')
    }

    const fields = []
    const params = []
    if (request.body.name !== undefined) {
      fields.push('name = ?')
      params.push(request.body.name)
    }
    if (email !== undefined) {
      fields.push('email = ?')
      params.push(email)
    }
    if (request.body.role !== undefined) {
      fields.push('role = ?')
      params.push(request.body.role)
    }
    if (request.body.isActive !== undefined) {
      fields.push('is_active = ?')
      params.push(request.body.isActive ? 1 : 0)
    }
    if (request.body.password !== undefined) {
      fields.push('password_hash = ?')
      params.push(await bcrypt.hash(request.body.password, 12))
    }
    if (!fields.length) throw ApiError.badRequest('Aucun champ à mettre à jour.')

    params.push(request.params.id)
    await execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params)

    const row = await queryOne(
      'SELECT id, name, email, role, is_active, last_login_at, created_at FROM users WHERE id = ?',
      [request.params.id],
    )
    return sendData(response, serializeUser(row))
  },
)

router.delete(
  '/users/:id',
  requireAuth,
  requirePermission('users'),
  validate({ params: idParam }),
  async (request, response) => {
    if (Number(request.params.id) === request.user.id) {
      throw ApiError.badRequest('Vous ne pouvez pas supprimer votre propre compte.')
    }
    const [{ total }] = await query("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'")
    const target = await queryOne('SELECT role FROM users WHERE id = ?', [request.params.id])
    if (!target) throw ApiError.notFound('Ce compte n’existe pas.')
    if (target.role === 'admin' && Number(total) <= 1) {
      throw ApiError.conflict('Impossible de supprimer le dernier compte administrateur.')
    }

    await execute('DELETE FROM users WHERE id = ?', [request.params.id])
    return sendNoContent(response)
  },
)

export default router
