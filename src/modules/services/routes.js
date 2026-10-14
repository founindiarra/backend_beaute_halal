import { Router } from 'express'
import { z } from 'zod'

import {
  categoryExists,
  createCategory,
  createService,
  deleteCategory,
  deleteService,
  findServiceById,
  findServiceBySlug,
  listCategories,
  listServices,
  slugExists,
  updateCategory,
  updateService,
} from './model.js'
import { ApiError } from '../../lib/ApiError.js'
import { sendCreated, sendData, sendList, sendNoContent } from '../../lib/http.js'
import { uniqueSlug } from '../../lib/slug.js'
import { getQuery, validate } from '../../middleware/validate.js'

const idParam = z.object({ id: z.coerce.number().int().positive() })

const listQuery = z.object({
  category: z.string().min(1).max(120).optional(),
  featured: z
    .enum(['true', 'false', '1', '0'])
    .transform((value) => value === 'true' || value === '1')
    .optional(),
})

const serviceBody = z.object({
  categoryId: z.coerce.number().int().positive(),
  name: z.string().min(2).max(140),
  slug: z.string().min(2).max(140).optional(),
  description: z.string().max(4000).nullish(),
  durationMinutes: z.coerce.number().int().min(5).max(1440),
  price: z.coerce.number().min(0).max(100000000),
  currency: z.string().min(1).max(8).optional(),
  imageUrl: z.string().max(500).nullish(),
  isFeatured: z.boolean().optional(),
  isActive: z.boolean().optional(),
  position: z.coerce.number().int().min(0).max(9999).optional(),
})

const categoryBody = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(120).optional(),
  description: z.string().max(2000).nullish(),
  position: z.coerce.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
})

// ══════════════ Public ══════════════
export const publicRouter = Router()

publicRouter.get('/service-categories', async (_request, response) => {
  return sendList(response, await listCategories())
})

publicRouter.get('/services', validate({ query: listQuery }), async (request, response) => {
  const { category, featured } = getQuery(request)
  const services = await listServices({ category, featured: featured ?? null })
  return sendList(response, services)
})

publicRouter.get('/services/:slug', async (request, response) => {
  const service = await findServiceBySlug(request.params.slug)
  if (!service) throw ApiError.notFound('Cette prestation n’existe pas.')
  return sendData(response, service)
})

// ══════════════ Admin ══════════════
export const adminRouter = Router()

adminRouter.get('/services', async (_request, response) => {
  return sendList(response, await listServices({ onlyActive: false }))
})

adminRouter.get('/services/:id', validate({ params: idParam }), async (request, response) => {
  const service = await findServiceById(request.params.id)
  if (!service) throw ApiError.notFound('Cette prestation n’existe pas.')
  return sendData(response, service)
})

adminRouter.post('/services', validate({ body: serviceBody }), async (request, response) => {
  if (!(await categoryExists(request.body.categoryId))) {
    throw ApiError.unprocessable('La catégorie indiquée n’existe pas.')
  }
  const slug = await uniqueSlug(request.body.slug || request.body.name, (value) =>
    slugExists(value),
  )
  const service = await createService({ ...request.body, slug })
  return sendCreated(response, service)
})

adminRouter.patch(
  '/services/:id',
  validate({ params: idParam, body: serviceBody.partial() }),
  async (request, response) => {
    const existing = await findServiceById(request.params.id)
    if (!existing) throw ApiError.notFound('Cette prestation n’existe pas.')

    if (request.body.categoryId && !(await categoryExists(request.body.categoryId))) {
      throw ApiError.unprocessable('La catégorie indiquée n’existe pas.')
    }

    const payload = { ...request.body }
    if (payload.slug) {
      payload.slug = await uniqueSlug(payload.slug, (value) =>
        slugExists(value, request.params.id),
      )
    }

    return sendData(response, await updateService(request.params.id, payload))
  },
)

adminRouter.delete('/services/:id', validate({ params: idParam }), async (request, response) => {
  const deleted = await deleteService(request.params.id).catch((error) => {
    if (error.code === 'ER_ROW_IS_REFERENCED_2') {
      throw ApiError.conflict(
        'Des rendez-vous utilisent cette prestation : désactivez-la plutôt que de la supprimer.',
      )
    }
    throw error
  })
  if (!deleted) throw ApiError.notFound('Cette prestation n’existe pas.')
  return sendNoContent(response)
})

adminRouter.get('/service-categories', async (_request, response) => {
  return sendList(response, await listCategories({ onlyActive: false }))
})

adminRouter.post(
  '/service-categories',
  validate({ body: categoryBody }),
  async (request, response) => {
    const slug = await uniqueSlug(request.body.slug || request.body.name, async (value) => {
      const categories = await listCategories({ onlyActive: false })
      return categories.some((category) => category.slug === value)
    })
    return sendCreated(response, await createCategory({ ...request.body, slug }))
  },
)

adminRouter.patch(
  '/service-categories/:id',
  validate({ params: idParam, body: categoryBody.partial() }),
  async (request, response) => {
    const updated = await updateCategory(request.params.id, request.body)
    if (!updated) throw ApiError.notFound('Cette catégorie n’existe pas.')
    return sendData(response, updated)
  },
)

adminRouter.delete(
  '/service-categories/:id',
  validate({ params: idParam }),
  async (request, response) => {
    const deleted = await deleteCategory(request.params.id).catch((error) => {
      if (error.code === 'ER_ROW_IS_REFERENCED_2') {
        throw ApiError.conflict('Des prestations appartiennent encore à cette catégorie.')
      }
      throw error
    })
    if (!deleted) throw ApiError.notFound('Cette catégorie n’existe pas.')
    return sendNoContent(response)
  },
)
