import { execute, query, queryOne } from '../../config/database.js'
import { normaliserTelephone } from '../../lib/phone.js'

/**
 * Les clientes du salon.
 *
 * Une fiche se crée toute seule : dès qu'un rendez-vous est déposé, le
 * numéro est cherché en base et, s'il est inconnu, une fiche est ouverte.
 * Personne n'a donc à « saisir une cliente » — ce serait une corvée, et une
 * corvée n'est jamais faite.
 *
 * Ce qui se compte (visites, dépense totale, dernier passage) n'est jamais
 * stocké sur la fiche : tout se déduit des rendez-vous. Un compteur qu'on
 * incrémente à la main finit toujours par mentir, le jour où un rendez-vous
 * est supprimé ou rattaché ailleurs.
 */

const SELECT = `
  SELECT c.*,
         (SELECT COUNT(*) FROM appointments a
           WHERE a.customer_id = c.id AND a.status = 'completed')      AS visites,
         (SELECT COUNT(*) FROM appointments a
           WHERE a.customer_id = c.id
             AND a.status IN ('pending','confirmed','arrived','in_progress')) AS a_venir,
         (SELECT MAX(a.appointment_date) FROM appointments a
           WHERE a.customer_id = c.id AND a.status = 'completed')      AS derniere_visite,
         (SELECT COALESCE(SUM(p.amount), 0) FROM appointment_payments p
            JOIN appointments a ON a.id = p.appointment_id
           WHERE a.customer_id = c.id)                                 AS total_paye
  FROM customers c
`

export function serializeCustomer(row) {
  if (!row) return null
  return {
    id: row.id,
    phone: row.phone,
    phoneKey: row.phone_key,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: `${row.first_name} ${row.last_name}`.trim(),
    email: row.email,
    birthDate: row.birth_date,
    note: row.note,
    smsOptIn: Boolean(Number(row.sms_opt_in)),
    emailOptIn: Boolean(Number(row.email_opt_in)),
    /** Compté depuis les rendez-vous, jamais stocké. */
    visits: Number(row.visites ?? 0),
    upcoming: Number(row.a_venir ?? 0),
    lastVisit: row.derniere_visite ?? null,
    totalPaid: Number(row.total_paye ?? 0),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Vue réduite, pour le site public : rien qui n'ait été saisi par la cliente. */
export function serializePublicCustomer(row) {
  if (!row) return null
  return {
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
  }
}

export async function findById(id) {
  return queryOne(`${SELECT} WHERE c.id = ? LIMIT 1`, [id])
}

export async function findByPhone(phone) {
  const cle = normaliserTelephone(phone)
  if (cle.length < 8) return null
  return queryOne(`${SELECT} WHERE c.phone_key = ? LIMIT 1`, [cle])
}

/**
 * Retrouve la fiche correspondant à ce numéro, ou l'ouvre.
 *
 * Appelé à chaque rendez-vous déposé. Le nom et l'e-mail de la fiche sont
 * rafraîchis avec ceux du dernier rendez-vous : une cliente qui corrige
 * l'orthographe de son nom ou change d'adresse doit voir la fiche suivre.
 * En revanche on n'écrase jamais avec du vide.
 *
 * `ON DUPLICATE KEY UPDATE` plutôt que « chercher puis insérer » : deux
 * réservations simultanées avec le même numéro ne doivent pas produire deux
 * fiches, et c'est l'index unique qui en décide, pas l'ordre des requêtes.
 */
export async function upsertFromAppointment({
  phone,
  firstName,
  lastName,
  email,
  birthDate = null,
}) {
  const cle = normaliserTelephone(phone)
  if (cle.length < 8) return null

  /*
   * La date de naissance ne s'efface jamais toute seule.
   *
   * Elle est facultative sur le site : une cliente qui réserve une deuxième
   * fois sans la ressaisir ne doit pas perdre celle qu'elle avait donnée la
   * première. `COALESCE(NULLIF(...))` garde donc l'ancienne valeur quand la
   * nouvelle est vide — et accepte la correction quand elle ne l'est pas.
   * Même règle que l'e-mail, pour la même raison.
   */
  await execute(
    `INSERT INTO customers
       (phone, phone_key, first_name, last_name, email, birth_date, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       phone      = VALUES(phone),
       first_name = VALUES(first_name),
       last_name  = VALUES(last_name),
       email      = COALESCE(NULLIF(VALUES(email), ''), email),
       birth_date = COALESCE(VALUES(birth_date), birth_date),
       last_seen_at = NOW()`,
    [phone, cle, firstName, lastName, email ?? null, birthDate || null],
  )

  return queryOne(`${SELECT} WHERE c.phone_key = ? LIMIT 1`, [cle])
}

export async function updateCustomer(id, data) {
  const columns = {
    firstName: 'first_name',
    lastName: 'last_name',
    email: 'email',
    birthDate: 'birth_date',
    note: 'note',
    smsOptIn: 'sms_opt_in',
    emailOptIn: 'email_opt_in',
  }
  const fields = []
  const params = []

  for (const [key, column] of Object.entries(columns)) {
    if (data[key] === undefined) continue
    fields.push(`${column} = ?`)
    const value = data[key]
    params.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value === '' ? null : value))
  }

  /* Changer le numéro change le matricule : les deux vont ensemble. */
  if (data.phone !== undefined) {
    const cle = normaliserTelephone(data.phone)
    fields.push('phone = ?', 'phone_key = ?')
    params.push(data.phone, cle)
  }

  if (fields.length) {
    params.push(id)
    await execute(`UPDATE customers SET ${fields.join(', ')} WHERE id = ?`, params)
  }
  return findById(id)
}

