import { execute, query, queryOne } from '../../config/database.js'
import { envoyerSms, remplirModele } from '../../lib/sms.js'
import { sendMail } from '../../lib/mailer.js'

/**
 * Messagerie : ce que le salon envoie à ses clientes, et ce qu'il en reste.
 *
 * Tout passe par ici — SMS et e-mails, unitaires ou groupés. Chaque envoi
 * laisse une ligne au journal AVANT de partir, jamais après : si le
 * fournisseur ne répond pas, on saura quand même qu'un envoi a été tenté et
 * ce qu'il contenait. Un journal écrit seulement en cas de succès ne sert à
 * rien le jour où il faut comprendre un échec.
 */

export const KINDS = {
  manual: 'Message manuel',
  campaign: 'Envoi groupé',
  birthday: 'Anniversaire',
  thanks: 'Remerciement',
  appointment: 'Rendez-vous',
  reminder: 'Rappel',
  test: 'Essai',
}

export const serializeMessage = (row) => ({
  id: row.id,
  channel: row.channel,
  kind: row.kind,
  kindLabel: KINDS[row.kind] ?? row.kind,
  customer: row.customer_id
    ? { id: row.customer_id, name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() }
    : null,
  recipient: row.recipient,
  subject: row.subject,
  body: row.body,
  status: row.status,
  error: row.error,
  providerReference: row.provider_reference,
  campaignRef: row.campaign_ref,
  sentByName: row.sent_by_name,
  createdAt: row.created_at,
  sentAt: row.sent_at,
})

const SELECT = `
  SELECT m.*, c.first_name, c.last_name
  FROM message_logs m
  LEFT JOIN customers c ON c.id = m.customer_id
`

/** Inscrit l'intention d'envoi. Renvoie l'identifiant de la ligne. */
async function ouvrirJournal({
  channel,
  kind,
  customerId = null,
  appointmentId = null,
  recipient,
  subject = null,
  body,
  campaignRef = null,
}, actor) {
  const result = await execute(
    `INSERT INTO message_logs
       (channel, kind, customer_id, appointment_id, recipient, subject, body,
        campaign_ref, sent_by, sent_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      channel,
      kind,
      customerId,
      appointmentId,
      recipient,
      subject,
      body,
      campaignRef,
      actor?.id ?? null,
      actor?.name ?? 'Système',
    ],
  )
  return result.insertId
}

async function cloreJournal(id, resultat) {
  await execute(
    `UPDATE message_logs
     SET status = ?, provider_reference = ?, provider_response = ?, error = ?,
         sent_at = IF(? = 'sent', NOW(), sent_at)
     WHERE id = ?`,
    [
      resultat.status,
      resultat.reference ?? null,
      resultat.response ?? null,
      resultat.error ?? null,
      resultat.status,
      id,
    ],
  )
}

/**
 * Envoie un message et le consigne.
 *
 * Ne lève jamais. Un envoi raté est une ligne « échec » au journal, pas une
 * opération interrompue : le salon a terminé une prestation, encaissé ou
 * souhaité un anniversaire — cela ne doit pas dépendre d'un fournisseur.
 */
export async function envoyer(
  { channel = 'sms', kind = 'manual', customer = null, appointmentId = null, recipient, subject, body, campaignRef = null },
  actor,
) {
  const destinataire = recipient ?? (channel === 'sms' ? customer?.phone : customer?.email)

  if (!destinataire) {
    const id = await ouvrirJournal(
      { channel, kind, customerId: customer?.id ?? null, appointmentId, recipient: '—', subject, body, campaignRef },
      actor,
    )
    const resultat = {
      status: 'skipped',
      error: channel === 'sms' ? 'Aucun numéro de téléphone.' : 'Aucune adresse e-mail.',
    }
    await cloreJournal(id, resultat)
    return { id, ...resultat }
  }

  /* Une cliente qui a refusé les messages n'en reçoit pas — et on le dit. */
  const refus =
    (channel === 'sms' && customer && customer.smsOptIn === false) ||
    (channel === 'email' && customer && customer.emailOptIn === false)

  const id = await ouvrirJournal(
    { channel, kind, customerId: customer?.id ?? null, appointmentId, recipient: destinataire, subject, body, campaignRef },
    actor,
  )

  if (refus) {
    const resultat = { status: 'skipped', error: 'Cette cliente a refusé de recevoir des messages.' }
    await cloreJournal(id, resultat)
    return { id, ...resultat }
  }

  const resultat =
    channel === 'sms'
      ? await envoyerSms({ to: destinataire, message: body })
      : await envoyerCourriel({ to: destinataire, subject, text: body })

  await cloreJournal(id, resultat)
  return { id, ...resultat }
}

async function envoyerCourriel({ to, subject, text }) {
  const issue = await sendMail({ to, subject: subject || 'Beauté Halal', text })
  if (issue?.delivered) return { status: 'sent' }
  if (issue?.reason === 'disabled') {
    return { status: 'skipped', error: 'L’envoi d’e-mails est désactivé (MAIL_ENABLED).' }
  }
  return { status: 'failed', error: issue?.reason ?? 'Envoi impossible.' }
}

/* ────────────────────────────── Consultation ────────────────────────────── */

export async function listMessages({
  channel = null,
  status = null,
  kind = null,
  search = null,
  from = null,
  to = null,
  limit = 50,
  offset = 0,
} = {}) {
  const conditions = []
  const params = []

  if (channel) {
    conditions.push('m.channel = ?')
    params.push(channel)
  }
  if (status) {
    conditions.push('m.status = ?')
    params.push(status)
  }
  if (kind) {
    conditions.push('m.kind = ?')
    params.push(kind)
  }
  if (from) {
    conditions.push('DATE(m.created_at) >= ?')
    params.push(from)
  }
  if (to) {
    conditions.push('DATE(m.created_at) <= ?')
    params.push(to)
  }
  if (search) {
    conditions.push('(m.recipient LIKE ? OR m.body LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ?)')
    const like = `%${search}%`
    params.push(like, like, like, like)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const [{ total }] = await query(
    `SELECT COUNT(*) AS total FROM message_logs m
     LEFT JOIN customers c ON c.id = m.customer_id ${where}`,
    params,
  )

  const rows = await query(
    `${SELECT} ${where} ORDER BY m.created_at DESC, m.id DESC
     LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  )

  return { total: Number(total), rows: rows.map(serializeMessage) }
}

