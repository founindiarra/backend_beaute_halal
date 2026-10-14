import { query, queryOne, execute } from '../../config/database.js'
import { toShortTime } from '../../lib/url.js'

const SELECT = `
  SELECT a.id, a.reference, a.service_id, a.staff_id, a.service_name,
         a.appointment_date, a.appointment_time, a.duration_minutes, a.price, a.currency,
         a.first_name, a.last_name, a.phone, a.email, a.note, a.status, a.source,
         a.cancel_reason, a.confirmed_at, a.cancelled_at, a.created_at, a.updated_at,
         a.office_id, a.arrived_at, a.arrived_by_name, a.completed_at, a.discount_amount,
         t.name AS staff_name,
         o.number AS office_number, o.name AS office_name
  FROM appointments a
  LEFT JOIN team_members t ON t.id = a.staff_id
  LEFT JOIN offices      o ON o.id = a.office_id
`

/** Vue complète — réservée à l'API admin. */
export function serializeAppointment(row) {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    service: { id: row.service_id, name: row.service_name },
    staff: row.staff_id ? { id: row.staff_id, name: row.staff_name } : null,
    date: row.appointment_date,
    time: toShortTime(row.appointment_time),
    durationMinutes: Number(row.duration_minutes),
    price: Number(row.price),
    currency: row.currency,
    customer: {
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone,
      email: row.email,
    },
    note: row.note,
    source: row.source,
    cancelReason: row.cancel_reason,
    /*
     * Avancement du traitement, en lecture seule ici : la page « Rendez-vous »
     * doit pouvoir dire d'un coup d'œil si la cliente est déjà passée, sans
     * charger la fiche de traitement complète. Tout ce qui MODIFIE ces
     * valeurs vit dans le module « operations », jamais ici.
     */
    office: row.office_id
      ? { id: row.office_id, number: row.office_number, name: row.office_name }
      : null,
    present: Boolean(row.arrived_at),
    arrivedAt: row.arrived_at ?? null,
    completedAt: row.completed_at ?? null,
    discountAmount: Number(row.discount_amount ?? 0),
    confirmedAt: row.confirmed_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Vue publique — pas de téléphone ni d'e-mail. */
export function serializePublicAppointment(row) {
  return {
    reference: row.reference,
    status: row.status,
    serviceName: row.service_name,
    date: row.appointment_date,
    time: toShortTime(row.appointment_time),
    durationMinutes: Number(row.duration_minutes),
    price: Number(row.price),
    currency: row.currency,
    firstName: row.first_name,
    createdAt: row.created_at,
  }
}

export async function findByReference(reference) {
  return queryOne(`${SELECT} WHERE a.reference = ? LIMIT 1`, [reference])
}

export async function findById(id) {
  return queryOne(`${SELECT} WHERE a.id = ? LIMIT 1`, [id])
}

export async function insertAppointment(data) {
  const result = await execute(
    `INSERT INTO appointments
       (reference, service_id, staff_id, service_name, appointment_date, appointment_time,
        duration_minutes, price, currency, first_name, last_name, phone, email, note, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.reference,
      data.serviceId,
      data.staffId ?? null,
      data.serviceName,
      data.date,
      data.time,
      data.durationMinutes,
      data.price,
      data.currency,
      data.firstName,
      data.lastName,
      data.phone,
      data.email,
      data.note ?? null,
      data.source ?? 'website',
    ],
  )
  return findById(result.insertId)
}

export async function listAppointments({
  status = null,
  from = null,
  to = null,
  search = null,
  /**
   * Sens du tri par date. Par défaut « desc » : la valeur historique, pour que
   * les appels existants gardent exactement le même comportement.
   * « asc » sert au tableau de bord, qui veut les rendez-vous les plus proches
   * en premier et non les plus lointains.
   */
  order = 'desc',
  limit = 25,
  offset = 0,
} = {}) {
  const conditions = []
  const params = []

  if (status) {
    conditions.push('a.status = ?')
    params.push(status)
  }
  if (from) {
    conditions.push('a.appointment_date >= ?')
    params.push(from)
  }
  if (to) {
    conditions.push('a.appointment_date <= ?')
    params.push(to)
  }
  if (search) {
    conditions.push(
      '(a.reference LIKE ? OR a.first_name LIKE ? OR a.last_name LIKE ? OR a.email LIKE ? OR a.phone LIKE ?)',
    )
    const like = `%${search}%`
    params.push(like, like, like, like, like)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM appointments a ${where}`, params)

  // Le sens est interpolé dans le SQL : il est donc verrouillé sur deux valeurs
  // littérales, jamais sur la chaîne reçue.
  const direction = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC'

  const rows = await query(
    `${SELECT} ${where} ORDER BY a.appointment_date ${direction}, a.appointment_time ${direction}
     LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  )

  return { total: Number(total), rows: rows.map(serializeAppointment) }
}

export async function updateStatus(id, status, { cancelReason = null } = {}) {
  await execute(
    `UPDATE appointments
     SET status = ?,
         cancel_reason = ?,
         confirmed_at = IF(? = 'confirmed', NOW(), confirmed_at),
         cancelled_at = IF(? = 'cancelled', NOW(), cancelled_at)
     WHERE id = ?`,
    [status, cancelReason, status, status, id],
  )
  return findById(id)
}

export async function updateAppointment(id, data) {
  const columns = {
    staffId: 'staff_id',
    date: 'appointment_date',
    time: 'appointment_time',
    firstName: 'first_name',
    lastName: 'last_name',
    phone: 'phone',
    email: 'email',
    note: 'note',
  }
  const fields = []
  const params = []
  for (const [key, column] of Object.entries(columns)) {
    if (data[key] === undefined) continue
    fields.push(`${column} = ?`)
    params.push(data[key])
  }
  if (fields.length) {
    params.push(id)
    await execute(`UPDATE appointments SET ${fields.join(', ')} WHERE id = ?`, params)
  }
  return findById(id)
}

export async function deleteAppointment(id) {
  const result = await execute('DELETE FROM appointments WHERE id = ?', [id])
  return result.affectedRows > 0
}

/** Compteurs affichés en tête du futur tableau de bord. */
export async function getStats() {
  const [counts] = await query(`
    SELECT
      COUNT(*) AS total,
      SUM(status = 'pending')   AS pending,
      SUM(status = 'confirmed') AS confirmed,
      SUM(status = 'cancelled') AS cancelled,
      SUM(status IN ('arrived', 'in_progress')) AS in_salon,
      SUM(status = 'completed') AS completed,
      SUM(appointment_date = CURDATE() AND status NOT IN ('cancelled', 'rejected')) AS today,
      SUM(appointment_date > CURDATE() AND status NOT IN ('cancelled', 'rejected')) AS upcoming
    FROM appointments
  `)
  const [messages] = await query(
    "SELECT COUNT(*) AS unread FROM contact_messages WHERE status = 'new'",
  )

  // Volumétrie du contenu, pour les compteurs du tableau de bord admin.
  const [catalog] = await query(`
    SELECT
      (SELECT COUNT(*) FROM services WHERE is_active = 1)            AS services_active,
      (SELECT COUNT(*) FROM services)                                AS services_total,
      (SELECT COUNT(*) FROM service_categories WHERE is_active = 1)  AS categories_active,
      (SELECT COUNT(*) FROM gallery_items WHERE is_active = 1)       AS gallery_active,
      (SELECT COUNT(*) FROM testimonials)                            AS testimonials_total,
      (SELECT COUNT(*) FROM testimonials WHERE is_published = 1)     AS testimonials_published
  `)

  // Il n'existe pas de table « clientes » : on compte les adresses distinctes
  // des rendez-vous, ce qui est la seule mesure honnête disponible ici.
  const [customers] = await query(
    'SELECT COUNT(DISTINCT LOWER(email)) AS distinct_customers FROM appointments',
  )

  // ⚠️ Les clés « appointments » et « messages » gardent exactement leur forme
  // d'origine : tout consommateur existant continue de fonctionner.
  return {
    appointments: {
      total: Number(counts.total) || 0,
      pending: Number(counts.pending) || 0,
      confirmed: Number(counts.confirmed) || 0,
      cancelled: Number(counts.cancelled) || 0,
      // Clés ajoutées, aucune retirée : les consommateurs existants
      // continuent de lire exactement les mêmes champs qu'avant.
      inSalon: Number(counts.in_salon) || 0,
      completed: Number(counts.completed) || 0,
      today: Number(counts.today) || 0,
      upcoming: Number(counts.upcoming) || 0,
    },
    messages: { unread: Number(messages.unread) || 0 },
    catalog: {
      servicesActive: Number(catalog.services_active) || 0,
      servicesTotal: Number(catalog.services_total) || 0,
      categoriesActive: Number(catalog.categories_active) || 0,
      galleryActive: Number(catalog.gallery_active) || 0,
      testimonialsTotal: Number(catalog.testimonials_total) || 0,
      testimonialsPublished: Number(catalog.testimonials_published) || 0,
    },
    customers: { distinct: Number(customers.distinct_customers) || 0 },
  }
}
