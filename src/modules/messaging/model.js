import { execute, query, queryOne } from '../../config/database.js'
import { envoyerSms, remplirModele, versGsm } from '../../lib/sms.js'
import { sendMail } from '../../lib/mailer.js'
import { envoyerWhatsapp, whatsappProvider } from '../../lib/whatsapp.js'
import { config } from '../../config/env.js'
import { normaliserTelephone } from '../../lib/phone.js'
import { findByPhone, serializeCustomer } from '../customers/model.js'

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

/** Même numéro, quelle que soit la façon de l'écrire (+225…, 0700…, espaces). */
export const memeNumero = (a, b) => {
  const x = normaliserTelephone(a)
  return x.length >= 8 && x === normaliserTelephone(b)
}

/** Messages promotionnels : les seuls qui respectent le refus d'une cliente. */
const MARKETING = new Set(['campaign', 'birthday'])
const OPT_IN = { sms: 'smsOptIn', email: 'emailOptIn', whatsapp: 'whatsappOptIn' }

/**
 * Peut-on écrire à ce destinataire, sur ce canal ?
 * Renvoie `{ autorise, motif?, customerId? }`. Ne lève jamais : un doute vaut refus.
 */
export async function verifierConsentement({ channel, kind, customer, destinataire }) {
  const refus = (motif, customerId = null) => ({ autorise: false, motif, customerId })

  // Essai : l'administratrice choisit le destinataire (aucune restriction de numéro).
  if (kind === 'test' && channel === 'email') return refus('Essai refusé : les essais d’e-mail ne sont pas pris en charge.')

  // Fiche : celle qu'on nous donne, sinon celle du numéro (ou de l'e-mail).
  let fiche = customer && typeof customer === 'object' && 'id' in customer && customer.id ? customer : null
  if (!fiche) {
    try {
      const ligne =
        channel === 'email'
          ? await queryOne('SELECT * FROM customers WHERE email = ? LIMIT 1', [String(destinataire).trim().toLowerCase()])
          : await findByPhone(destinataire)
      fiche = ligne ? serializeCustomer(ligne) : null
    } catch {
      return refus('Consentement non vérifiable (base de données illisible) : envoi refusé par précaution.')
    }
  }

  if (fiche) {
    // Seuls les messages promotionnels (campagnes, anniversaires) respectent un refus ; rendez-vous, paiements, chat et messages directs partent toujours.
    if (fiche[OPT_IN[channel]] === false && MARKETING.has(kind)) return refus('Cette cliente a refusé de recevoir des messages promotionnels.', fiche.id)
    return { autorise: true, customerId: fiche.id }
  }

  // Aucune fiche : seul l'essai vers le numéro configuré peut partir (déjà contrôlé plus haut).
  if (kind === 'test') return { autorise: true, customerId: null }
  // Message lié à SON rendez-vous (confirmation, paiement reçu, rappel…) : la cliente vient de réserver, elle l'attend. Sans fiche, on écrit quand même.
  if (!MARKETING.has(kind) && String(destinataire ?? '').replace(/[^0-9]/g, '').length >= 8) return { autorise: true, customerId: null }

  // Compatibilité : `customer` sans identifiant (coordonnées d'un rendez-vous) mais avec un choix explicite.
  if (customer && customer[OPT_IN[channel]] === false && MARKETING.has(kind)) return refus('Cette cliente a refusé de recevoir des messages promotionnels.')
  return refus('Consentement inconnu : aucune fiche cliente pour ce destinataire, envoi automatique refusé.')
}

/**
 * Envoie un message et le consigne.
 *
 * Ne lève jamais. Un envoi raté est une ligne « échec » au journal, pas une
 * opération interrompue : le salon a terminé une prestation, encaissé ou
 * souhaité un anniversaire — cela ne doit pas dépendre d'un fournisseur.
 */
/** Longueur maximale d'un SMS automatique envoyé à une cliente (espaces compris). */
export const SMS_MAX_AUTO = 155

