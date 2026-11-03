import nodemailer from 'nodemailer'

import { config } from '../config/env.js'

let transporter = null

function getTransporter() {
  if (!config.mail.enabled) return null
  if (transporter) return transporter
  transporter = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.password } : undefined,
    // Un serveur SMTP qui ne répond pas ne doit pas bloquer indéfiniment.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  })
  return transporter
}

/**
 * Envoie un e-mail. Tant que MAIL_ENABLED=false, rien n'est envoyé :
 * le message est simplement journalisé. Aucun échec d'envoi ne doit
 * empêcher l'enregistrement d'un rendez-vous ou d'un message.
 */
export async function sendMail({ to, subject, text, html }) {
  // Adresse facultative : une cliente sans e-mail n'en reçoit simplement pas (jamais une erreur).
  if (!to || !String(to).trim()) return { delivered: false, reason: 'Aucune adresse e-mail.' }
  const mail = getTransporter()

  if (!mail) {
    console.info(`✉️  [e-mail désactivé] → ${to} · ${subject}`)
    return { delivered: false, reason: 'disabled' }
  }

  try {
    const info = await mail.sendMail({ from: config.mail.from, to, subject, text, html })
    // Le serveur peut accepter la connexion mais refuser le destinataire : ce n'est pas une livraison.
    if (Array.isArray(info?.rejected) && info.rejected.length) {
      console.error(`✉️  Destinataire refusé par le serveur : ${info.rejected.join(', ')} — ${info.response ?? ''}`)
      return { delivered: false, reason: `Destinataire refusé par le serveur e-mail (${String(info.response ?? '').slice(0, 120)}).` }
    }
    return { delivered: true }
  } catch (error) {
    console.error(`✉️  Échec d'envoi vers ${to} :`, error.message)
    return { delivered: false, reason: error.message }
  }
}

const formatDate = (isoDate) => {
  const [year, month, day] = String(isoDate).split('-')
  return `${day}/${month}/${year}`
}

const formatPrice = (price, currency = 'FCFA') =>
  `${new Intl.NumberFormat('fr-FR').format(Number(price))} ${currency}`

/**
 * ⚠️ N'est plus envoyé : depuis que le rendez-vous est une demande soumise au
 * salon, la cliente n'est prévenue qu'après la décision de l'administrateur.
 * La fonction est conservée telle quelle — elle redeviendrait juste si vous
 * décidiez un jour d'accuser réception des demandes.
 */
export function appointmentCreatedToCustomer(appointment) {
  const subject = `Votre demande de rendez-vous ${appointment.reference} — Beauté Halal`
  const lines = [
    `Bonjour ${appointment.first_name},`,
    '',
    'Nous avons bien reçu votre demande de rendez-vous.',
    '',
    `Prestation : ${appointment.service_name}`,
    `Date : ${formatDate(appointment.appointment_date)} à ${appointment.appointment_time.slice(0, 5)}`,
    `Durée estimée : ${appointment.duration_minutes} minutes`,
    `${appointment.source === 'site-v3' ? 'Prix convenu' : 'Prix indicatif'} : ${formatPrice(appointment.price, appointment.currency)}`,
    `Référence : ${appointment.reference}`,
    '',
    'Le salon vous recontacte rapidement pour confirmer définitivement ce créneau.',
    '',
    'À très bientôt,',
    'Beauté Halal',
  ]
  return { to: appointment.email, subject, text: lines.join('\n') }
}

/** Notification interne au salon. */
export function appointmentCreatedToSalon(appointment) {
  const subject = `Nouveau rendez-vous ${appointment.reference} — ${appointment.service_name}`
  const lines = [
    'Nouvelle demande de rendez-vous.',
    '',
    `Référence : ${appointment.reference}`,
    `Prestation : ${appointment.service_name}`,
    `Date : ${formatDate(appointment.appointment_date)} à ${appointment.appointment_time.slice(0, 5)}`,
    `Cliente : ${appointment.first_name} ${appointment.last_name}`,
    `Téléphone : ${appointment.phone}`,
    `E-mail : ${appointment.email || 'non renseigné'}`,
    appointment.note ? `Commentaire : ${appointment.note}` : null,
  ].filter(Boolean)
  return { to: config.mail.adminRecipient, subject, text: lines.join('\n') }
}

/** Notification interne à la réception d'une demande de rendez-vous du site v3 (sans créneau). */
export function bookingRequestToSalon(request) {
  const subject = `Nouvelle demande ${request.reference} — ${request.first_name} ${request.last_name}`
  return { to: config.mail.adminRecipient, subject, text: request.message }
}

/** Notification interne à la réception d'un message de contact. */
export function contactMessageToSalon(message) {
  const subject = `Nouveau message de ${message.name} — site Beauté Halal`
  const lines = [
    `De : ${message.name} <${message.email}>`,
    message.phone ? `Téléphone : ${message.phone}` : null,
    '',
    message.message,
  ].filter(Boolean)
  return { to: config.mail.adminRecipient, subject, text: lines.join('\n') }
}

