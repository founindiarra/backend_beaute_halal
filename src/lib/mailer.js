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
  })
  return transporter
}

/**
 * Envoie un e-mail. Tant que MAIL_ENABLED=false, rien n'est envoyé :
 * le message est simplement journalisé. Aucun échec d'envoi ne doit
 * empêcher l'enregistrement d'un rendez-vous ou d'un message.
 */
export async function sendMail({ to, subject, text, html }) {
  const mail = getTransporter()

  if (!mail) {
    console.info(`✉️  [e-mail désactivé] → ${to} · ${subject}`)
    return { delivered: false, reason: 'disabled' }
  }

  try {
    await mail.sendMail({ from: config.mail.from, to, subject, text, html })
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
    `Prix indicatif : ${formatPrice(appointment.price, appointment.currency)}`,
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
    `E-mail : ${appointment.email}`,
    appointment.note ? `Commentaire : ${appointment.note}` : null,
  ].filter(Boolean)
  return { to: config.mail.adminRecipient, subject, text: lines.join('\n') }
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

/**
 * Information envoyée à la cliente quand le salon statue sur son rendez-vous.
 *
 * C'est le SEUL courriel qu'elle reçoit sur sa demande : rien ne part à la
 * création, la décision du salon fait foi.
 *
 * Deux issues ont leur propre texte, parce qu'elles ne disent pas la même
 * chose. « Confirmé » attend la cliente à une date précise. « Refusé » ferme
 * cette demande-là sans fermer la porte : on l'invite à en proposer une autre,
 * et le motif, quand il est renseigné, lui évite de se demander pourquoi.
 */
export function appointmentStatusToCustomer(appointment) {
  const quand = `${formatDate(appointment.appointment_date)} à ${appointment.appointment_time.slice(0, 5)}`

  if (appointment.status === 'confirmed') {
    return {
      to: appointment.email,
      subject: `Votre rendez-vous du ${quand} est confirmé — Beauté Halal`,
      text: [
        `Bonjour ${appointment.first_name},`,
        '',
        `C'est confirmé : nous vous attendons le ${quand}.`,
        '',
        `Prestation : ${appointment.service_name}`,
        `Durée estimée : ${appointment.duration_minutes} minutes`,
        `Prix indicatif : ${formatPrice(appointment.price, appointment.currency)}`,
        `Référence : ${appointment.reference}`,
        '',
        'Si un imprévu survient, prévenez-nous : nous trouverons un autre créneau.',
        '',
        'À très bientôt,',
        'Beauté Halal',
      ].join('\n'),
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
        'Votre demande n’est pas perdue de vue : proposez-nous un autre créneau',
        'sur le site, ou répondez à ce message et nous chercherons ensemble.',
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
  return {
    to: appointment.email,
    subject: `Votre rendez-vous ${appointment.reference} est ${label} — Beauté Halal`,
    text: [
      `Bonjour ${appointment.first_name},`,
      '',
      `Votre rendez-vous du ${quand} est ${label}.`,
      appointment.cancel_reason ? `Motif : ${appointment.cancel_reason}` : null,
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
export function appointmentThanksToCustomer(appointment) {
  const quand = formatDate(appointment.appointment_date)

  return {
    to: appointment.email,
    subject: 'Merci pour votre visite — Beauté Halal',
    text: [
      `Bonjour ${appointment.first_name},`,
      '',
      'Nous vous remercions pour votre confiance et votre visite chez Beauté Halal.',
      'Nous espérons que votre expérience vous a donné entière satisfaction.',
      '',
      `Prestation : ${appointment.service_name}`,
      `Date : ${quand}`,
      appointment.staff_name ? `Coiffeuse : ${appointment.staff_name}` : null,
      `Référence : ${appointment.reference}`,
      '',
      'Votre avis nous intéresse : dites-nous ce qui vous a plu, et ce que',
      'nous pourrions faire mieux. Il suffit de répondre à ce message.',
      '',
      'Merci et à bientôt,',
      'Beauté Halal',
    ]
      .filter((line) => line !== null)
      .join('\n'),
  }
}
