import { execute, query, queryOne } from '../../config/database.js'

/**
 * Comptabilité du salon : la caisse, les banques, les dépenses.
 *
 * Trois règles tiennent tout ce module.
 *
 *  1. UN SOLDE NE SE STOCKE PAS. Il s'additionne depuis les écritures, à
 *     chaque fois qu'on le demande. Un solde tenu à part finit toujours par
 *     diverger de ses écritures, et on ne sait alors plus laquelle des deux
 *     valeurs est vraie.
 *
 *  2. LES MONTANTS SONT TOUJOURS POSITIFS. C'est `direction` qui dit le sens,
 *     'in' ou 'out'. Des montants signés invitent au signe oublié dans une
 *     somme, et une caisse fausse ne se remarque parfois qu'un mois plus tard.
 *
 *  3. TOUT ENCAISSEMENT ENTRE EN CAISSE, automatiquement. Le salon ne saisit
 *     pas deux fois la même recette : elle est écrite au moment où la cliente
 *     paie, depuis la fiche du rendez-vous.
 */

const num = (v) => Number(v ?? 0)

export const KINDS = {
  payment: 'Encaissement',
  expense: 'Dépense',
  transfer: 'Transfert',
  adjustment: 'Régularisation',
}

/* ──────────────────────────────── Comptes ───────────────────────────────── */

const serializeAccount = (row) => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  bankName: row.bank_name,
  accountNumber: row.account_number,
  note: row.note,
  isActive: Boolean(Number(row.is_active)),
  position: Number(row.position),
  balance: num(row.solde),
  entries: Number(row.ecritures ?? 0),
})

const SELECT_ACCOUNTS = `
  SELECT a.*,
         (SELECT COALESCE(SUM(IF(l.direction = 'in', l.amount, -l.amount)), 0)
            FROM ledger_entries l WHERE l.account_id = a.id) AS solde,
         (SELECT COUNT(*) FROM ledger_entries l WHERE l.account_id = a.id) AS ecritures
  FROM cash_accounts a
`

export async function listAccounts({ onlyActive = false } = {}) {
  const rows = await query(
    `${SELECT_ACCOUNTS} ${onlyActive ? 'WHERE a.is_active = 1' : ''}
     ORDER BY a.kind = 'bank', a.position, a.id`,
  )
  return rows.map(serializeAccount)
}

export async function findAccount(id) {
  const row = await queryOne(`${SELECT_ACCOUNTS} WHERE a.id = ? LIMIT 1`, [id])
  return row ? serializeAccount(row) : null
}

/** La caisse : le compte par lequel passent tous les encaissements. */
export async function cashAccount() {
  const row = await queryOne(`${SELECT_ACCOUNTS} WHERE a.kind = 'cash' ORDER BY a.id LIMIT 1`)
  return row ? serializeAccount(row) : null
}

