/** Réponses JSON homogènes sur toute l'API. */

export function sendData(res, data, status = 200) {
  return res.status(status).json({ success: true, data })
}

export function sendList(res, items, meta = null) {
  return res.status(200).json({
    success: true,
    data: items,
    meta: meta ?? { total: items.length },
  })
}

export function sendCreated(res, data) {
  return sendData(res, data, 201)
}

export function sendNoContent(res) {
  return res.status(204).send()
}

/** Paramètres de pagination communs aux listes admin. */
export function readPagination(request, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(request.query.page, 10) || 1)
  const rawLimit = Number.parseInt(request.query.limit, 10) || defaultLimit
  const limit = Math.min(Math.max(1, rawLimit), maxLimit)
  return { page, limit, offset: (page - 1) * limit }
}

export function paginationMeta({ page, limit }, total) {
  return {
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  }
}
