import { Router } from 'express'
import { z } from 'zod'

import {
  categoryExists,
  createCategory,
  createItem,
  deleteCategory,
  deleteItem,
  findItem,
  listCategories,
  listItems,
  serviceExists,
  updateCategory,
  updateItem,
} from './model.js'
import { ApiError } from '../../lib/ApiError.js'
import { sendCreated, sendData, sendList, sendNoContent } from '../../lib/http.js'
import { slugify } from '../../lib/slug.js'
import { getQuery, validate } from '../../middleware/validate.js'

const idParam = z.object({ id: z.coerce.number().int().positive() })

const listQuery = z.object({
  category: z.string().min(1).max(120).optional(),
  featured: z
    .enum(['true', 'false', '1', '0'])
    .transform((value) => value === 'true' || value === '1')
    .optional(),
})

const itemBody = z.object({
  categoryId: z.coerce.number().int().positive(),
  /**
   * Prestation permettant de réaliser cette coiffure. Facultative : `null`
   * détache la réalisation, qui reste visible mais sans raccourci de
   * réservation.
   */
  serviceId: z.coerce.number().int().positive().nullish(),
  title: z.string().min(2).max(160),
  description: z.string().max(2000).nullish(),
  imageUrl: z.string().min(1).max(500),
  isFeatured: z.boolean().optional(),
  isActive: z.boolean().optional(),
  position: z.coerce.number().int().min(0).max(9999).optional(),
})

const categoryBody = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(120).optional(),
  position: z.coerce.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
})

// ══════════════ Public ══════════════
export const publicRouter = Router()

publicRouter.get('/gallery/categories', async (_request, response) => {
  const categories = await listCategories()
  // « Toutes » est ajoutée côté API pour que le front n'ait rien à inventer.
  return sendList(response, [{ id: 0, slug: 'all', name: 'Toutes', position: -1 }, ...categories])
})

publicRouter.get('/gallery', validate({ query: listQuery }), async (request, response) => {
  const { category, featured } = getQuery(request)
  return sendList(response, await listItems({ category, featured: featured ?? null }))
})

// ══════════════ Admin ══════════════
export const adminRouter = Router()

adminRouter.get('/gallery', async (_request, response) => {
  return sendList(response, await listItems({ onlyActive: false }))
})

adminRouter.post('/gallery', validate({ body: itemBody }), async (request, response) => {
  if (!(await categoryExists(request.body.categoryId))) {
    throw ApiError.unprocessable('La catégorie indiquée n’existe pas.')
  }
  if (request.body.serviceId && !(await serviceExists(request.body.serviceId))) {
    throw ApiError.unprocessable('La prestation indiquée n’existe pas.')
  }
  return sendCreated(response, await createItem(request.body))
})

adminRouter.patch(
  '/gallery/:id',
  validate({ params: idParam, body: itemBody.partial() }),
  async (request, response) => {
    if (!(await findItem(request.params.id))) {
      throw ApiError.notFound('Cette réalisation n’existe pas.')
    }
    if (request.body.categoryId && !(await categoryExists(request.body.categoryId))) {
      throw ApiError.unprocessable('La catégorie indiquée n’existe pas.')
    }
    if (request.body.serviceId && !(await serviceExists(request.body.serviceId))) {
      throw ApiError.unprocessable('La prestation indiquée n’existe pas.')
    }
    return sendData(response, await updateItem(request.params.id, request.body))
  },
)

adminRouter.delete('/gallery/:id', validate({ params: idParam }), async (request, response) => {
  if (!(await deleteItem(request.params.id))) {
    throw ApiError.notFound('Cette réalisation n’existe pas.')
  }
  return sendNoContent(response)
})

adminRouter.get('/gallery-categories', async (_request, response) => {
  return sendList(response, await listCategories({ onlyActive: false }))
})

adminRouter.post(
  '/gallery-categories',
  validate({ body: categoryBody }),
  async (request, response) => {
    const slug = slugify(request.body.slug || request.body.name)
    return sendCreated(response, await createCategory({ ...request.body, slug }))
  },
)

adminRouter.patch(
  '/gallery-categories/:id',
  validate({ params: idParam, body: categoryBody.partial() }),
  async (request, response) => {
    const updated = await updateCategory(request.params.id, request.body)
    if (!updated) throw ApiError.notFound('Cette catégorie n’existe pas.')
    return sendData(response, updated)
  },
)

adminRouter.delete(
  '/gallery-categories/:id',
  validate({ params: idParam }),
  async (request, response) => {
    const deleted = await deleteCategory(request.params.id).catch((error) => {
      if (error.code === 'ER_ROW_IS_REFERENCED_2') {
        throw ApiError.conflict('Des réalisations appartiennent encore à cette catégorie.')
      }
      throw error
    })
    if (!deleted) throw ApiError.notFound('Cette catégorie n’existe pas.')
    return sendNoContent(response)
  },
)
