import { query, queryOne, execute, transaction } from '../../config/database.js'
import { absoluteUrl, toBool } from '../../lib/url.js'

const SELECT = `
  SELECT s.id, s.slug, s.name, s.description, s.duration_minutes, s.price, s.currency,
         s.image_url, s.is_featured, s.is_active, s.position,
         c.id AS category_id, c.slug AS category_slug, c.name AS category_name
  FROM services s
  JOIN service_categories c ON c.id = s.category_id
`

export function serializeService(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    durationMinutes: Number(row.duration_minutes),
    price: Number(row.price),
    currency: row.currency,
    imageUrl: absoluteUrl(row.image_url),
    isFeatured: toBool(row.is_featured),
    isActive: toBool(row.is_active),
    position: Number(row.position),
    category: {
      id: row.category_id,
      slug: row.category_slug,
      name: row.category_name,
    },
  }
}

export function serializeCategory(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    position: Number(row.position),
    isActive: toBool(row.is_active),
  }
}

export async function listCategories({ onlyActive = true } = {}) {
  const rows = await query(
    `SELECT id, slug, name, description, position, is_active FROM service_categories
     ${onlyActive ? 'WHERE is_active = 1' : ''}
     ORDER BY position, name`,
  )
  return rows.map(serializeCategory)
}

