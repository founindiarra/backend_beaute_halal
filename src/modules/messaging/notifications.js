import { envoyer } from './model.js'
import { queryOne } from '../../config/database.js'
import { config } from '../../config/env.js'
import { remplirModele } from '../../lib/sms.js'
import { findByPhone, serializeCustomer } from '../customers/model.js'
import { getSettings } from '../salon/model.js'
import { getCatalogue } from '../tarifs/catalogue.js'
import { construireRecapPaiement } from './recap-paiement.js'
import { sendMail, appointmentStatusToCustomer, appointmentThanksToCustomer } from '../../lib/mailer.js'

/**
 * Ce que le salon dit à ses clientes, et quand.
 *
 * Jusqu'ici la passerelle SMS existait mais ne servait qu'aux envois décidés
 * à la main. Les moments qui comptent vraiment — « votre rendez-vous est
 * confirmé », « c'est demain », « merci de votre visite » — partaient
 * uniquement par e-mail. À Abidjan, une adresse e-mail se consulte peu ; un
 * SMS se lit. Ce fichier est le point unique où un événement du parcours
 * devient un message.
 *
 * Quatre règles le gouvernent.
 *
 *  1. UN ÉVÉNEMENT, UN MODÈLE, UN CANAL. Le salon choisit, pour chacun, s'il
 *     l'envoie, par quel canal et avec quels mots. Les valeurs par défaut
 *     ci-dessous fonctionnent telles quelles : rien à régler pour démarrer.
 *
 *  2. RIEN NE BLOQUE LE PARCOURS. Un SMS qui échoue ne doit jamais empêcher
 *     de confirmer un rendez-vous. Toute erreur est avalée et consignée ;
 *     l'appelant n'a pas à s'en soucier et n'a pas à attendre.
 *
 *  3. TOUT PASSE PAR LE JOURNAL. `envoyer()` écrit dans `message_logs` avant
 *     de tenter l'envoi. Un message parti, refusé ou échoué se retrouve donc
 *     dans la page Messagerie, avec la réponse du fournisseur.
 *
 *  4. LE REFUS DE LA CLIENTE PRIME. `envoyer()` vérifie `smsOptIn` et
 *     `emailOptIn` : une cliente qui a dit non passe en « ignorée » plutôt
 *     que de recevoir le message quand même.
 */

/* ─────────────────────────── Modèles par défaut ─────────────────────────── */

/**
 * Volontairement courts : un SMS se facture au segment, et 160 caractères
 * suffisent à dire l'essentiel. Les modèles évitent aussi les caractères
 * hors alphabet GSM (apostrophe courbe, majuscules accentuées) qui feraient
 * basculer le message en Unicode et doubleraient son coût — voir
 * `segmentsSms()` dans lib/sms.js.
 */
export const EVENEMENTS = {
  confirmed: {
    label: 'Rendez-vous confirmé',
    kind: 'appointment',
    defaut: {
      enabled: true,
      channel: 'sms',
      template:
        'Bonjour {prenom}, votre rendez-vous chez {salon} est confirme pour le {date} a {heure} ({prestation}). Reference {reference}. A bientot !',
      subject: 'Votre rendez-vous est confirmé',
    },
  },
  rejected: {
    label: 'Demande refusée',
    kind: 'appointment',
    defaut: {
      enabled: true,
      channel: 'sms',
      template:
        'Bonjour {prenom}, nous ne pouvons malheureusement pas retenir votre demande du {date} a {heure}. Ecrivez-nous sur WhatsApp au {whatsapp} pour convenir d un autre creneau. {salon}',
      subject: 'Votre demande de rendez-vous',
    },
  },
  cancelled: {
    label: 'Rendez-vous annulé',
    kind: 'appointment',
    defaut: {
      enabled: true,
      channel: 'sms',
      template:
        'Bonjour {prenom}, votre rendez-vous du {date} a {heure} a ete annule. Ecrivez-nous sur WhatsApp au {whatsapp} pour en fixer un autre. {salon}',
      subject: 'Votre rendez-vous a été annulé',
    },
  },
  reminder: {
    label: 'Rappel la veille',
    kind: 'reminder',
    defaut: {
      enabled: true,
      channel: 'sms',
      template:
        'Bonjour {prenom}, petit rappel : votre rendez-vous chez {salon} est demain {date} a {heure} ({prestation}). A demain !',
      subject: 'Votre rendez-vous de demain',
    },
  },
  thanks: {
    label: 'Remerciement après la prestation',
    kind: 'thanks',
    defaut: {
      enabled: true,
      channel: 'sms',
      template:
        'Merci {prenom} pour votre visite chez {salon}. Au plaisir de vous revoir bientot !',
      subject: 'Merci de votre visite',
    },
  },
}

