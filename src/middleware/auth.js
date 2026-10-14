import jwt from 'jsonwebtoken'

import { config } from '../config/env.js'
import { queryOne } from '../config/database.js'
import { ApiError } from '../lib/ApiError.js'
import { PERMISSIONS, can, permissionsFor } from '../lib/permissions.js'

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn },
  )
}

/** Exige un jeton valide et charge l'utilisateur correspondant dans req.user. */
export async function requireAuth(request, _response, next) {
  const header = request.headers.authorization || ''
  const [scheme, token] = header.split(' ')

  if (scheme !== 'Bearer' || !token) {
    return next(ApiError.unauthorized('Jeton d’authentification manquant.'))
  }

  let payload
  try {
    payload = jwt.verify(token, config.jwt.secret)
  } catch (error) {
    const message =
      error.name === 'TokenExpiredError'
        ? 'Session expirée, reconnectez-vous.'
        : 'Jeton d’authentification invalide.'
    return next(ApiError.unauthorized(message, { code: 'INVALID_TOKEN' }))
  }

  const user = await queryOne(
    'SELECT id, name, email, role, is_active FROM users WHERE id = ? LIMIT 1',
    [payload.sub],
  )

  if (!user) return next(ApiError.unauthorized('Compte introuvable.'))
  if (!user.is_active) return next(ApiError.forbidden('Ce compte est désactivé.'))

  /*
   * Les droits sont recalculés depuis le rôle lu en base à CHAQUE requête,
   * jamais repris du jeton. Rétrograder quelqu'un prend donc effet tout de
   * suite ; un jeton émis quand la personne était administratrice ne lui
   * rouvre rien.
   */
  request.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: permissionsFor(user.role),
  }
  return next()
}

/** Restreint l'accès à certains rôles : requireRole('admin') */
export function requireRole(...roles) {
  return (request, _response, next) => {
    if (!request.user) return next(ApiError.unauthorized())
    if (!roles.includes(request.user.role)) {
      return next(ApiError.forbidden('Votre rôle ne permet pas cette action.'))
    }
    return next()
  }
}

/**
 * Exige un droit précis : requirePermission('accounting').
 *
 * À préférer à `requireRole` : la route dit de quoi elle relève, et c'est la
 * table des permissions qui décide qui y a accès. Déplacer la frontière ne
 * demande alors de toucher à aucune route.
 */
export function requirePermission(permission) {
  /*
   * Un nom de droit inconnu refuserait TOUT LE MONDE, en silence — y compris
   * l'administratrice —, et la page correspondante disparaîtrait du menu sans
   * que rien ne l'explique. C'est exactement ce qui est arrivé le jour où les
   * modules « clientes » et « messagerie » ont été branchés avant que leurs
   * droits n'existent dans la table.
   *
   * On préfère donc une panne bruyante au démarrage : ce garde s'exécute au
   * chargement du module, pas à la requête, donc le serveur refuse de démarrer
   * plutôt que de servir un dashboard amputé.
   */
  if (!Object.hasOwn(PERMISSIONS, permission)) {
    throw new Error(
      `Droit inconnu : « ${permission} ». Ajoutez-le à PERMISSIONS dans src/lib/permissions.js, ` +
        `sinon cette route sera refusée à tout le monde. Droits connus : ${Object.keys(PERMISSIONS).join(', ')}.`,
    )
  }

  return (request, _response, next) => {
    if (!request.user) return next(ApiError.unauthorized())
    if (!can(request.user.role, permission)) {
      return next(
        ApiError.forbidden('Cette partie est réservée à l’administratrice du salon.', {
          code: 'MISSING_PERMISSION',
          details: { permission },
        }),
      )
    }
    return next()
  }
}
