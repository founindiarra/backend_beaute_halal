import { execute, query, queryOne } from '../../config/database.js'
import { jekoPret } from '../../lib/jeko.js'

export const STATUSES = ['pending', 'contacted', 'confirmed', 'rejected', 'cancelled', 'completed']

const dateOnly = (value) => {
  if (!value) return null
  if (value instanceof Date) {
    const p = (n) => String(n).padStart(2, '0')
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`
  }
  return String(value).slice(0, 10)
}

export const serialize = (row) => ({
  id: row.id,
  reference: row.reference,
  status: row.status,
  besoin: row.besoin,
  lockType: row.lock_type,
  methode: row.methode ?? null,
  volume: row.volume,
  longueur: row.longueur,
  formule: row.formule,
  delai: row.delai,
  etat: row.etat,
  estimate:
    row.estimate_total === null || row.estimate_total === undefined
      ? null
      : { total: Number(row.estimate_total), partial: Boolean(Number(row.estimate_partial)) },
  desiredDate: dateOnly(row.desired_date),
  desiredTime: row.desired_time ? String(row.desired_time).slice(0, 5) : null,
  /** Prestation souhaitée après une consultation (autre jour que la consultation) ; null sinon. */
  serviceDate: dateOnly(row.service_date),
  serviceTime: row.service_time ? String(row.service_time).slice(0, 5) : null,
  inspiration: row.inspiration_title
    ? { id: row.inspiration_id ?? null, title: row.inspiration_title }
    : null,
  customerId: row.customer_id ?? null,
  appointmentId: row.appointment_id ?? null,
  firstName: row.first_name,
  lastName: row.last_name,
  phone: row.phone,
  email: row.email,
  birthDate: dateOnly(row.birth_date),
  note: row.note,
  message: row.message,
  adminNote: row.admin_note,
  handledAt: row.handled_at,
  source: row.source,
  customerKind: row.customer_kind ?? null,
  consultation:
    row.consultation_mode || row.customer_kind
      ? {
          mode: row.consultation_mode ?? null,
          hasLocks: row.has_locks === null || row.has_locks === undefined ? null : Boolean(Number(row.has_locks)),
          date: dateOnly(row.consultation_date),
          time: row.consultation_time ? String(row.consultation_time).slice(0, 5) : null,
        }
      : null,
  payment: {
    status: row.payment_status ?? 'none',
    amount: row.payment_amount === null || row.payment_amount === undefined ? null : Number(row.payment_amount),
    method: row.payment_method ?? null,
    paidAt: row.paid_at ?? null,
  },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

/** Ce que la cliente a le droit de relire : jamais ses coordonnées complètes ni les notes internes. */
export const serializePublic = (row) => ({
  reference: row.reference,
  status: row.status,
  besoin: row.besoin,
  lockType: row.lock_type,
  desiredDate: dateOnly(row.desired_date),
  estimate:
    row.estimate_total === null || row.estimate_total === undefined
      ? null
      : { total: Number(row.estimate_total), partial: Boolean(Number(row.estimate_partial)) },
  firstName: row.first_name,
  desiredTime: row.desired_time ? String(row.desired_time).slice(0, 5) : null,
  /** Consultation prise sur place : le parcours s'est arrêté au paiement (pas de service réservé). */
  consultationOnly: ['sur_place', 'telephone', 'whatsapp'].includes(row.consultation_mode),
  consultation: row.consultation_mode
    ? {
        mode: row.consultation_mode,
        hasLocks: row.has_locks === null || row.has_locks === undefined ? null : Boolean(Number(row.has_locks)),
        date: dateOnly(row.consultation_date),
        time: row.consultation_time ? String(row.consultation_time).slice(0, 5) : null,
      }
    : null,
  payment: {
    status: row.payment_status ?? 'none',
    amount: row.payment_amount === null || row.payment_amount === undefined ? null : Number(row.payment_amount),
    required: Boolean(Number(row.awaiting_payment)),
    /** Le paiement en ligne est-il utilisable ? Sinon la page l'explique et propose le contact direct. */
    available: jekoPret(),
  },
  createdAt: row.created_at,
})

const COLUMNS = `id, reference, status, besoin, lock_type, methode, volume, longueur, formule, delai, etat,
  estimate_total, estimate_partial, desired_date, desired_time, inspiration_id, inspiration_title, customer_id,
  appointment_id,
  first_name, last_name, phone, email, birth_date, note, message, admin_note, handled_at, source,
  customer_kind, consultation_mode, has_locks, consultation_date, consultation_time, service_date, service_time,
  awaiting_payment, payment_status, payment_amount, payment_method, payment_provider_id, paid_at,
  created_at, updated_at`

export async function insertRequest(r) {
  const result = await execute(
    `INSERT INTO booking_requests
       (reference, besoin, lock_type, methode, volume, longueur, formule, delai, etat,
        estimate_total, estimate_partial, desired_date, desired_time, inspiration_id, inspiration_title,
        first_name, last_name, phone, email, birth_date, note, message, ip_address,
        customer_kind, consultation_mode, has_locks, consultation_date, consultation_time, service_date, service_time,
        awaiting_payment, payment_status, payment_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.reference, r.besoin, r.lockType, r.methode ?? null, r.volume, r.longueur, r.formule, r.delai, r.etat,
      r.estimateTotal, r.estimatePartial ? 1 : 0, r.desiredDate, r.desiredTime ?? null, r.inspirationId, r.inspirationTitle,
      r.firstName, r.lastName, r.phone, r.email, r.birthDate, r.note, r.message, r.ip,
      r.customerKind ?? null, r.consultationMode ?? null,
      r.hasLocks === null || r.hasLocks === undefined ? null : r.hasLocks ? 1 : 0,
      r.consultationDate ?? null, r.consultationTime ?? null, r.serviceDate ?? null, r.serviceTime ?? null,
      r.awaitingPayment ? 1 : 0, r.awaitingPayment ? 'pending' : 'none', r.paymentAmount ?? null,
    ],
  )
  return findById(result.insertId)
}

