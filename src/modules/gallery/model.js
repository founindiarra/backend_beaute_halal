import { query, queryOne, execute } from '../../config/database.js'
import { absoluteUrl, toBool } from '../../lib/url.js'

// La prestation est facultative : LEFT JOIN et non JOIN, sinon les réalisations
// non rattachées disparaîtraient purement et simplement de la galerie.
const SELECT = `
  SELECT g.id, g.title, g.description, g.image_url, g.is_featured, g.is_active, g.position,
         c.id AS category_id, c.slug AS category_slug, c.name AS category_name,
         s.id AS service_id, s.slug AS service_slug, s.name AS service_name,
         s.duration_minutes AS service_duration, s.price AS service_price,
         s.currency AS service_currency, s.is_active AS service_is_active
  FROM gallery_items g
  JOIN gallery_categories c ON c.id = g.category_id
  LEFT JOIN services s ON s.id = g.service_id
`

export function serializeItem(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    imageUrl: absoluteUrl(row.image_url),
    isFeatured: toBool(row.is_featured),
    isActive: toBool(row.is_active),
    position: Number(row.position),
    category: { id: row.category_id, slug: row.category_slug, name: row.category_name },
    /**
     * Prestation permettant de réaliser cette coiffure, ou `null`.
     * Une prestation désactivée n'est pas exposée : elle n'est plus réservable,
     * et proposer le raccourci mènerait la cliente dans une impasse.
     */
    service:
      row.service_id && toBool(row.service_is_active)
        ? {
            id: row.service_id,
            slug: row.service_slug,
            name: row.service_name,
            durationMinutes: Number(row.service_duration),
            price: Number(row.service_price),
            currency: row.service_currency,
          }
        : null,
  }
}

export async function listCategories({ onlyActive = true } = {}) {
  const rows = await query(
    `SELECT id, slug, name, position, is_active FROM gallery_categories
     ${onlyActive ? 'WHERE is_active = 1' : ''} ORDER BY position, name`,
  )
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    position: Number(row.position),
    isActive: toBool(row.is_active),
  }))
}

export async function listItems({ category = null, featured = null, onlyActive = true } = {}) {
  const conditions = []
  const params = []

  if (onlyActive) conditions.push('g.is_active = 1 AND c.is_active = 1')
  if (category && category !== 'all') {
    conditions.push('c.slug = ?')
    params.push(category)
  }
  if (featured !== null) {
    conditions.push('g.is_featured = ?')
    params.push(featured ? 1 : 0)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = await query(`${SELECT} ${where} ORDER BY g.position, g.id`, params)
  return rows.map(serializeItem)
}

export async function findItem(id) {
  const row = await queryOne(`${SELECT} WHERE g.id = ? LIMIT 1`, [id])
  return row ? serializeItem(row) : null
}

export async function categoryExists(id) {
  return Boolean(await queryOne('SELECT id FROM gallery_categories WHERE id = ? LIMIT 1', [id]))
}

export async function createItem(data) {
  const result = await execute(
    `INSERT INTO gallery_items (category_id, service_id, title, description, image_url, is_featured, is_active, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.categoryId,
      data.serviceId ?? null,
      data.title,
      data.description ?? null,
      data.imageUrl,
      data.isFeatured ? 1 : 0,
      data.isActive === false ? 0 : 1,
      data.position ?? 0,
    ],
  )
  return findItem(result.insertId)
}

export async function serviceExists(id) {
  return Boolean(await queryOne('SELECT id FROM services WHERE id = ? LIMIT 1', [id]))
}

const COLUMNS = {
  categoryId: 'category_id',
  serviceId: 'service_id',
  title: 'title',
  description: 'description',
  imageUrl: 'image_url',
  isFeatured: 'is_featured',
  isActive: 'is_active',
  position: 'position',
}

export async function updateItem(id, data) {
  const fields = []
  const params = []
  for (const [key, column] of Object.entries(COLUMNS)) {
    if (data[key] === undefined) continue
    fields.push(`${column} = ?`)
    params.push(typeof data[key] === 'boolean' ? (data[key] ? 1 : 0) : data[key])
  }
  if (fields.length) {
    params.push(id)
    await execute(`UPDATE gallery_items SET ${fields.join(', ')} WHERE id = ?`, params)
  }
  return findItem(id)
}

export async function deleteItem(id) {
  const result = await execute('DELETE FROM gallery_items WHERE id = ?', [id])
  return result.affectedRows > 0
}

export async function createCategory(data) {
  const result = await execute(
    'INSERT INTO gallery_categories (slug, name, position, is_active) VALUES (?, ?, ?, ?)',
    [data.slug, data.name, data.position ?? 0, data.isActive === false ? 0 : 1],
  )
  const categories = await listCategories({ onlyActive: false })
  return categories.find((category) => category.id === result.insertId) ?? null
}

export async function updateCategory(id, data) {
  const map = { slug: 'slug', name: 'name', position: 'position', isActive: 'is_active' }
  const fields = []
  const params = []
  for (const [key, column] of Object.entries(map)) {
    if (data[key] === undefined) continue
    fields.push(`${column} = ?`)
    params.push(typeof data[key] === 'boolean' ? (data[key] ? 1 : 0) : data[key])
  }
  if (fields.length) {
    params.push(id)
    await execute(`UPDATE gallery_categories SET ${fields.join(', ')} WHERE id = ?`, params)
  }
  const categories = await listCategories({ onlyActive: false })
  return categories.find((category) => category.id === Number(id)) ?? null
}

export async function deleteCategory(id) {
  const result = await execute('DELETE FROM gallery_categories WHERE id = ?', [id])
  return result.affectedRows > 0
}
