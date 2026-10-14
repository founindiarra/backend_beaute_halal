import { execute, query, queryOne } from '../../config/database.js'
import { computeTotals, listPayments } from '../operations/model.js'
import { getSettings } from '../salon/model.js'

/**
 * Proformas et reçus.
 *
 * Le PDF n'est jamais conservé sur le disque : il est réimprimé à la demande.
 * Ce qui est conservé, c'est son NUMÉRO et l'INSTANTANÉ des montants au
 * moment où il a été établi.
 *
 * Cet instantané n'est pas une optimisation, c'est la règle : un reçu remis à
 * une cliente ne doit pas changer parce qu'une réduction a été saisie une
 * heure plus tard. Le reçu se réimprime donc toujours depuis son instantané.
 *
 * Le proforma, lui, décrit ce qui est prévu et non ce qui a été payé : il est
 * réédité depuis l'état courant du rendez-vous à chaque nouvelle demande.
 */

const PREFIX = { proforma: 'PRO', receipt: 'REC' }

/**
 * Numéro de la forme « REC-2026-0042 » : type, année, rang dans l'année.
 * Le rang se déduit du nombre de documents déjà émis cette année-là ; si
 * deux émissions se croisent, l'index UNIQUE rejette la seconde et la route
 * réessaie. C'est la base qui arbitre, pas un compteur applicatif.
 */
export async function nextNumber(kind) {
  const year = new Date().getFullYear()
  const [{ total }] = await query(
    'SELECT COUNT(*) AS total FROM appointment_documents WHERE kind = ? AND YEAR(created_at) = ?',
    [kind, year],
  )
  return `${PREFIX[kind]}-${year}-${String(Number(total) + 1).padStart(4, '0')}`
}

/** Tout ce dont le PDF a besoin, figé à l'instant de l'émission. */
export async function buildSnapshot(row, kind) {
  const [payments, settings] = await Promise.all([listPayments(row.id), getSettings()])
  const totals = computeTotals(row, payments)

  return {
    kind,
    issuedAt: new Date().toISOString(),
    salon: {
      name: settings.name || 'Beauté Halal',
      specialty: settings.specialty || '',
      phone: settings.phone_display || '',
      email: settings.email || '',
      address: [settings.address_line1, settings.address_line2, settings.address_city]
        .filter(Boolean)
        .join(', '),
    },
    appointment: {
      reference: row.reference,
      date: row.appointment_date,
      time: String(row.appointment_time).slice(0, 5),
      durationMinutes: Number(row.duration_minutes),
      serviceName: row.service_name,
      hairstyle: row.hairstyle_title ?? null,
      note: row.note ?? null,
      status: row.status,
    },
    customer: {
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone,
      email: row.email,
    },
    /** La coiffeuse qui réalise la prestation. */
    agent: row.staff_id ? { name: row.staff_name, role: row.staff_role } : null,
    office: row.office_id ? { number: row.office_number, name: row.office_name } : null,
    /** L'utilisateur du dashboard qui a enregistré la présence. Jamais l'agent. */
    handledBy: row.arrived_by_name
      ? { name: row.arrived_by_name, at: row.arrived_at }
      : null,
    completedBy: row.completed_by_name
      ? { name: row.completed_by_name, at: row.completed_at }
      : null,
    discount: {
      amount: totals.discount,
      reason: row.discount_reason,
      note: row.discount_note,
      appliedBy: row.discount_by_name ?? null,
    },
    totals,
    payments: payments.map((payment) => ({
      amount: Number(payment.amount),
      method: payment.method,
      recordedBy: payment.recorded_by_name,
      createdAt: payment.created_at,
    })),
  }
}

export async function insertDocument({ appointmentId, kind, number, snapshot }, actor) {
  const result = await execute(
    `INSERT INTO appointment_documents
       (appointment_id, kind, number, snapshot, issued_by, issued_by_name)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      appointmentId,
      kind,
      number,
      JSON.stringify(snapshot),
      actor?.id ?? null,
      actor?.name ?? 'Système',
    ],
  )
  return result.insertId
}

export async function findDocument(id) {
  return queryOne('SELECT * FROM appointment_documents WHERE id = ? LIMIT 1', [id])
}

/** Dernier document de ce type pour ce rendez-vous. */
export async function findLatest(appointmentId, kind) {
  return queryOne(
    'SELECT * FROM appointment_documents WHERE appointment_id = ? AND kind = ? ORDER BY id DESC LIMIT 1',
    [appointmentId, kind],
  )
}

export function readSnapshot(row) {
  if (!row?.snapshot) return null
  try {
    return JSON.parse(row.snapshot)
  } catch {
    return null
  }
}
