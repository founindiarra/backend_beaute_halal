import multer from 'multer'

import { config } from '../config/env.js'
import { ApiError } from '../lib/ApiError.js'

export function notFound(request, _response, next) {
  next(ApiError.notFound(`Route inconnue : ${request.method} ${request.originalUrl}`))
}

/** Gestionnaire d'erreurs unique de l'API (Express 5 capte aussi les rejets async). */
// eslint-disable-next-line no-unused-vars
export function errorHandler(error, _request, response, _next) {
  let apiError = error

  if (error instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: `Fichier trop volumineux (maximum ${Math.round(config.upload.maxBytes / 1024 / 1024)} Mo).`,
      LIMIT_FILE_COUNT: 'Trop de fichiers envoyés.',
      LIMIT_UNEXPECTED_FILE: 'Champ de fichier inattendu.',
    }
    apiError = ApiError.badRequest(messages[error.code] || 'Envoi de fichier refusé.')
  }

  // Erreurs du parseur de corps de requête (express.json)
  if (error?.type === 'entity.parse.failed') {
    apiError = ApiError.badRequest('Le corps de la requête n’est pas un JSON valide.')
  }
  if (error?.type === 'entity.too.large') {
    apiError = ApiError.badRequest('Requête trop volumineuse.')
  }

  if (error?.message?.startsWith('Origine non autorisée')) {
    apiError = ApiError.forbidden(error.message, { code: 'CORS_ORIGIN_REFUSED' })
  }

  if (error?.code === 'ER_DUP_ENTRY') {
    apiError = ApiError.conflict('Cet enregistrement existe déjà.', { code: 'DUPLICATE_ENTRY' })
  }

  if (error?.code === 'ER_NO_SUCH_TABLE') {
    apiError = new ApiError(
      500,
      'Les tables n’existent pas encore. Lancez « npm run db:migrate ».',
      { code: 'DATABASE_NOT_MIGRATED' },
    )
  }

  if (['ECONNREFUSED', 'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR'].includes(error?.code)) {
    apiError = new ApiError(503, 'Base de données inaccessible — vérifiez votre .env et MySQL.', {
      code: 'DATABASE_UNAVAILABLE',
    })
  }

  if (!(apiError instanceof ApiError)) {
    console.error('❌ Erreur non gérée :', error)
    apiError = new ApiError(500, 'Une erreur interne est survenue.')
  } else if (apiError.status >= 500) {
    console.error('❌', apiError.message, error)
  }

  const body = {
    success: false,
    error: {
      code: apiError.code,
      message: apiError.message,
    },
  }

  if (apiError.details) body.error.details = apiError.details
  if (!config.isProduction && apiError.status >= 500 && error?.stack) {
    body.error.stack = error.stack.split('\n').slice(0, 5)
  }

  return response.status(apiError.status).json(body)
}