export async function findMessage(id) {
  const row = await queryOne(`${SELECT} WHERE m.id = ? LIMIT 1`, [id])
  return row ? serializeMessage(row) : null
}

/**
 * Les rendez-vous d'une journée, et l'état de leur rappel.
 *
 * L'idempotence ne vient PAS d'une colonne `reminded_at` : elle vient du
 * journal lui-même. Un rappel déjà parti pour ce rendez-vous y a laissé une
 * ligne `kind = 'reminder'` en statut « envoyé » ; il suffit de la chercher.
 *
 * C'est volontaire. Une colonne de plus aurait voulu dire une migration de
 * plus à lancer à la main sur le serveur, alors que `message_logs` porte
 * déjà `appointment_id` et sait exactement ce qui est parti. Une seule
 * source de vérité, et rien à déployer.
 */
export async function rendezVousARappeler(dateKey) {
  const rows = await query(
    `SELECT a.id, a.reference, a.customer_id, a.appointment_date, a.appointment_time,
            a.service_name, a.price, a.currency,
            a.first_name, a.last_name, a.phone, a.email,
            (SELECT m.id FROM message_logs m
              WHERE m.appointment_id = a.id
                AND m.kind = 'reminder'
                AND m.status = 'sent'
              LIMIT 1) AS rappel_envoye
     FROM appointments a
     WHERE a.appointment_date = ?
       AND a.status = 'confirmed'
     ORDER BY a.appointment_time, a.id`,
    [dateKey],
  )

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    customerId: row.customer_id,
    date: row.appointment_date,
    time: String(row.appointment_time ?? '').slice(0, 5),
    price: Number(row.price),
    currency: row.currency,
    service: { name: row.service_name },
    customer: {
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone,
      email: row.email,
    },
    fullName: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
    alreadyReminded: Boolean(row.rappel_envoye),
  }))
}

/** Compteurs de la page Messagerie. */
export async function messagingStats() {
  const [row] = await query(`
    SELECT
      COUNT(*) AS total,
      SUM(status = 'sent')    AS envoyes,
      SUM(status = 'failed')  AS echoues,
      SUM(status = 'skipped') AS ignores,
      SUM(channel = 'sms')    AS sms,
      SUM(channel = 'email')  AS emails,
      SUM(DATE(created_at) = CURDATE()) AS aujourdhui
    FROM message_logs
  `)
  return {
    total: Number(row.total) || 0,
    sent: Number(row.envoyes) || 0,
    failed: Number(row.echoues) || 0,
    skipped: Number(row.ignores) || 0,
    sms: Number(row.sms) || 0,
    emails: Number(row.emails) || 0,
    today: Number(row.aujourdhui) || 0,
  }
}

/* ────────────────────────────── Anniversaires ───────────────────────────── */

/**
 * Souhaite leur anniversaire aux clientes du jour.
 *
 * Idempotent : une cliente déjà souhaitée aujourd'hui ne l'est pas deux fois.
 * C'est ce qui permet d'appeler cette fonction sans crainte — à l'ouverture
 * du dashboard, par une tâche planifiée, ou à la main depuis l'écran.
 */
export async function souhaiterAnniversaires({ customers, modele, channel = 'sms' }, actor) {
  const resultats = []

  for (const cliente of customers) {
    const [{ deja }] = await query(
      `SELECT COUNT(*) AS deja FROM message_logs
       WHERE customer_id = ? AND kind = 'birthday' AND DATE(created_at) = CURDATE()`,
      [cliente.id],
    )
    if (Number(deja) > 0) {
      resultats.push({ customerId: cliente.id, status: 'skipped', error: 'Déjà souhaité aujourd’hui.' })
      continue
    }

    const corps = remplirModele(modele, {
      prenom: cliente.firstName,
      nom: cliente.lastName,
      salon: 'Beauté Halal',
    })

    const issue = await envoyer(
      { channel, kind: 'birthday', customer: cliente, body: corps, subject: 'Joyeux anniversaire' },
      actor,
    )
    resultats.push({ customerId: cliente.id, ...issue })
  }

  return resultats
}