export const findById = (id) =>
  queryOne(`SELECT ${COLUMNS} FROM booking_requests WHERE id = ? LIMIT 1`, [id])

export const findByReference = (reference) =>
  queryOne(`SELECT ${COLUMNS} FROM booking_requests WHERE reference = ? LIMIT 1`, [reference])

const CLE_TEL = "RIGHT(REGEXP_REPLACE(phone, '[^0-9]', ''), 10)"

/** Rendez-vous de « Soins capillaires » = CONSULTATION capillaire (sur place, téléphone ou WhatsApp). Les demandes de coiffure (installation, resserrage…) n'en font pas partie. */
const EST_SOIN = "consultation_mode IN ('sur_place','telephone','whatsapp')"

export async function listRequests({ status, search, from, to, order, limit, offset, phoneKey, kind }) {
  /* Une demande qui attend son paiement n'existe pas encore pour le salon. */
  const where = ['awaiting_payment = 0']
  const params = []
  if (kind === 'soin') where.push(EST_SOIN)
  if (status) {
    where.push('status = ?')
    params.push(status)
  }
  if (phoneKey) {
    where.push(`${CLE_TEL} = ?`)
    params.push(String(phoneKey).replace(/\D/g, '').slice(-10))
  }
  if (from) {
    where.push('DATE(created_at) >= ?')
    params.push(from)
  }
  if (to) {
    where.push('DATE(created_at) <= ?')
    params.push(to)
  }
  if (search) {
    const like = `%${search.replace(/[%_\\]/g, '\\$&')}%`
    where.push('(reference LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR phone LIKE ? OR email LIKE ?)')
    params.push(like, like, like, like, like)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM booking_requests ${clause}`, params)
  const rows = await query(
    `SELECT ${COLUMNS} FROM booking_requests ${clause}
     ORDER BY created_at ${order === 'asc' ? 'ASC' : 'DESC'}, id DESC
     LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  )
  return { total: Number(total), rows }
}

export async function updateRequest(id, { status, adminNote }) {
  const fields = []
  const params = []
  if (status !== undefined) {
    fields.push('status = ?')
    params.push(status)
    // La première décision date la prise en charge.
    fields.push("handled_at = IF(? <> 'pending' AND handled_at IS NULL, NOW(), handled_at)")
    params.push(status)
  }
  if (adminNote !== undefined) {
    fields.push('admin_note = ?')
    params.push(adminNote || null)
  }
  if (!fields.length) return findById(id)
  params.push(id)
  await execute(`UPDATE booking_requests SET ${fields.join(', ')} WHERE id = ?`, params)
  return findById(id)
}

export async function deleteRequest(id) {
  const result = await execute('DELETE FROM booking_requests WHERE id = ?', [id])
  return result.affectedRows > 0
}