/**
 * Messages liés aux DEMANDES de rendez-vous du site (avant tout créneau).
 * Même mécanique que les événements ci-dessus ; WhatsApp par défaut, car la
 * cliente vient de laisser son numéro. Sans modèle WhatsApp approuvé, l'envoi
 * est « ignoré » et journalisé.
 */
EVENEMENTS.request_received = {
  label: 'Demande reçue',
  kind: 'appointment',
  defaut: {
    enabled: true,
    channel: 'whatsapp',
    template: 'Bonjour {prenom}, nous avons bien recu votre demande {reference} pour le {date} a {heure}. Le salon la confirme tres vite. {salon}',
    subject: 'Votre demande est bien reçue',
  },
}
EVENEMENTS.request_contacted = {
  label: 'Demande prise en charge',
  kind: 'appointment',
  defaut: {
    enabled: false,
    channel: 'whatsapp',
    template: 'Bonjour {prenom}, le salon a pris en charge votre demande {reference} et va vous contacter. {salon}',
    subject: 'Votre demande est prise en charge',
  },
}
EVENEMENTS.request_confirmed = {
  label: 'Demande confirmée',
  kind: 'appointment',
  defaut: {
    enabled: true,
    channel: 'whatsapp',
    template: 'Bonjour {prenom}, votre rendez-vous chez {salon} est confirmé pour le {date} à {heure}. Comme convenu avec vous, le tarif de votre coiffure est de {prix}. Référence de votre dossier : {reference}. Nous vous attendons avec plaisir !',
    subject: 'Votre rendez-vous est confirmé',
  },
}
EVENEMENTS.request_rejected = {
  label: 'Demande déclinée',
  kind: 'appointment',
  defaut: {
    enabled: true,
    channel: 'whatsapp',
    template: 'Bonjour {prenom}, nous ne pouvons pas retenir votre demande {reference}. Ecrivez-nous sur WhatsApp au {whatsapp} pour convenir d un autre moment. {salon}',
    subject: 'Votre demande de rendez-vous',
  },
}

EVENEMENTS.request_cancelled = {
  label: 'Demande annulée',
  kind: 'appointment',
  defaut: {
    enabled: true,
    channel: 'whatsapp',
    template: 'Bonjour {prenom}, votre demande {reference} est annulee. Ecrivez-nous sur WhatsApp au {whatsapp} pour convenir d un autre moment. {salon}',
    subject: 'Votre demande de rendez-vous est annulée',
  },
}

EVENEMENTS.request_paid = {
  label: 'Paiement reçu, rendez-vous validé',
  kind: 'appointment',
  defaut: {
    enabled: true,
    channel: 'sms',
    template: 'Bonjour {prenom}, paiement de {paye} bien recu pour votre demande {reference} chez {salon}. Nous vous contactons pour confirmer votre rendez-vous.',
    subject: 'Paiement reçu — nous revenons vers vous',
  },
}
/** Paiement de consultation confirmé par Jèko ET créneau libre : le rendez-vous est confirmé automatiquement. */
EVENEMENTS.payment_confirmed = {
  label: 'Rendez-vous confirmé après paiement',
  kind: 'appointment',
  defaut: {
    enabled: true,
    channel: 'sms',
    template: 'Beaute Halal : paiement de {paye} recu. Rendez-vous {reference} CONFIRME le {date} a {heure} ({prestation}). {suite} Merci !',
    subject: 'Votre rendez-vous Beauté Halal est confirmé',
  },
}