const dureeLisible = (minutes) => {
  const m = Number(minutes)
  if (!Number.isFinite(m) || m <= 0) return null
  if (m < 60) return `${m} minutes`
  const h = Math.floor(m / 60)
  const reste = m % 60
  return reste ? `${h} h ${String(reste).padStart(2, '0')}` : `${h} h`
}

/** Pied commun : contact WhatsApp (numéro principal du salon) puis « bon à savoir » réglé dans le dashboard. */
function piedDeMail(contexte = {}, { imprevu = false } = {}) {
  const lignes = []
  if (contexte.whatsapp) {
    lignes.push(
      imprevu
        ? `Un imprévu ? Écrivez-nous sur WhatsApp au ${contexte.whatsapp} : nous trouverons un autre créneau.`
        : `Une question ? Écrivez-nous sur WhatsApp au ${contexte.whatsapp}.`,
      '',
    )
  } else if (imprevu) {
    lignes.push('Si un imprévu survient, prévenez-nous : nous trouverons un autre créneau.', '')
  }
  if (Array.isArray(contexte.regles) && contexte.regles.length) {
    lignes.push(`${contexte.reglesTitre || 'Bon à savoir'} :`, ...contexte.regles.map((l) => `- ${l}`), '')
  }
  return lignes
}

/** « 3 novembre 2026 » → utilisé pour la prestation souhaitée après une consultation. */
const jourLisible = (iso) => (iso ? formatDate(iso) : '')

/**
 * Information envoyée à la cliente quand le salon statue sur son rendez-vous.
 *
 * `contexte` (facultatif, voir messaging/notifications.js › contexteEmail) rattache l'e-mail au parcours actuel :
 *  – consultation capillaire (frais de 5 000 FCFA réglés en ligne) ou installation de locks (prix convenu, acompte) ;
 *  – prestation souhaitée APRÈS la consultation (un autre jour) ;
 *  – numéro WhatsApp principal du salon et « bon à savoir » (réglés dans le dashboard).
 * Sans contexte, le texte reste valable (rendez-vous pris sur place, anciens appels).
 */
export function appointmentStatusToCustomer(appointment, contexte = {}) {
  // Demande du site pas encore planifiée : l'heure n'est qu'un repère technique, on ne l'annonce pas.
  const sansHeure =
    appointment.source === 'site-v3' && String(appointment.appointment_time) < '06:00:00'
  const quand = sansHeure
    ? formatDate(appointment.appointment_date)
    : `${formatDate(appointment.appointment_date)} à ${appointment.appointment_time.slice(0, 5)}`
  const consultation = Boolean(contexte.consultation) || /^consultation/i.test(String(appointment.service_name ?? ''))

  if (appointment.status === 'confirmed') {
    const lignes = [`Bonjour ${appointment.first_name},`, '']
    if (consultation) {
      lignes.push(`C'est confirmé : nous vous attendons le ${quand} pour votre consultation capillaire.`, '')
      lignes.push('Prestation : Consultation capillaire')
      const duree = dureeLisible(appointment.duration_minutes)
      if (duree) lignes.push(`Durée estimée : ${duree}`)
      if (Number(appointment.price) > 0) lignes.push(`Frais de consultation : ${formatPrice(appointment.price, appointment.currency)}${contexte.paye ? ' (réglés en ligne)' : ''}`)
      if (contexte.serviceDate) {
        lignes.push(
          '',
          `Prestation souhaitée ensuite : le ${jourLisible(contexte.serviceDate)}${contexte.serviceTime ? ` à ${contexte.serviceTime}` : ''}.`,
          'Ce jour est différent de celui de la consultation ; le salon vous contacte pour le confirmer.',
        )
      }
    } else {
      lignes.push(`C'est confirmé : nous vous attendons le ${quand}.`, '')
      lignes.push(`Prestation : ${appointment.service_name}`)
      const duree = dureeLisible(appointment.duration_minutes)
      if (duree) lignes.push(`Durée prévue : ${duree}`)
      lignes.push(`${appointment.source === 'site-v3' ? 'Prix convenu' : 'Prix indicatif'} : ${formatPrice(appointment.price, appointment.currency)}`)
      if (contexte.paye) lignes.push(`Acompte déjà réglé en ligne : ${formatPrice(contexte.paye, appointment.currency)}`)
    }
    lignes.push(`Référence : ${appointment.reference}`, '', ...piedDeMail(contexte, { imprevu: true }), 'À très bientôt,', 'Beauté Halal')
    return {
      to: appointment.email,
      subject: consultation
        ? `Votre consultation capillaire du ${quand} est confirmée — Beauté Halal`
        : `Votre rendez-vous du ${quand} est confirmé — Beauté Halal`,
      text: lignes.join('\n'),
    }
  }

  if (appointment.status === 'rejected') {
    return {
      to: appointment.email,
      subject: `Votre demande de rendez-vous du ${quand} — Beauté Halal`,
      text: [
        `Bonjour ${appointment.first_name},`,
        '',
        `Nous ne pouvons malheureusement pas vous recevoir le ${quand}.`,
        appointment.cancel_reason ? `Motif : ${appointment.cancel_reason}` : null,
        '',
        contexte.whatsapp
          ? `Votre demande n’est pas perdue de vue : proposez-nous un autre jour sur le site, ou écrivez-nous sur WhatsApp au ${contexte.whatsapp} et nous chercherons ensemble.`
          : 'Votre demande n’est pas perdue de vue : proposez-nous un autre jour sur le site et nous chercherons ensemble.',
        '',
        `Référence de la demande : ${appointment.reference}`,
        '',
        'Beauté Halal',
      ]
        .filter((line) => line !== null)
        .join('\n'),
    }
  }

  // Les autres statuts — annulé, terminé, non honoré — gardent le texte
  // d'origine : ce sont des suites de rendez-vous, pas des décisions de demande.
  const labels = {
    cancelled: 'annulé',
    completed: 'terminé',
    no_show: 'noté comme non honoré',
    // Étapes internes du salon : elles ne devraient jamais déclencher
    // d'e-mail, mais un libellé lisible vaut mieux qu'un mot technique
    // si l'une d'elles passait un jour par ici.
    arrived: 'en cours de prise en charge',
    in_progress: 'en cours',
  }
  const label = labels[appointment.status] || appointment.status
  const quoi = consultation ? 'Votre consultation capillaire' : 'Votre rendez-vous'
  return {
    to: appointment.email,
    subject: `${quoi} ${appointment.reference} est ${label} — Beauté Halal`,
    text: [
      `Bonjour ${appointment.first_name},`,
      '',
      `${quoi} du ${quand} est ${label}.`,
      appointment.cancel_reason ? `Motif : ${appointment.cancel_reason}` : null,
      contexte.whatsapp && appointment.status === 'cancelled' ? `Pour en fixer un autre, écrivez-nous sur WhatsApp au ${contexte.whatsapp}.` : null,
      '',
      `Référence : ${appointment.reference}`,
      '',
      'Beauté Halal',
    ]
      .filter((line) => line !== null)
      .join('\n'),
  }
}