export async function listServices({ category = null, featured = null, onlyActive = true } = {}) {
  const conditions = []
  const params = []

  if (onlyActive) conditions.push('s.is_active = 1 AND c.is_active = 1')
  if (category) {
    conditions.push('c.slug = ?')
    params.push(category)
  }
  if (featured !== null) {
    conditions.push('s.is_featured = ?')
    params.push(featured ? 1 : 0)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = await query(`${SELECT} ${where} ORDER BY c.position, s.position, s.name`, params)
  return rows.map(serializeService)
}

export async function findServiceBySlug(slug, { onlyActive = true } = {}) {
  const row = await queryOne(
    `${SELECT} WHERE s.slug = ? ${onlyActive ? 'AND s.is_active = 1' : ''} LIMIT 1`,
    [slug],
  )
  return row ? serializeService(row) : null
}

export async function findServiceById(id, { onlyActive = false } = {}) {
  const row = await queryOne(
    `${SELECT} WHERE s.id = ? ${onlyActive ? 'AND s.is_active = 1' : ''} LIMIT 1`,
    [id],
  )
  return row ? serializeService(row) : null
}

export async function slugExists(slug, exceptId = null) {
  const row = await queryOne(
    `SELECT id FROM services WHERE slug = ? ${exceptId ? 'AND id <> ?' : ''} LIMIT 1`,
    exceptId ? [slug, exceptId] : [slug],
  )
  return Boolean(row)
}

export async function createService(data) {
  const result = await execute(
    `INSERT INTO services
       (category_id, slug, name, description, duration_minutes, price, currency,
        image_url, is_featured, is_active, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.categoryId,
      data.slug,
      data.name,
      data.description ?? null,
      data.durationMinutes ?? 60,
      data.price ?? 0,
      data.currency ?? 'FCFA',
      data.imageUrl ?? null,
      data.isFeatured ? 1 : 0,
      data.isActive === false ? 0 : 1,
      data.position ?? 0,
    ],
  )
  return findServiceById(result.insertId)
}

const COLUMN_MAP = {
  categoryId: 'category_id',
  slug: 'slug',
  name: 'name',
  description: 'description',
  durationMinutes: 'duration_minutes',
  price: 'price',
  currency: 'currency',
  imageUrl: 'image_url',
  isFeatured: 'is_featured',
  isActive: 'is_active',
  position: 'position',
}

export async function updateService(id, data) {
  const fields = []
  const params = []

  for (const [key, column] of Object.entries(COLUMN_MAP)) {
    if (data[key] === undefined) continue
    fields.push(`${column} = ?`)
    const value = data[key]
    params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
  }

  if (fields.length) {
    params.push(id)
    await execute(`UPDATE services SET ${fields.join(', ')} WHERE id = ?`, params)
  }
  return findServiceById(id)
}

const SLUG_TECHNIQUE = 'prestation-sur-mesure-site'

/**
 * Supprime une prestation. Les rendez-vous qui l'utilisaient (appointments.service_id est obligatoire) ne sont NI
 * supprimés NI modifiés dans leur contenu : ils gardent leur libellé (`service_name`), leur prix et leurs dates ;
 * seul le lien technique est reporté sur la prestation technique inactive « sur mesure », jamais visible du public.
 * La prestation technique elle-même ne peut pas être supprimée (ER_ROW_IS_REFERENCED_2 si elle porte des rendez-vous).
 */
export async function deleteService(id) {
  return transaction(async (connection) => {
    const un = async (sql, params = []) => (await connection.execute(sql, params))[0][0] ?? null
    const service = await un('SELECT id, slug FROM services WHERE id = ? FOR UPDATE', [id])
    if (!service) return false
    const { n } = await un('SELECT COUNT(*) AS n FROM appointments WHERE service_id = ?', [id])
    if (n > 0) {
      if (service.slug === SLUG_TECHNIQUE) {
        const error = new Error('Prestation technique : elle porte des rendez-vous.')
        error.code = 'ER_ROW_IS_REFERENCED_2'
        throw error
      }
      let technique = await un('SELECT id FROM services WHERE slug = ? LIMIT 1', [SLUG_TECHNIQUE])
      if (!technique) {
        let categorie = await un("SELECT id FROM service_categories WHERE slug = 'sur-mesure-site' LIMIT 1")
        if (!categorie) {
          const [cree] = await connection.execute(
            "INSERT INTO service_categories (slug, name, description, position, is_active) VALUES ('sur-mesure-site', 'Sur mesure (demandes du site)', 'Catégorie technique : rendez-vous issus des demandes du site.', 999, 0)",
          )
          categorie = { id: cree.insertId }
        }
        const [cree] = await connection.execute(
          `INSERT INTO services (category_id, slug, name, description, duration_minutes, price, is_active, position)
           VALUES (?, ?, 'Prestation sur mesure (demande du site)', 'Technique : porte les rendez-vous créés depuis une demande du site.', 180, 0, 0, 999)`,
          [categorie.id, SLUG_TECHNIQUE],
        )
        technique = { id: cree.insertId }
      }
      await connection.execute('UPDATE appointments SET service_id = ? WHERE service_id = ?', [technique.id, id])
    }
    const [result] = await connection.execute('DELETE FROM services WHERE id = ?', [id])
    return result.affectedRows > 0
  })
}

export async function categoryExists(id) {
  const row = await queryOne('SELECT id FROM service_categories WHERE id = ? LIMIT 1', [id])
  return Boolean(row)
}

export async function createCategory(data) {
  const result = await execute(
    'INSERT INTO service_categories (slug, name, description, position, is_active) VALUES (?, ?, ?, ?, ?)',
    [data.slug, data.name, data.description ?? null, data.position ?? 0, data.isActive === false ? 0 : 1],
  )
  const row = await queryOne(
    'SELECT id, slug, name, description, position, is_active FROM service_categories WHERE id = ?',
    [result.insertId],
  )
  return serializeCategory(row)
}

export async function updateCategory(id, data) {
  const map = {
    slug: 'slug',
    name: 'name',
    description: 'description',
    position: 'position',
    isActive: 'is_active',
  }
  const fields = []
  const params = []
  for (const [key, column] of Object.entries(map)) {
    if (data[key] === undefined) continue
    fields.push(`${column} = ?`)
    params.push(typeof data[key] === 'boolean' ? (data[key] ? 1 : 0) : data[key])
  }
  if (fields.length) {
    params.push(id)
    await execute(`UPDATE service_categories SET ${fields.join(', ')} WHERE id = ?`, params)
  }
  const row = await queryOne(
    'SELECT id, slug, name, description, position, is_active FROM service_categories WHERE id = ?',
    [id],
  )
  return row ? serializeCategory(row) : null
}

export async function deleteCategory(id) {
  const result = await execute('DELETE FROM service_categories WHERE id = ?', [id])
  return result.affectedRows > 0
}