/** Variables d'un modèle WhatsApp, dans l'ordre {{1}}, {{2}}… */
const PARAMS_WHATSAPP = {
  confirmed: ['prenom', 'date', 'heure', 'prestation', 'reference'],
  reminder: ['prenom', 'date', 'heure', 'prestation', 'reference'],
  rejected: ['prenom', 'date', 'heure'],
  cancelled: ['prenom', 'date', 'heure'],
  thanks: ['prenom'],
  request_received: ['prenom', 'reference'],
  request_paid: ['prenom', 'reference', 'paye'],
  payment_confirmed: ['prenom', 'date', 'heure', 'prestation', 'paye', 'reference'],
  request_contacted: ['prenom', 'reference'],
  request_confirmed: ['prenom', 'date', 'heure', 'prix', 'reference'],
  request_rejected: ['prenom', 'reference'],
  request_cancelled: ['prenom', 'reference'],
}

/** `notify_confirmed_enabled`, `notify_confirmed_channel`, … */
const cle = (evenement, suffixe) => `notify_${evenement}_${suffixe}`

/** Les clés que « Paramètres du salon » doit accepter en écriture. */
export const CLES_REGLAGES = [
  ...Object.keys(EVENEMENTS).flatMap((evenement) => [
    cle(evenement, 'enabled'),
    cle(evenement, 'channel'),
    cle(evenement, 'template'),
  ]),
  // Récapitulatif complet (e-mail + WhatsApp) envoyé dès le paiement des 5 000 FCFA : « 0 » le désactive.
  'notify_payment_recap_enabled',
]

/**
 * Le réglage effectif d'un événement : ce que le salon a choisi, sinon le
 * défaut. Un modèle vidé par erreur retombe sur le défaut plutôt que de
 * faire partir un message vide.
 */
export function reglageDe(evenement, reglages = {}) {
  const base = EVENEMENTS[evenement]
  if (!base) return null

  const brutActif = reglages[cle(evenement, 'enabled')]
  const canal = reglages[cle(evenement, 'channel')]
  const modele = reglages[cle(evenement, 'template')]

  return {
    evenement,
    label: base.label,
    kind: base.kind,
    subject: base.defaut.subject,
    enabled: brutActif === undefined || brutActif === null || brutActif === ''
      ? base.defaut.enabled
      : brutActif === '1' || brutActif === 'true',
    channel: canal === 'sms' || canal === 'email' || canal === 'whatsapp' ? canal : base.defaut.channel,
    template: modele?.trim() ? modele : base.defaut.template,
  }
}

/** Tous les réglages, pour l'écran « Modèles de messages ». */
export async function tousLesReglages() {
  const reglages = await getSettings()
  return Object.keys(EVENEMENTS).map((evenement) => reglageDe(evenement, reglages))
}

/* ────────────────────────────── Variables ───────────────────────────────── */

const MOIS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
]

/**
 * Date lisible par une cliente : « 26 septembre ».
 *
 * Pas de `toLocaleDateString` ici : le serveur d'hébergement n'embarque pas
 * forcément les données de langue françaises, et un message qui annonce
 * « September 26 » à une cliente d'Abidjan fait mauvais effet.
 */
function dateLisible(valeur) {
  if (!valeur) return ''
  const texte = valeur instanceof Date ? valeur.toISOString().slice(0, 10) : String(valeur).slice(0, 10)
  const [annee, mois, jour] = texte.split('-').map(Number)
  if (!annee || !mois || !jour) return texte
  return `${jour} ${MOIS[mois - 1]}`
}

const heureLisible = (valeur) => String(valeur ?? '').slice(0, 5)