export async function requestStats() {
  const rows = await query('SELECT status, COUNT(*) AS total FROM booking_requests WHERE awaiting_payment = 0 GROUP BY status')
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]))
  rows.forEach((r) => {
    byStatus[r.status] = Number(r.total)
  })
  const [{ today }] = await query(
    'SELECT COUNT(*) AS today FROM booking_requests WHERE awaiting_payment = 0 AND DATE(created_at) = CURDATE()',
  )
  const upcoming = await query(
    `SELECT COUNT(*) AS total FROM booking_requests
     WHERE awaiting_payment = 0 AND status IN ('pending','contacted','confirmed') AND desired_date >= CURDATE()`,
  )
  return {
    total: Object.values(byStatus).reduce((a, b) => a + b, 0),
    byStatus,
    newToday: Number(today),
    upcomingWished: Number(upcoming[0].total),
  }
}


/** Paiement : état de la demande vis-à-vis de Jèko. */
export async function setPaymentAttempt(id, { method, providerId }) {
  await execute("UPDATE booking_requests SET payment_method = ?, payment_provider_id = ?, payment_status = 'pending' WHERE id = ?", [method, providerId, id])
}
export async function markPaymentFailed(id) {
  await execute("UPDATE booking_requests SET payment_status = 'failed' WHERE id = ? AND payment_status <> 'paid'", [id])
}
/** Marque payée, une seule fois : renvoie vrai si CET appel a fait passer la demande à « payée » (idempotence des webhooks). */
export async function markPaid(id) {
  const r = await execute(
    "UPDATE booking_requests SET payment_status = 'paid', awaiting_payment = 0, paid_at = NOW() WHERE id = ? AND payment_status <> 'paid'",
    [id],
  )
  return r.affectedRows > 0
}


/**
 * Historique des clientes : une ligne par cliente (numéro de téléphone) qui a PRIS un rendez-vous de soin capillaire
 * (consultation capillaire, payée ou sans frais), quel que soit l'état de la demande. Les demandes de coiffure et les
 * demandes qui attendent encore leur paiement n'y figurent pas. De la plus récente à la plus ancienne.
 */
export async function listClients({ search, limit, offset }) {
  const where = ['br.awaiting_payment = 0', EST_SOIN.replace(/consultation_mode/g, 'br.consultation_mode')]
  const params = []
  if (search) {
    const like = `%${search.replace(/[%_\\]/g, '\\$&')}%`
    where.push('(br.reference LIKE ? OR br.first_name LIKE ? OR br.last_name LIKE ? OR br.phone LIKE ? OR br.email LIKE ?)')
    params.push(like, like, like, like, like)
  }
  const cle = "RIGHT(REGEXP_REPLACE(br.phone, '[^0-9]', ''), 10)"
  const base = `FROM booking_requests br LEFT JOIN appointments a ON a.id = br.appointment_id WHERE ${where.join(' AND ')}`
  const groupe = `SELECT ${cle} AS cle, COUNT(*) AS demandes,
                    SUM(br.status IN ('confirmed','completed') OR a.status IN ('confirmed','arrived','in_progress','completed')) AS confirmees,
                    SUM(br.status = 'completed' OR a.status = 'completed') AS terminees,
                    SUM(br.status IN ('cancelled','rejected')) AS annulees,
                    MAX(br.created_at) AS derniere_demande, MAX(br.id) AS derniere_id
               ${base} GROUP BY ${cle}
`
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM (${groupe}) t`, params)
  const rows = await query(
    `SELECT g.*, l.first_name, l.last_name, l.phone, l.email, l.reference AS last_reference, l.status AS last_status,
            l.besoin AS last_besoin, l.lock_type AS last_lock_type, l.consultation_mode AS last_mode
       FROM (${groupe}) g
       JOIN booking_requests l ON l.id = g.derniere_id
      ORDER BY g.derniere_demande DESC, g.derniere_id DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  )
  return {
    total: Number(total),
    rows: rows.map((r) => ({
      key: r.cle,
      firstName: r.first_name,
      lastName: r.last_name,
      phone: r.phone,
      email: r.email,
      requests: Number(r.demandes),
      confirmed: Number(r.confirmees),
      completed: Number(r.terminees),
      cancelled: Number(r.annulees),
      lastAt: r.derniere_demande,
      lastReference: r.last_reference,
      lastStatus: r.last_status,
      lastBesoin: r.last_besoin,
      lastLockType: r.last_lock_type,
      lastMode: r.last_mode,
    })),
  }
}