export async function insertCustomer(data) {
  const cle = normaliserTelephone(data.phone)
  const result = await execute(
    `INSERT INTO customers
       (phone, phone_key, first_name, last_name, email, birth_date, note,
        sms_opt_in, email_opt_in, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      data.phone,
      cle,
      data.firstName,
      data.lastName,
      data.email || null,
      data.birthDate || null,
      data.note || null,
      data.smsOptIn === false ? 0 : 1,
      data.emailOptIn === false ? 0 : 1,
    ],
  )
  return findById(result.insertId)
}

export async function deleteCustomer(id) {
  const result = await execute('DELETE FROM customers WHERE id = ?', [id])
  return result.affectedRows > 0
}

/* ─────────────────────────────── Listes ─────────────────────────────────── */

export async function listCustomers({
  search = null,
  /** 'new' (une seule visite), 'returning' (deux et plus), 'birthday' (ce mois). */
  segment = null,
  limit = 25,
  offset = 0,
  order = 'recent',
} = {}) {
  const conditions = []
  const params = []

  if (search) {
    conditions.push(
      '(c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR c.phone_key LIKE ?)',
    )
    const like = `%${search}%`
    const cle = `%${normaliserTelephone(search)}%`
    params.push(like, like, like, cle)
  }

  let having = ''
  if (segment === 'new') having = 'HAVING visites <= 1'
  else if (segment === 'returning') having = 'HAVING visites >= 2'
  else if (segment === 'birthday') {
    conditions.push('c.birth_date IS NOT NULL AND MONTH(c.birth_date) = MONTH(CURDATE())')
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  /*
   * Le total passe par une sous-requête plutôt que par un COUNT direct :
   * `visites` est une colonne calculée, et un HAVING ne peut pas s'appliquer
   * à un COUNT(*) tout seul.
   */
  const [{ total }] = await query(
    `SELECT COUNT(*) AS total FROM (
       SELECT c.id,
              (SELECT COUNT(*) FROM appointments a
                WHERE a.customer_id = c.id AND a.status = 'completed') AS visites
       FROM customers c ${where} ${having}
     ) AS filtre`,
    params,
  )

  const tri =
    {
      recent: 'c.last_seen_at DESC, c.id DESC',
      name: 'c.last_name ASC, c.first_name ASC',
      visits: 'visites DESC, c.last_seen_at DESC',
    }[order] ?? 'c.last_seen_at DESC, c.id DESC'

  const rows = await query(
    `${SELECT} ${where} ${having} ORDER BY ${tri} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  )

  return { total: Number(total), rows: rows.map(serializeCustomer) }
}

/** Les rendez-vous d'une cliente, du plus récent au plus ancien. */
export async function listVisits(customerId) {
  const rows = await query(
    `SELECT a.id, a.reference, a.status, a.appointment_date, a.appointment_time,
            a.service_name, a.price, a.currency, a.discount_amount,
            t.name AS staff_name, o.number AS office_number, o.name AS office_name,
            (SELECT COALESCE(SUM(p.amount), 0) FROM appointment_payments p
              WHERE p.appointment_id = a.id) AS paye,
            r.rating AS review_rating, r.comment AS review_comment
     FROM appointments a
     LEFT JOIN team_members t ON t.id = a.staff_id
     LEFT JOIN offices      o ON o.id = a.office_id
     LEFT JOIN testimonials r ON r.appointment_id = a.id
     WHERE a.customer_id = ?
     ORDER BY a.appointment_date DESC, a.appointment_time DESC`,
    [customerId],
  )

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    status: row.status,
    date: row.appointment_date,
    time: String(row.appointment_time).slice(0, 5),
    serviceName: row.service_name,
    price: Number(row.price),
    discount: Number(row.discount_amount ?? 0),
    paid: Number(row.paye ?? 0),
    currency: row.currency,
    agentName: row.staff_name,
    office: row.office_number ? `${row.office_number} — ${row.office_name}` : null,
    review: row.review_rating
      ? { rating: Number(row.review_rating), comment: row.review_comment }
      : null,
  }))
}

/** Les messages déjà envoyés à une cliente. */
export async function listMessages(customerId, limit = 20) {
  return query(
    `SELECT id, channel, kind, subject, body, status, error, sent_by_name, created_at, sent_at
     FROM message_logs WHERE customer_id = ?
     ORDER BY created_at DESC LIMIT ${Number(limit)}`,
    [customerId],
  )
}