/** Ce que les modèles peuvent appeler entre accolades. */
/** 22000 → « 22 000 FCFA » ; espaces ordinaires (les modèles Meta refusent les insécables). */
function prixLisible(montant, devise = 'FCFA') {
  if (montant === null || montant === undefined || montant === '' || Number.isNaN(Number(montant))) return ''
  const entier = String(Math.round(Number(montant))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${entier} ${devise || 'FCFA'}`
}

function variables({ appointment, salon, contact = {} }) {
  const jourPrestation = dateLisible(appointment?.serviceDate)
  return {
    // Numéro WhatsApp du salon (numéro principal, réglé dans le dashboard) et suite éventuelle après une consultation.
    whatsapp: contact.whatsapp ?? '',
    suite: jourPrestation
      ? `Prestation souhaitee le ${jourPrestation}${appointment?.serviceTime ? ` a ${heureLisible(appointment.serviceTime)}` : ''} : le salon vous contacte pour la confirmer.`
      : '',
    prenom: appointment?.customer?.firstName ?? '',
    nom: appointment?.customer?.lastName ?? '',
    date: dateLisible(appointment?.date),
    heure: heureLisible(appointment?.time),
    prestation: appointment?.service?.name ?? '',
    reference: appointment?.reference ?? '',
    salon: salon?.name || 'Beauté Halal',
    montant: appointment?.price != null ? `${appointment.price} ${appointment.currency ?? 'FCFA'}` : '',
    // Montant lisible (« 22 000 FCFA ») : celui que la cliente reçoit sur WhatsApp.
    prix: prixLisible(appointment?.price, appointment?.currency),
    // Montant de la consultation effectivement payé (Jèko).
    paye: prixLisible(appointment?.paid, appointment?.currency),
  }
}

/* ─────────────────────────────── Envoi ──────────────────────────────────── */

/**
 * Retrouve la fiche cliente rattachée au rendez-vous.
 *
 * Elle porte les consentements (`smsOptIn`, `emailOptIn`) sans lesquels on
 * enverrait à quelqu'un qui a demandé à ne plus rien recevoir. Si la fiche
 * n'existe pas encore — cas d'un rendez-vous très ancien — on se rabat sur
 * les coordonnées du rendez-vous lui-même, en envoyant tout de même : la
 * cliente vient de réserver, elle attend une réponse.
 */
async function clienteDe(appointment) {
  if (appointment?.customerId) {
    const row = await queryOne('SELECT * FROM customers WHERE id = ? LIMIT 1', [
      appointment.customerId,
    ]).catch(() => null)
    if (row) return serializeCustomer(row)
  }
  const parNumero = await findByPhone(appointment?.customer?.phone).catch(() => null)
  return parNumero ? serializeCustomer(parNumero) : null
}

/**
 * Prévient la cliente d'un événement de son rendez-vous.
 *
 * Ne lève jamais, ne fait jamais attendre l'appelant : appelez-la sans
 * `await` depuis une route, le parcours n'en dépend pas.
 *
 * @returns {Promise<object|null>} le résultat de l'envoi, ou null si
 *   l'événement est désactivé — utile aux routes qui veulent le consigner.
 */
export async function notifierCliente(evenement, { appointment }, actor = null, options = {}) {
  try {
    // `salon_settings` porte à la fois les réglages de notification et le
    // nom du salon : une seule lecture suffit pour les deux.
    const reglages = await getSettings()
    const base = reglageDe(evenement, reglages)
    if (!base || !base.enabled) return null
    // `options.canal` impose le canal (envoi sur plusieurs canaux) ; sinon celui choisi par le salon.
    const reglage = options.canal ? { ...base, channel: options.canal } : base

    const cliente = await clienteDe(appointment)
    const valeurs = variables({ appointment, salon: reglages, contact: await contactSalon() })
    let corps = remplirModele(reglage.template, valeurs).replace(/ {2,}/g, ' ').trim()
    // Consultation par téléphone / WhatsApp : pas de jour choisi → on retire simplement « pour le … à … ».
    if (!valeurs.date) corps = corps.replace(/\s+(?:pour le|le)\s+a\s*(?=[.,])/g, '')

    return await envoyer(
      {
        channel: reglage.channel,
        kind: reglage.kind,
        customer: cliente,
        appointmentId: appointment?.id ?? null,
        /*
         * Sans fiche cliente, on écrit quand même : les coordonnées du
         * rendez-vous suffisent, et la cliente attend une réponse.
         */
        recipient: cliente
          ? undefined
          : reglage.channel === 'email'
            ? appointment?.customer?.email
            : appointment?.customer?.phone,
        subject: reglage.subject,
        body: corps,
        whatsapp:
          reglage.channel === 'whatsapp'
            ? {
                template: config.whatsapp.templates[evenement] || '',
                params: (PARAMS_WHATSAPP[evenement] ?? []).map((nom) => valeurs[nom] ?? ''),
              }
            : null,
      },
      actor,
    )
  } catch (error) {
    // Un message raté ne doit jamais faire échouer une confirmation.
    console.error(`Notification « ${evenement} » non envoyée :`, error.message)
    return null
  }
}

/**
 * Prévient la cliente d'un événement de sa DEMANDE de rendez-vous (site v3).
 * Ne lève jamais. `demande` = ligne `booking_requests` sérialisée (serialize()).
 */
export function notifierDemande(evenement, demande, actor = null, extra = {}) {
  return notifierCliente(
    evenement,
    {
      appointment: {
        id: extra.appointmentId ?? null,
        customerId: demande.customerId ?? null,
        reference: demande.reference,
        date: extra.date ?? null,
        time: extra.time ?? null,
        price: extra.price ?? null,
        serviceDate: demande.serviceDate ?? null,
        serviceTime: demande.serviceTime ?? null,
        currency: 'FCFA',
        customer: {
          firstName: demande.firstName,
          lastName: demande.lastName,
          phone: demande.phone,
          email: demande.email,
        },
      },
    },
    actor,
  )
}

/**
 * Accusé de réception d'une demande validée : la cliente le reçoit par SMS, e-mail ET WhatsApp.
 * Les trois envois sont indépendants : un canal en panne (ou sans modèle WhatsApp approuvé) n'empêche pas les autres,
 * et chacun est consigné dans le journal de la Messagerie. Ne lève jamais.
 */
export function notifierDemandeTousCanaux(evenement, demande, actor = null, extra = {}) {
  const appointment = {
    id: extra.appointmentId ?? null,
    customerId: demande.customerId ?? null,
    reference: demande.reference,
    date: extra.date ?? null,
    time: extra.time ?? null,
    price: extra.price ?? null,
    paid: extra.paid ?? null,
    serviceDate: demande.serviceDate ?? null,
    serviceTime: demande.serviceTime ?? null,
    service: extra.service ? { name: extra.service } : undefined,
    currency: 'FCFA',
    customer: { firstName: demande.firstName, lastName: demande.lastName, phone: demande.phone, email: demande.email },
  }
  return Promise.allSettled(
    (extra.canaux ?? ['sms', 'email', 'whatsapp']).map((canal) => notifierCliente(evenement, { appointment }, actor, { canal })),
  )
}

/** Statut d'une demande → événement à annoncer (les autres ne notifient pas). */
export const EVENEMENT_PAR_STATUT_DEMANDE = {
  contacted: 'request_contacted',
  confirmed: 'request_confirmed',
  rejected: 'request_rejected',
  cancelled: 'request_cancelled',
}

/**
 * Le statut d'un rendez-vous, traduit en événement à annoncer.
 * Les statuts intermédiaires (arrivée, en cours) ne se notifient pas : la
 * cliente est devant vous, lui envoyer un SMS serait absurde.
 */
export const EVENEMENT_PAR_STATUT = {
  confirmed: 'confirmed',
  rejected: 'rejected',
  cancelled: 'cancelled',
}


/* ───────────────────── Contexte commun aux messages et e-mails ───────────────────── */

/** Numéro WhatsApp principal du salon et « bon à savoir » : réglés dans le dashboard, relus à chaque envoi. */
export async function contactSalon() {
  try {
    const catalogue = await getCatalogue()
    const lignes = Array.isArray(catalogue?.site?.regles?.lignes) ? catalogue.site.regles.lignes.filter(Boolean) : []
    return {
      whatsapp: String(catalogue?.whatsapp?.display ?? '').trim(),
      reglesTitre: catalogue?.site?.regles?.titre ?? '',
      regles: lignes,
    }
  } catch {
    return { whatsapp: '', reglesTitre: '', regles: [] }
  }
}

/** Ce que la demande d'origine apprend à l'e-mail : consultation ou installation, acompte, prestation souhaitée ensuite. */
async function contexteEmail(appointmentId) {
  const contact = await contactSalon()
  const demande = appointmentId
    ? await queryOne('SELECT consultation_mode, payment_status, payment_amount, service_date, service_time, lock_type, besoin FROM booking_requests WHERE appointment_id = ? LIMIT 1', [appointmentId]).catch(() => null)
    : null
  const jour = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null)
  return {
    ...contact,
    consultation: ['sur_place', 'telephone', 'whatsapp'].includes(demande?.consultation_mode),
    paye: demande?.payment_status === 'paid' ? Number(demande.payment_amount ?? 0) || null : null,
    serviceDate: jour(demande?.service_date),
    serviceTime: demande?.service_time ? String(demande.service_time).slice(0, 5) : null,
  }
}

/** E-mail « décision du salon » (confirmé, refusé…) adapté au parcours actuel. Ne lève jamais. */
export async function envoyerEmailStatut(rendezVous) {
  try {
    return await sendMail(appointmentStatusToCustomer(rendezVous, await contexteEmail(rendezVous?.id)))
  } catch (error) {
    console.error('E-mail de statut non envoyé :', error.message)
    return null
  }
}

/** E-mail de remerciement adapté au parcours actuel. Ne lève jamais. */
export async function envoyerEmailRemerciement(rendezVous) {
  try {
    return await sendMail(appointmentThanksToCustomer(rendezVous, await contexteEmail(rendezVous?.id)))
  } catch (error) {
    console.error('E-mail de remerciement non envoyé :', error.message)
    return null
  }
}


/**
 * Récapitulatif COMPLET envoyé dès que le paiement de 5 000 FCFA est confirmé : e-mail ET WhatsApp, en même temps,
 * avec tous les détails (rendez-vous, paiement, consultation, coiffure et modèle choisis, durée, tarif, règles du salon).
 * `ligne` = ligne booking_requests (snake_case). Chaque canal est indépendant et consigné dans la Messagerie ;
 * le consentement de la cliente est vérifié par `envoyer()`. Ne lève jamais. Désactivable : notify_payment_recap_enabled = 0.
 */
export async function envoyerRecapPaiement(ligne, { rendezVous = null, confirme = false, creneau = null } = {}, actor = null) {
  try {
    const reglages = await getSettings()
    if (String(reglages.notify_payment_recap_enabled ?? '1') === '0') return null
    const catalogue = await getCatalogue()
    const recap = construireRecapPaiement({ ligne, catalogue, rendezVous, confirme, creneau })
    const cliente = await clienteDe({ customerId: ligne.customer_id ?? null, customer: { phone: ligne.phone } })
    const envois = ['email', 'whatsapp'].map((canal) =>
      envoyer(
        {
          channel: canal,
          kind: 'appointment',
          customer: cliente,
          appointmentId: rendezVous?.id ?? null,
          recipient: cliente ? undefined : canal === 'email' ? ligne.email : ligne.phone,
          subject: recap.subject,
          body: canal === 'email' ? recap.email : recap.whatsapp,
          whatsapp: null,
        },
        actor,
      ),
    )
    return await Promise.allSettled(envois)
  } catch (error) {
    console.error('Récapitulatif de paiement non envoyé :', error.message)
    return null
  }
}
