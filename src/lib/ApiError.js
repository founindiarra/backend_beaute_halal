/** Erreur métier transportant un code HTTP et un code applicatif stable. */
export class ApiError extends Error {
  constructor(status, message, { code = null, details = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code || defaultCode(status)
    this.details = details
    this.expected = true
  }

  static badRequest(message = 'Requête invalide.', options) {
    return new ApiError(400, message, options)
  }

  static unauthorized(message = 'Authentification requise.', options) {
    return new ApiError(401, message, options)
  }

  static forbidden(message = 'Accès refusé.', options) {
    return new ApiError(403, message, options)
  }

  static notFound(message = 'Ressource introuvable.', options) {
    return new ApiError(404, message, options)
  }

  static conflict(message = 'Conflit avec l’état actuel de la ressource.', options) {
    return new ApiError(409, message, options)
  }

  static unprocessable(message = 'Données invalides.', options) {
    return new ApiError(422, message, options)
  }

  static tooMany(message = 'Trop de requêtes, réessayez plus tard.', options) {
    return new ApiError(429, message, options)
  }
}

function defaultCode(status) {
  return (
    {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'VALIDATION_ERROR',
      429: 'TOO_MANY_REQUESTS',
    }[status] || 'INTERNAL_ERROR'
  )
}

export default ApiError