export async function insertAccount(data) {
  const result = await execute(
    `INSERT INTO cash_accounts (kind, name, bank_name, account_number, note, is_active, position)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      data.kind ?? 'bank',
      data.name,
      data.bankName || null,
      data.accountNumber || null,
      data.note || null,
      data.isActive === false ? 0 : 1,
      data.position ?? 0,
    ],
  )
  return findAccount(result.insertId)
}

export async function updateAccount(id, data) {
  const columns = {
    name: 'name',
    bankName: 'bank_name',
    accountNumber: 'account_number',
    note: 'note',
    isActive: 'is_active',
    position: 'position',
  }
  const fields = []
  const params = []
  for (const [key, column] of Object.entries(columns)) {
    if (data[key] === undefined) continue
    fields.push(`${column} = ?`)
    const v = data[key]
    params.push(typeof v === 'boolean' ? (v ? 1 : 0) : (v === '' ? null : v))
  }
  if (fields.length) {
    params.push(id)
    await execute(`UPDATE cash_accounts SET ${fields.join(', ')} WHERE id = ?`, params)
  }
  return findAccount(id)
}

export async function deleteAccount(id) {
  const result = await execute('DELETE FROM cash_accounts WHERE id = ?', [id])
  return result.affectedRows > 0
}

/* ───────────────────────── Catégories de dépenses ───────────────────────── */

const serializeCategory = (row) => ({
  id: row.id,
  name: row.name,
  isActive: Boolean(Number(row.is_active)),
  position: Number(row.position),
  used: Number(row.utilisations ?? 0),
})

export async function listCategories() {
  const rows = await query(`
    SELECT c.*,
           (SELECT COUNT(*) FROM ledger_entries l WHERE l.category_id = c.id) AS utilisations
    FROM expense_categories c ORDER BY c.position, c.name
  `)
  return rows.map(serializeCategory)
}

export async function insertCategory(data) {
  const result = await execute(
    'INSERT INTO expense_categories (name, position) VALUES (?, ?)',
    [data.name, data.position ?? 0],
  )
  const row = await queryOne('SELECT * FROM expense_categories WHERE id = ?', [result.insertId])
  return serializeCategory(row)
}

export async function updateCategory(id, data) {
  const fields = []
  const params = []
  if (data.name !== undefined) {
    fields.push('name = ?')
    params.push(data.name)
  }
  if (data.isActive !== undefined) {
    fields.push('is_active = ?')
    params.push(data.isActive ? 1 : 0)
  }
  if (data.position !== undefined) {
    fields.push('position = ?')
    params.push(data.position)
  }
  if (fields.length) {
    params.push(id)
    await execute(`UPDATE expense_categories SET ${fields.join(', ')} WHERE id = ?`, params)
  }
  const row = await queryOne('SELECT * FROM expense_categories WHERE id = ?', [id])
  return row ? serializeCategory(row) : null
}

export async function deleteCategory(id) {
  const result = await execute('DELETE FROM expense_categories WHERE id = ?', [id])
  return result.affectedRows > 0
}

/* ────────────────────────────── Écritures ───────────────────────────────── */

const serializeEntry = (row) => ({
  id: row.id,
  kind: row.kind,
  kindLabel: KINDS[row.kind] ?? row.kind,
  direction: row.direction,
  amount: num(row.amount),
  currency: row.currency,
  label: row.label,
  occurredOn: row.occurred_on,
  account: { id: row.account_id, name: row.account_name, kind: row.account_kind },
  category: row.category_id ? { id: row.category_id, name: row.category_name } : null,
  appointment: row.appointment_id
    ? { id: row.appointment_id, reference: row.appointment_reference }
    : null,
  transferRef: row.transfer_ref,
  recordedByName: row.recorded_by_name,
  createdAt: row.created_at,
})

const SELECT_ENTRIES = `
  SELECT l.*, a.name AS account_name, a.kind AS account_kind,
         c.name AS category_name, ap.reference AS appointment_reference
  FROM ledger_entries l
  JOIN cash_accounts a ON a.id = l.account_id
  LEFT JOIN expense_categories c ON c.id = l.category_id
  LEFT JOIN appointments ap ON ap.id = l.appointment_id
`

export async function listEntries({
  accountId = null,
  kind = null,
  categoryId = null,
  from = null,
  to = null,
  search = null,
  limit = 50,
  offset = 0,
} = {}) {
  const conditions = []
  const params = []

  if (accountId) {
    conditions.push('l.account_id = ?')
    params.push(accountId)
  }
  if (kind) {
    conditions.push('l.kind = ?')
    params.push(kind)
  }
  if (categoryId) {
    conditions.push('l.category_id = ?')
    params.push(categoryId)
  }
  if (from) {
    conditions.push('l.occurred_on >= ?')
    params.push(from)
  }
  if (to) {
    conditions.push('l.occurred_on <= ?')
    params.push(to)
  }
  if (search) {
    conditions.push('(l.label LIKE ? OR ap.reference LIKE ?)')
    params.push(`%${search}%`, `%${search}%`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const [{ total }] = await query(
    `SELECT COUNT(*) AS total FROM ledger_entries l
     LEFT JOIN appointments ap ON ap.id = l.appointment_id ${where}`,
    params,
  )

  const rows = await query(
    `${SELECT_ENTRIES} ${where}
     ORDER BY l.occurred_on DESC, l.id DESC
     LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  )

  return { total: Number(total), rows: rows.map(serializeEntry) }
}

export async function findEntry(id) {
  const row = await queryOne(`${SELECT_ENTRIES} WHERE l.id = ? LIMIT 1`, [id])
  return row ? serializeEntry(row) : null
}