/**
 * Remerciement envoyé une fois la prestation terminée.
 *
 * Il part au passage au statut « Terminé », et une seule fois : la colonne
 * `thanked_at` du rendez-vous s'en assure. Repasser par « Terminé » après
 * coup ne renverra rien — personne n'aime être remercié trois fois pour la
 * même visite.
 *
 * Le ton reste celui de la maison : sobre, chaleureux, sans relance
 * commerciale. On invite à donner son avis, on ne le réclame pas.
 */
export function appointmentThanksToCustomer(appointment, contexte = {}) {
  const quand = formatDate(appointment.appointment_date)
  const consultation = Boolean(contexte.consultation) || /^consultation/i.test(String(appointment.service_name ?? ''))
  const contact = contexte.whatsapp
    ? `il suffit de nous écrire sur WhatsApp au ${contexte.whatsapp}.`
    : 'il suffit de répondre à ce message.'

  return {
    to: appointment.email,
    subject: consultation ? 'Merci pour votre consultation — Beauté Halal' : 'Merci pour votre visite — Beauté Halal',
    text: [
      `Bonjour ${appointment.first_name},`,
      '',
      consultation
        ? 'Nous vous remercions pour votre confiance et pour votre consultation capillaire chez Beauté Halal.'
        : 'Nous vous remercions pour votre confiance et votre visite chez Beauté Halal.',
      consultation
        ? 'Nous espérons que nos conseils vous aident à choisir vos locks.'
        : 'Nous espérons que votre expérience vous a donné entière satisfaction.',
      '',
      `Prestation : ${appointment.service_name}`,
      `Date : ${quand}`,
      appointment.staff_name ? `Coiffeuse : ${appointment.staff_name}` : null,
      `Référence : ${appointment.reference}`,
      consultation && contexte.serviceDate ? `Prestation souhaitée : le ${jourLisible(contexte.serviceDate)}${contexte.serviceTime ? ` à ${contexte.serviceTime}` : ''} (le salon vous contacte pour la confirmer).` : null,
      consultation && !contexte.serviceDate ? `Pour prendre rendez-vous pour votre installation, réservez sur le site ou écrivez-nous${contexte.whatsapp ? ` sur WhatsApp au ${contexte.whatsapp}` : ''}.` : null,
      '',
      `Votre avis nous intéresse : dites-nous ce qui vous a plu, et ce que nous pourrions faire mieux — ${contact}`,
      '',
      'Merci et à bientôt,',
      'Beauté Halal',
    ]
      .filter((line) => line !== null)
      .join('\n'),
  }
}
