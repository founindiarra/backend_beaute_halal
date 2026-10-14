import { execute, query, queryOne } from '../../config/database.js'
import { absoluteUrl, toShortTime } from '../../lib/url.js'

/**
 * Traitement d'un rendez-vous : présence, bureau, agent, paiements, reçu.
 *
 * Deux règles tiennent tout ce module :
 *
 *  1. Le montant restant n'est jamais stocké. Il se déduit de la prestation,
 *     de la réduction et de la somme des versements. Une valeur calculée ne
 *     peut pas se désynchroniser de ses composantes.
 *
 *  2. L'AGENT (la coiffeuse, `staff_id` → `team_members`) et l'UTILISATEUR
 *     (le compte du dashboard qui enregistre l'opération, `*_by` → `users`)
 *     sont deux personnes différentes et le restent partout : en base, dans
 *     l'API, dans le journal et sur le reçu.
 */

/** Étapes du traitement, dans l'ordre. Chacune dit d'où elle peut partir. */
export const TRANSITIONS = {
  arrival: { to: 'arrived', from: ['confirmed'], label: 'Présence de la cliente enregistrée' },
  start: { to: 'in_progress', from: ['arrived'], label: 'Prestation commencée' },
  complete: { to: 'completed', from: ['arrived', 'in_progress'], label: 'Prestation terminée' },
}

/** Statuts pour lesquels un traitement a un sens (page « Rendez-vous confirmés »). */
export const OPERATION_STATUSES = ['confirmed', 'arrived', 'in_progress', 'completed']

export const DISCOUNT_REASONS = [
  { value: 'loyalty', label: 'Fidélité' },
  { value: 'relationship', label: 'Relation client' },
  { value: 'gesture', label: 'Geste commercial' },
  { value: 'partnership', label: 'Partenariat' },
  { value: 'other', label: 'Autre' },
]

const SELECT = `
  SELECT a.*,
         t.name  AS staff_name,
         t.role  AS staff_role,
         t.phone AS staff_phone,
         t.image_url AS staff_image,
         o.number AS office_number,
         o.name   AS office_name,
         g.id     AS hairstyle_id,
         g.title  AS hairstyle_title,
         g.image_url AS hairstyle_image
  FROM appointments a
  LEFT JOIN team_members t ON t.id = a.staff_id
  LEFT JOIN offices      o ON o.id = a.office_id
  LEFT JOIN gallery_items g ON g.id = (
    SELECT gi.id FROM gallery_items gi
    WHERE gi.service_id = a.service_id AND gi.is_active = 1
    ORDER BY gi.is_featured DESC, gi.position, gi.id
    LIMIT 1
  )
`

const num = (value) => Number(value ?? 0)

/**
 * « 20 000 FCFA ». L'espace fine insécable qu'insère `Intl` est ramenée à une
 * espace ordinaire : elle voyage mal (journal, e-mail, PDF) et se retrouve
 * imprimée en caractère parasite.
 */
export const formatMontant = (value, currency = 'FCFA') =>
  `${new Intl.NumberFormat('fr-FR').format(Math.round(num(value))).replace(/[\u202f\u00a0]/g, ' ')} ${currency}`

/**
 * Récapitulatif financier. Seule source de vérité : tout ce qui affiche des
 * montants — écran, PDF, export — doit passer par ici et non recalculer.
 */
export function computeTotals(row, payments = []) {
  const total = num(row.price)
  const discount = Math.min(Math.max(num(row.discount_amount), 0), total)
  const payable = Math.max(total - discount, 0)
  const paid = payments.reduce((sum, payment) => sum + num(payment.amount), 0)
  const balance = Math.max(payable - paid, 0)

  let status = 'unpaid'
  if (payable === 0 || paid >= payable) status = 'paid'
  else if (paid > 0) status = 'partial'

  return { total, discount, payable, paid, balance, currency: row.currency, status }
}

const serializePayment = (row) => ({
  id: row.id,
  amount: num(row.amount),
  method: row.method,
  note: row.note,
  recordedBy: row.recorded_by ? { id: row.recorded_by, name: row.recorded_by_name } : null,
  recordedByName: row.recorded_by_name,
  createdAt: row.created_at,
})

const serializeEvent = (row) => ({
  id: row.id,
  kind: row.kind,
  label: row.label,
  actor: row.actor_id ? { id: row.actor_id, name: row.actor_name } : null,
  actorName: row.actor_name,
  createdAt: row.created_at,
})

const serializeDocument = (row) => ({
  id: row.id,
  kind: row.kind,
  number: row.number,
  issuedBy: row.issued_by ? { id: row.issued_by, name: row.issued_by_name } : null,
  issuedByName: row.issued_by_name,
  createdAt: row.created_at,
})