/**
 * Les anniversaires du jour — ou d'un jour donné.
 *
 * On compare le jour et le mois, jamais l'année : une date de naissance
 * complète n'est pas toujours connue, et l'année n'entre de toute façon pas
 * dans un anniversaire.
 */
export async function birthdaysOn(dateKey = null) {
  const rows = await query(
    `${SELECT}
     WHERE c.birth_date IS NOT NULL
       AND DAY(c.birth_date)   = DAY(COALESCE(?, CURDATE()))
       AND MONTH(c.birth_date) = MONTH(COALESCE(?, CURDATE()))
     ORDER BY c.first_name`,
    [dateKey, dateKey],
  )
  return rows.map(serializeCustomer)
}

/**
 * Jour et mois d'une date de naissance, quelle que soit sa forme.
 *
 * `mysql2` rend une colonne DATE tantôt comme objet Date, tantôt comme
 * chaîne « AAAA-MM-JJ » selon la configuration du pilote. Passer par
 * `toISOString()` sur un objet Date décalerait le jour d'un cran pour tout
 * fuseau à l'ouest de Greenwich — et Abidjan est à UTC. On lit donc les
 * composantes locales, jamais la représentation ISO.
 */
function moisEtJour(valeur) {
  if (!valeur) return null
  if (valeur instanceof Date) {
    return { mois: valeur.getMonth(), jour: valeur.getDate() }
  }
  const [, m, j] = String(valeur).slice(0, 10).split('-').map(Number)
  return m && j ? { mois: m - 1, jour: j } : null
}

/**
 * Le prochain anniversaire à partir d'aujourd'hui, inclus.
 *
 * Le 29 février est fêté le 28 les années non bissextiles : c'est l'usage,
 * et une cliente née ce jour-là mérite d'être souhaitée trois années sur
 * quatre plutôt qu'une. D'où le `Math.min` sur le dernier jour du mois.
 */
function prochainAnniversaire({ mois, jour }, aujourdhui) {
  const annee = aujourdhui.getFullYear()
  for (const candidate of [annee, annee + 1]) {
    const dernierJourDuMois = new Date(candidate, mois + 1, 0).getDate()
    const date = new Date(candidate, mois, Math.min(jour, dernierJourDuMois))
    date.setHours(0, 0, 0, 0)
    if (date >= aujourdhui) return date
  }
  return null
}

/**
 * Les anniversaires des prochains jours.
 *
 * Souhaiter le jour même laisse le salon sans préparation : il veut écrire
 * un mot, parfois prévoir un geste. La fenêtre part donc d'aujourd'hui et
 * couvre les jours suivants, pour qu'un anniversaire soit toujours vu au
 * moins la veille.
 *
 * Le calcul se fait en JavaScript plutôt qu'en SQL. Ce n'est pas de la
 * paresse : la version SQL de ce calcul, avec le report d'année et le cas du
 * 29 février, tient en quatre fonctions imbriquées que personne ne relira.
 * Le salon compte ses clientes par centaines, pas par millions — les lire
 * toutes coûte quelques millisecondes, et le code reste vérifiable.
 */
export async function upcomingBirthdays({ days = 7 } = {}) {
  const fenetre = Math.min(Math.max(Number(days) || 7, 1), 60)

  const rows = await query(`${SELECT} WHERE c.birth_date IS NOT NULL`)

  const aujourdhui = new Date()
  aujourdhui.setHours(0, 0, 0, 0)
  const JOUR_MS = 24 * 60 * 60 * 1000

  return rows
    .map((row) => {
      const repere = moisEtJour(row.birth_date)
      if (!repere) return null
      const date = prochainAnniversaire(repere, aujourdhui)
      if (!date) return null
      const dans = Math.round((date - aujourdhui) / JOUR_MS)
      if (dans > fenetre) return null
      return {
        ...serializeCustomer(row),
        /** 0 = aujourd'hui, 1 = demain, etc. */
        inDays: dans,
        /** La date effective de la fête, 29 février reporté compris. */
        nextBirthday: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.inDays - b.inDays || a.firstName.localeCompare(b.firstName))
}

/** Compteurs de la page Clientes. */
export async function customerStats() {
  const [row] = await query(`
    SELECT
      (SELECT COUNT(*) FROM customers) AS total,
      (SELECT COUNT(*) FROM customers WHERE birth_date IS NOT NULL
         AND MONTH(birth_date) = MONTH(CURDATE())) AS anniversaires_du_mois,
      (SELECT COUNT(*) FROM customers c WHERE (
         SELECT COUNT(*) FROM appointments a
          WHERE a.customer_id = c.id AND a.status = 'completed') >= 2) AS fideles,
      (SELECT COUNT(*) FROM customers WHERE sms_opt_in = 1) AS joignables_sms
  `)
  return {
    total: Number(row.total) || 0,
    birthdaysThisMonth: Number(row.anniversaires_du_mois) || 0,
    returning: Number(row.fideles) || 0,
    smsReachable: Number(row.joignables_sms) || 0,
  }
}
