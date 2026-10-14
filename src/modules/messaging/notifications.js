import { envoyer } from './model.js'
import { queryOne } from '../../config/database.js'
import { remplirModele } from '../../lib/sms.js'
import { findByPhone, serializeCustomer } from '../customers/model.js'
import { getSettings } from '../salon/model.js'

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
        'Bonjour {prenom}, nous ne pouvons malheureusement pas retenir votre demande du {date} a {heure}. Appelez-nous pour convenir d un autre creneau. {salon}',
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
        'Bonjour {prenom}, votre rendez-vous du {date} a {heure} a ete annule. Contactez-nous pour en fixer un autre. {salon}',
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

/** `notify_confirmed_enabled`, `notify_confirmed_channel`, … */
const cle = (evenement, suffixe) => `notify_${evenement}_${suffixe}`

/** Les clés que « Paramètres du salon » doit accepter en écriture. */
export const CLES_REGLAGES = Object.keys(EVENEMENTS).flatMap((evenement) => [
  cle(evenement, 'enabled'),
  cle(evenement, 'channel'),
  cle(evenement, 'template'),
])

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
    channel: canal === 'sms' || canal === 'email' ? canal : base.defaut.channel,
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
function variables({ appointment, salon }) {
  return {
    prenom: appointment?.customer?.firstName ?? '',
    nom: appointment?.customer?.lastName ?? '',
    date: dateLisible(appointment?.date),
    heure: heureLisible(appointment?.time),
    prestation: appointment?.service?.name ?? '',
    reference: appointment?.reference ?? '',
    salon: salon?.name || 'Beauté Halal',
    montant: appointment?.price != null ? `${appointment.price} ${appointment.currency ?? 'FCFA'}` : '',
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
export async function notifierCliente(evenement, { appointment }, actor = null) {
  try {
    // `salon_settings` porte à la fois les réglages de notification et le
    // nom du salon : une seule lecture suffit pour les deux.
    const reglages = await getSettings()
    const reglage = reglageDe(evenement, reglages)
    if (!reglage || !reglage.enabled) return null

    const cliente = await clienteDe(appointment)
    const corps = remplirModele(reglage.template, variables({ appointment, salon: reglages }))

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
          : reglage.channel === 'sms'
            ? appointment?.customer?.phone
            : appointment?.customer?.email,
        subject: reglage.subject,
        body: corps,
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
 * Le statut d'un rendez-vous, traduit en événement à annoncer.
 * Les statuts intermédiaires (arrivée, en cours) ne se notifient pas : la
 * cliente est devant vous, lui envoyer un SMS serait absurde.
 */
export const EVENEMENT_PAR_STATUT = {
  confirmed: 'confirmed',
  rejected: 'rejected',
  cancelled: 'cancelled',
}