/**
 * Fiche complète d'un rendez-vous : la cliente, le créneau, la prestation,
 * le traitement, l'argent, le journal, les documents et l'avis éventuel.
 */
export function serializeOperation(row, { payments = [], events = [], documents = [], review = null } = {}) {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    date: row.appointment_date,
    time: toShortTime(row.appointment_time),
    durationMinutes: Number(row.duration_minutes),
    price: num(row.price),
    currency: row.currency,
    source: row.source,
    note: row.note,
    cancelReason: row.cancel_reason,

    service: { id: row.service_id, name: row.service_name },
    hairstyle: row.hairstyle_id
      ? {
          id: row.hairstyle_id,
          title: row.hairstyle_title,
          imageUrl: absoluteUrl(row.hairstyle_image),
        }
      : null,

    customer: {
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone,
      email: row.email,
    },

    /** L'agent qui réalise la coiffure. */
    agent: row.staff_id
      ? {
          id: row.staff_id,
          name: row.staff_name,
          role: row.staff_role,
          phone: row.staff_phone,
          imageUrl: absoluteUrl(row.staff_image),
        }
      : null,

    office: row.office_id
      ? { id: row.office_id, number: row.office_number, name: row.office_name }
      : null,

    /** Qui a enregistré quoi, et quand. Jamais confondu avec l'agent. */
    handling: {
      present: Boolean(row.arrived_at),
      arrivedAt: row.arrived_at,
      arrivedBy: row.arrived_by_name ? { id: row.arrived_by, name: row.arrived_by_name } : null,
      startedAt: row.started_at,
      startedBy: row.started_by_name ? { id: row.started_by, name: row.started_by_name } : null,
      completedAt: row.completed_at,
      completedBy: row.completed_by_name
        ? { id: row.completed_by, name: row.completed_by_name }
        : null,
      thankedAt: row.thanked_at,
    },

    discount: {
      amount: num(row.discount_amount),
      reason: row.discount_reason,
      note: row.discount_note,
      appliedBy: row.discount_by_name ? { id: row.discount_by, name: row.discount_by_name } : null,
      appliedAt: row.discount_at,
    },

    totals: computeTotals(row, payments),
    payments: payments.map(serializePayment),
    events: events.map(serializeEvent),
    documents: documents.map(serializeDocument),
    review,

    confirmedAt: row.confirmed_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/* ────────────────────────────── Lecture ─────────────────────────────────── */

export async function findRow(id) {
  return queryOne(`${SELECT} WHERE a.id = ? LIMIT 1`, [id])
}

export async function listPayments(appointmentId) {
  return query(
    'SELECT * FROM appointment_payments WHERE appointment_id = ? ORDER BY created_at, id',
    [appointmentId],
  )
}

export async function listEvents(appointmentId) {
  return query(
    'SELECT * FROM appointment_events WHERE appointment_id = ? ORDER BY created_at DESC, id DESC',
    [appointmentId],
  )
}

export async function listDocuments(appointmentId) {
  return query(
    'SELECT id, kind, number, issued_by, issued_by_name, created_at FROM appointment_documents WHERE appointment_id = ? ORDER BY created_at DESC, id DESC',
    [appointmentId],
  )
}

/** L'avis laissé après cette prestation, s'il en existe un. */
export async function findReview(appointmentId) {
  const row = await queryOne(
    'SELECT id, rating, comment, reviewed_on, is_published, created_at FROM testimonials WHERE appointment_id = ? ORDER BY id DESC LIMIT 1',
    [appointmentId],
  )
  if (!row) return null
  return {
    id: row.id,
    rating: Number(row.rating),
    comment: row.comment,
    reviewedOn: row.reviewed_on,
    isPublished: Boolean(Number(row.is_published)),
    createdAt: row.created_at,
  }
}

/** Fiche complète, en une fonction : c'est elle que renvoient toutes les routes. */
export async function getOperation(id) {
  const row = await findRow(id)
  if (!row) return null
  const [payments, events, documents, review] = await Promise.all([
    listPayments(id),
    listEvents(id),
    listDocuments(id),
    findReview(id),
  ])
  return serializeOperation(row, { payments, events, documents, review })
}

/* ────────────────────────────── Écriture ────────────────────────────────── */

/**
 * Consigne une opération. Le journal est en écriture seule : rien n'y est
 * jamais modifié ensuite. `actor` est toujours l'utilisateur connecté —
 * aucune route ne permet d'en désigner un autre.
 */
export async function logEvent(appointmentId, kind, label, actor) {
  await execute(
    'INSERT INTO appointment_events (appointment_id, kind, label, actor_id, actor_name) VALUES (?, ?, ?, ?, ?)',
    [appointmentId, kind, label, actor?.id ?? null, actor?.name ?? 'Système'],
  )
}

export async function insertPayment(appointmentId, { amount, note = null }, actor) {
  const result = await execute(
    `INSERT INTO appointment_payments
       (appointment_id, amount, method, note, recorded_by, recorded_by_name)
     VALUES (?, ?, 'cash', ?, ?, ?)`,
    [appointmentId, amount, note, actor?.id ?? null, actor?.name ?? 'Système'],
  )
  return result.insertId
}

export async function deletePayment(appointmentId, paymentId) {
  const result = await execute(
    'DELETE FROM appointment_payments WHERE id = ? AND appointment_id = ?',
    [paymentId, appointmentId],
  )
  return result.affectedRows > 0
}

export async function setDiscount(appointmentId, { amount, reason, note }, actor) {
  await execute(
    `UPDATE appointments
     SET discount_amount = ?, discount_reason = ?, discount_note = ?,
         discount_by = ?, discount_by_name = ?, discount_at = NOW()
     WHERE id = ?`,
    [amount, reason, note, actor?.id ?? null, actor?.name ?? 'Système', appointmentId],
  )
}

export async function setAssignment(appointmentId, { officeId, staffId }) {
  const fields = []
  const params = []
  if (officeId !== undefined) {
    fields.push('office_id = ?')
    params.push(officeId)
  }
  if (staffId !== undefined) {
    fields.push('staff_id = ?')
    params.push(staffId)
  }
  if (!fields.length) return
  params.push(appointmentId)
  await execute(`UPDATE appointments SET ${fields.join(', ')} WHERE id = ?`, params)
}

/** Avance le rendez-vous d'une étape, en gardant l'instant et l'auteur. */
export async function applyStep(appointmentId, step, actor) {
  const columns = {
    arrival: ['arrived_at', 'arrived_by', 'arrived_by_name'],
    start: ['started_at', 'started_by', 'started_by_name'],
    complete: ['completed_at', 'completed_by', 'completed_by_name'],
  }[step]

  await execute(
    `UPDATE appointments
     SET status = ?, ${columns[0]} = NOW(), ${columns[1]} = ?, ${columns[2]} = ?
     WHERE id = ?`,
    [TRANSITIONS[step].to, actor?.id ?? null, actor?.name ?? 'Système', appointmentId],
  )
}

export async function markThanked(appointmentId) {
  await execute('UPDATE appointments SET thanked_at = NOW() WHERE id = ?', [appointmentId])
}

/* ────────────────────────── Historique des clientes ─────────────────────── */

/**
 * Prestations passées, avec leur agent, leur bureau, leur argent et l'avis
 * éventuel. Tout vient de la base : rien n'est reconstitué côté écran.
 */
export async function listHistory({
  search = null,
  from = null,
  to = null,
  status = null,
  limit = 25,
  offset = 0,
} = {}) {
  const conditions = ["a.status IN ('completed', 'no_show')"]
  const params = []

  if (status) {
    conditions.length = 0
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

  const where = `WHERE ${conditions.join(' AND ')}`

  const [{ total }] = await query(
    `SELECT COUNT(*) AS total FROM appointments a ${where}`,
    params,
  )

  const rows = await query(
    `SELECT a.id, a.reference, a.appointment_date, a.appointment_time, a.status,
            a.service_name, a.price, a.currency, a.discount_amount,
            a.first_name, a.last_name, a.phone, a.email,
            t.name AS staff_name, o.number AS office_number, o.name AS office_name,
            (SELECT COALESCE(SUM(p.amount), 0) FROM appointment_payments p
              WHERE p.appointment_id = a.id) AS paid,
            r.id AS review_id, r.rating AS review_rating,
            r.comment AS review_comment, r.reviewed_on AS review_date
     FROM appointments a
     LEFT JOIN team_members t ON t.id = a.staff_id
     LEFT JOIN offices      o ON o.id = a.office_id
     LEFT JOIN testimonials r ON r.appointment_id = a.id
     ${where}
     ORDER BY a.appointment_date DESC, a.appointment_time DESC
     LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  )

  return {
    total: Number(total),
    rows: rows.map((row) => {
      const totals = computeTotals(
        { price: row.price, discount_amount: row.discount_amount, currency: row.currency },
        [{ amount: row.paid }],
      )
      return {
        id: row.id,
        reference: row.reference,
        status: row.status,
        date: row.appointment_date,
        time: toShortTime(row.appointment_time),
        serviceName: row.service_name,
        customer: {
          firstName: row.first_name,
          lastName: row.last_name,
          phone: row.phone,
          email: row.email,
        },
        agentName: row.staff_name,
        office: row.office_number ? `${row.office_number} — ${row.office_name}` : null,
        totals,
        review: row.review_id
          ? {
              id: row.review_id,
              rating: Number(row.review_rating),
              comment: row.review_comment,
              reviewedOn: row.review_date,
            }
          : null,
      }
    }),
  }
}
