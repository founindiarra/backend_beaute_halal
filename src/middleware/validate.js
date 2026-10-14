import { ApiError } from '../lib/ApiError.js'

/**
 * Valide et normalise une partie de la requête avec un schéma Zod.
 * Les données validées remplacent les données brutes (req.body, req.query…).
 *
 *   router.post('/', validate({ body: createSchema }), handler)
 */
export function validate(schemas) {
  return (request, _response, next) => {
    const issues = []

    for (const source of ['params', 'query', 'body']) {
      const schema = schemas[source]
      if (!schema) continue

      const result = schema.safeParse(request[source] ?? {})
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          issues.push({
            field: [source, ...issue.path].join('.').replace(/^body\./, ''),
            message: issue.message,
          })
        })
        continue
      }

      // req.query est en lecture seule sous Express 5 : on stocke le résultat à part.
      if (source === 'query') request.validatedQuery = result.data
      else request[source] = result.data
    }

    if (issues.length) {
      return next(ApiError.unprocessable('Certains champs sont invalides.', { details: issues }))
    }
    return next()
  }
}

/** Raccourci de lecture des paramètres de requête validés. */
export function getQuery(request) {
  return request.validatedQuery ?? request.query ?? {}
}

export default validate