export async function envoyer(
  { channel = 'sms', kind = 'manual', customer = null, appointmentId = null, recipient, subject, body, campaignRef = null, whatsapp = null },
  actor,
) {
  const destinataire = recipient ?? (channel === 'email' ? customer?.email : customer?.phone)
  // SMS : texte sans accents (un accent = SMS en Unicode = 2 à 3 SMS reçus pour un seul message).
  if (channel === 'sms') {
    body = versGsm(body)
    // Messages automatiques à la cliente : 155 caractères au plus (espaces compris), coupés proprement au dernier mot entier.
    if (kind === 'appointment' && body.length > SMS_MAX_AUTO) {
      const coupe = body.slice(0, SMS_MAX_AUTO)
      body = (coupe.includes(' ') && body[SMS_MAX_AUTO] !== ' ' ? coupe.slice(0, coupe.lastIndexOf(' ')) : coupe).trimEnd()
    }
  }

  if (!destinataire) {
    const id = await ouvrirJournal(
      { channel, kind, customerId: customer?.id ?? null, appointmentId, recipient: '—', subject, body, campaignRef },
      actor,
    )
    const resultat = {
      status: 'skipped',
      error: channel === 'email' ? 'Aucune adresse e-mail.' : 'Aucun numéro de téléphone.',
    }
    await cloreJournal(id, resultat)
    return { id, ...resultat }
  }

  /*
   * Consentement, vérifié AVANT chaque envoi, fiche fournie ou non :
   *  – fiche fournie ou retrouvée par le numéro (ou l'e-mail) → on applique son choix, canal par canal ;
   *  – aucune fiche, ou base illisible → consentement INCONNU → refus automatique ;
   *  – essai : seul le numéro de l'administratrice configuré côté serveur est admis (jamais celui du navigateur).
   * Pas d'exception générale : un envoi sans consentement vérifiable ne part pas.
   */
  const verdict = await verifierConsentement({ channel, kind, customer, destinataire })

  const id = await ouvrirJournal(
    {
      channel,
      kind,
      customerId: customer?.id ?? verdict.customerId ?? null,
      appointmentId,
      recipient: destinataire,
      subject,
      body,
      campaignRef,
    },
    actor,
  )

  if (!verdict.autorise) {
    const resultat = { status: 'skipped', error: verdict.motif }
    await cloreJournal(id, resultat)
    return { id, ...resultat }
  }

  let resultat
  if (channel === 'sms') {
    // Pas deux fois le même SMS vers la même personne en 10 minutes (événement rejoué, webhook + vérification…).
    const doublonSms = await messageIdentiqueRecent({ channel, recipient: destinataire, body, sauf: id })
    resultat = doublonSms
      ? { status: 'skipped', error: 'Doublon : le même SMS vient déjà de partir vers ce numéro.' }
      : await envoyerSms({ to: destinataire, message: body })
  } else if (channel === 'whatsapp') {
    if (whatsappProvider() === 'qr') {
      /* Service QR : le texte déjà rédigé part tel quel, sans modèle Meta. Pas deux fois le même à la même personne. */
      const doublon = await messageIdentiqueRecent({ channel, recipient: destinataire, body, sauf: id })
      resultat = doublon
        ? { status: 'skipped', error: 'Doublon : le même message vient déjà de partir vers ce numéro.' }
        : await envoyerWhatsapp({ to: destinataire, text: body, reference: `ml-${id}`, actor })
    } else if (whatsapp && !whatsapp.template) {
      /* Événement du parcours sans modèle approuvé : Meta refuserait un texte libre. */
      resultat = { status: 'skipped', error: 'Aucun modèle WhatsApp approuvé configuré pour cet événement.' }
    } else {
      resultat = await envoyerWhatsapp(
        whatsapp
          ? { to: destinataire, template: whatsapp.template, language: whatsapp.language, params: whatsapp.params }
          : { to: destinataire, text: body },
      )
    }
  } else resultat = await envoyerCourriel({ to: destinataire, subject, text: body })

  await cloreJournal(id, resultat)
  return { id, ...resultat }
}

/**
 * Anti-doublon : un événement retraité ou une tâche relancée ne doit pas écrire deux fois la même chose
 * à la même personne. On compare le destinataire (chiffres seuls) et le texte, sur les 10 dernières minutes,
 * parmi les messages déjà envoyés ou en cours d'envoi.
 */
export async function messageIdentiqueRecent({ channel, recipient, body, sauf = 0, minutes = 10 }) {
  const chiffres = String(recipient ?? '').replace(/[^0-9]/g, '').slice(-9)
  if (!chiffres) return false
  const ligne = await queryOne(
    `SELECT id FROM message_logs
      WHERE channel = ? AND id < ? AND body = ? AND status IN ('queued','sent')
        AND created_at >= (NOW() - INTERVAL ? MINUTE)
        AND REGEXP_REPLACE(recipient, '[^0-9]', '') LIKE ?
      LIMIT 1`,
    [channel, sauf, body, minutes, `%${chiffres}`],
  ).catch(() => null)
  return Boolean(ligne)
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
      SUM(channel = 'whatsapp') AS whatsapps,
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
    whatsapp: Number(row.whatsapps) || 0,
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