export async function insertEntry(data, actor, connexion = null) {
  const exec = connexion
    ? (sql, params) => connexion.execute(sql, params).then(([r]) => r)
    : execute

  const result = await exec(
    `INSERT INTO ledger_entries
       (account_id, kind, direction, amount, currency, label, occurred_on,
        category_id, appointment_id, payment_id, transfer_ref,
        recorded_by, recorded_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.accountId,
      data.kind,
      data.direction,
      data.amount,
      data.currency ?? 'FCFA',
      data.label,
      data.occurredOn,
      data.categoryId ?? null,
      data.appointmentId ?? null,
      data.paymentId ?? null,
      data.transferRef ?? null,
      actor?.id ?? null,
      actor?.name ?? 'Système',
    ],
  )
  return result.insertId
}

export async function deleteEntry(id) {
  const result = await execute('DELETE FROM ledger_entries WHERE id = ?', [id])
  return result.affectedRows > 0
}

/** Les deux moitiés d'un transfert s'annulent ensemble. */
export async function deleteTransfer(ref) {
  const result = await execute('DELETE FROM ledger_entries WHERE transfer_ref = ?', [ref])
  return result.affectedRows
}

/**
 * L'encaissement d'un versement entre en caisse.
 *
 * Appelé par le module « operations » au moment où la cliente paie. Rien
 * n'est saisi deux fois : l'index unique sur `payment_id` garantit qu'un
 * versement ne peut entrer qu'une fois, même si l'appel était rejoué.
 */
export async function recordPayment({ payment, appointment }, actor) {
  const caisse = await cashAccount()
  if (!caisse) return null

  try {
    return await insertEntry(
      {
        accountId: caisse.id,
        kind: 'payment',
        direction: 'in',
        amount: payment.amount,
        currency: appointment.currency,
        label: `Encaissement ${appointment.reference} — ${appointment.first_name} ${appointment.last_name}`,
        occurredOn: new Date().toISOString().slice(0, 10),
        appointmentId: appointment.id,
        paymentId: payment.id,
      },
      actor,
    )
  } catch (error) {
    // Déjà entré en caisse : rien à faire, et surtout rien à signaler.
    if (error.code === 'ER_DUP_ENTRY') return null
    throw error
  }
}

/**
 * Un versement peut-il être retiré de la caisse sans la faire passer sous
 * zéro ?
 *
 * Le cas se présente pour de bon : une recette est saisie, la journée passe,
 * de l'argent en sort — puis on s'aperçoit que le versement était erroné.
 * Le retirer laisserait une caisse négative, c'est-à-dire un compte qui
 * affirme contenir moins que rien.
 *
 * On refuse, et on dit quoi faire : retirer d'abord les dépenses payées avec
 * cet argent. C'est la marche à suivre comptable, et elle laisse une trace
 * juste — contrairement à un solde négatif que plus personne ne sait
 * expliquer trois semaines plus tard.
 */
export async function paymentEntryRemovable(paymentId) {
  const ecriture = await queryOne(
    'SELECT account_id, amount FROM ledger_entries WHERE payment_id = ? LIMIT 1',
    [paymentId],
  )
  if (!ecriture) return { ok: true }

  const compte = await findAccount(ecriture.account_id)
  const apres = num(compte?.balance) - num(ecriture.amount)

  if (apres < 0) {
    return {
      ok: false,
      account: compte?.name ?? 'Le compte',
      balance: num(compte?.balance),
      amount: num(ecriture.amount),
      shortfall: Math.abs(apres),
    }
  }
  return { ok: true }
}

/** Annuler un versement retire aussi son écriture de caisse. */
export async function removePaymentEntry(paymentId) {
  await execute('DELETE FROM ledger_entries WHERE payment_id = ?', [paymentId])
}

/* ─────────────────────────────── Synthèse ───────────────────────────────── */

/**
 * Le tableau de la page Comptabilité : soldes par compte, entrées et sorties
 * de la période, et répartition des dépenses par catégorie.
 */
export async function summary({ from = null, to = null } = {}) {
  const bornes = []
  const params = []
  if (from) {
    bornes.push('occurred_on >= ?')
    params.push(from)
  }
  if (to) {
    bornes.push('occurred_on <= ?')
    params.push(to)
  }
  const where = bornes.length ? `WHERE ${bornes.join(' AND ')}` : ''

  const [totaux] = await query(
    `SELECT
       COALESCE(SUM(IF(kind = 'payment', amount, 0)), 0) AS encaisse,
       COALESCE(SUM(IF(kind = 'expense', amount, 0)), 0) AS depense,
       COALESCE(SUM(IF(kind = 'transfer' AND direction = 'out', amount, 0)), 0) AS transfere,
       COUNT(*) AS ecritures
     FROM ledger_entries ${where}`,
    params,
  )

  const parCategorie = await query(
    `SELECT COALESCE(c.name, 'Sans catégorie') AS name,
            COALESCE(SUM(l.amount), 0) AS total,
            COUNT(*) AS nombre
     FROM ledger_entries l
     LEFT JOIN expense_categories c ON c.id = l.category_id
     ${where ? `${where} AND` : 'WHERE'} l.kind = 'expense'
     GROUP BY COALESCE(c.name, 'Sans catégorie')
     ORDER BY total DESC`,
    params,
  )

  const comptes = await listAccounts()
  const tresorerie = comptes.reduce((somme, compte) => somme + compte.balance, 0)

  return {
    accounts: comptes,
    /** Ce que le salon possède, tous comptes confondus. */
    treasury: tresorerie,
    period: {
      from,
      to,
      collected: num(totaux.encaisse),
      spent: num(totaux.depense),
      transferred: num(totaux.transfere),
      net: num(totaux.encaisse) - num(totaux.depense),
      entries: Number(totaux.ecritures) || 0,
    },
    byCategory: parCategorie.map((row) => ({
      name: row.name,
      total: num(row.total),
      count: Number(row.nombre),
    })),
  }
}
