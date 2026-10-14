import { config } from '../config/env.js'
import { formatInternational } from './phone.js'

/**
 * Passerelle SMS — pilotée par la configuration, pas par le code.
 *
 * Le salon passe par KYA SMS. Plutôt que de graver les noms de champs de ce
 * fournisseur dans le code, tout ce qui lui est propre vit dans le `.env` :
 * l'adresse, la méthode, la façon de s'authentifier, et le nom des trois
 * champs attendus (destinataire, message, expéditeur).
 *
 * Deux raisons à ce choix, et la seconde compte autant que la première :
 *
 *  1. Le jour où le salon change de fournisseur — ou celui où KYA renomme un
 *     champ — c'est une ligne de configuration, pas une reprise de code
 *     suivie d'un redéploiement.
 *
 *  2. Ces noms de champs, je ne les ai pas vérifiés. La documentation de KYA
 *     est une application JavaScript que je n'ai pas pu lire. Les inscrire en
 *     dur revenait à deviner, et un envoi qui échoue pour un nom de champ
 *     inventé est long à diagnostiquer. Ici, la route d'essai renvoie la
 *     réponse brute du fournisseur : on voit tout de suite ce qu'il attend.
 *
 * Tant que `SMS_ENABLED` vaut false, rien ne part : le message est journalisé
 * et marqué « ignoré ». Le reste de l'application — file d'envoi, historique,
 * anniversaires — fonctionne exactement pareil.
 */

/** Une valeur de configuration manquante rend la passerelle inutilisable. */
export function smsConfigurationManquante() {
  const manques = []
  if (!config.sms.url) manques.push('SMS_API_URL')
  if (!config.sms.token) manques.push('SMS_API_TOKEN')
  if (!config.sms.sender) manques.push('SMS_SENDER_ID')
  return manques
}

export function smsPret() {
  return config.sms.enabled && smsConfigurationManquante().length === 0
}

/**
 * Construit le corps de la requête d'après les noms de champs configurés.
 * `SMS_EXTRA_FIELDS` permet d'ajouter ce que le fournisseur réclame en plus,
 * au format « clé=valeur,clé=valeur ».
 */
function corpsRequete({ to, message }) {
  const numero = config.sms.internationalFormat ? formatInternational(to) : to

  const corps = {
    [config.sms.fieldTo]: [numero],
    [config.sms.fieldMessage]: message,
  }

  if (config.sms.fieldSender) {
    corps[config.sms.fieldSender] = config.sms.sender
  }

  /* Certaines passerelles attendent le jeton dans le corps plutôt qu'en en-tête. */
  if (config.sms.authMode === 'body' && config.sms.fieldToken) {
    corps[config.sms.fieldToken] = config.sms.token
  }

  for (const paire of config.sms.extraFields) {
    const [cle, valeur] = paire.split('=')
    if (cle && valeur !== undefined) {
      corps[cle.trim()] = valeur.trim()
    }
  }

  return corps
}

function entetes() {
  const h = { Accept: 'application/json' }

  if (config.sms.authMode === 'bearer') h.Authorization = `Bearer ${config.sms.token}`
  else if (config.sms.authMode === 'header') h[config.sms.authHeader] = config.sms.token

  if (config.sms.contentType === 'json') h['Content-Type'] = 'application/json'
  else h['Content-Type'] = 'application/x-www-form-urlencoded'

  return h
}

/**
 * Envoie un SMS.
 *
 * Ne lève jamais : un échec d'envoi ne doit pas faire échouer l'opération qui
 * l'a déclenché — une prestation terminée le reste, même si le remerciement
 * n'est pas parti. Le résultat dit ce qui s'est passé, et l'appelant le
 * consigne au journal.
 */
export async function envoyerSms({ to, message }) {
  if (!config.sms.enabled) {
    return { status: 'skipped', error: 'Les SMS sont désactivés (SMS_ENABLED).' }
  }

  const manques = smsConfigurationManquante()
  if (manques.length) {
    return { status: 'failed', error: `Configuration SMS incomplète : ${manques.join(', ')}.` }
  }
  if (!to) return { status: 'failed', error: 'Numéro de destinataire manquant.' }

  const corps = corpsRequete({ to, message })
  const url = new URL(config.sms.url)

  let requete = { method: config.sms.method, headers: entetes() }

  if (config.sms.method === 'GET') {
    Object.entries(corps).forEach(([k, v]) => url.searchParams.append(k, String(v)))
    requete = { method: 'GET', headers: { Accept: 'application/json', ...entetes() } }
    delete requete.headers['Content-Type']
  } else if (config.sms.contentType === 'json') {
    requete.body = JSON.stringify(corps)
  } else {
    requete.body = new URLSearchParams(
      Object.fromEntries(Object.entries(corps).map(([k, v]) => [k, String(v)])),
    ).toString()
  }

  const minuteur = AbortSignal.timeout(config.sms.timeoutMs)

  try {
    const reponse = await fetch(url, { ...requete, signal: minuteur })
    const texte = await reponse.text()

    let charge = null
    try {
      charge = JSON.parse(texte)
    } catch {
      charge = null
    }

    if (!reponse.ok) {
      return {
        status: 'failed',
        error: `Le fournisseur a répondu ${reponse.status}.`,
        response: texte.slice(0, 2000),
      }
    }

    /*
     * On ne devine pas la forme d'une réponse en succès : la réponse brute
     * est conservée telle quelle au journal, et c'est elle qui fera foi le
     * jour où il faudra comprendre un envoi manquant.
     */
    const reference =
      charge?.messageId ?? charge?.message_id ?? charge?.id ?? charge?.reference ?? null

    return { status: 'sent', reference, response: texte.slice(0, 2000) }
  } catch (error) {
    const expire = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return {
      status: 'failed',
      error: expire
        ? 'Le fournisseur SMS n’a pas répondu à temps.'
        : `Envoi impossible : ${error.message}`,
    }
  }
}

/**
 * Remplace les variables d'un modèle de message.
 * Une variable inconnue est laissée telle quelle : mieux vaut que le salon
 * voie « {prenom} » dans l'aperçu et corrige, qu'un message parte avec un trou.
 */
export function remplirModele(modele, valeurs) {
  return String(modele ?? '').replace(/\{(\w+)\}/g, (entier, cle) =>
    valeurs[cle] !== undefined && valeurs[cle] !== null ? String(valeurs[cle]) : entier,
  )
}

/*
 * ─────────────────────────── Comptage des SMS ───────────────────────────
 *
 * Le salon paie au SEGMENT, pas au message. Un SMS « simple » tient en 160
 * caractères ; au-delà, il est découpé et chaque morceau n'en porte plus que
 * 153, la place perdue servant à dire au téléphone comment recoller. Un envoi
 * groupé à cent clientes qui passe de un à deux segments coûte le double, et
 * personne ne s'en aperçoit avant la facture — d'où ce comptage.
 *
 * Ce qui décide, c'est l'ALPHABET GSM 03.38, pas « avoir des accents ». Deux
 * idées fausses coûtent cher ici :
 *
 *   – « é passe en Unicode ». Faux : é, è, à, ù, ì, ò, Ç, ß, É et quelques
 *     autres sont dans l'alphabet GSM de base et ne coûtent qu'un caractère.
 *   – « { } et € font basculer en Unicode ». Faux aussi : ils sont dans la
 *     table d'extension et coûtent DEUX caractères chacun, sans rien changer
 *     pour le reste du message. Un modèle « Bonjour {prenom} » reste donc du
 *     GSM ordinaire.
 *
 * En revanche ê, â, ã, œ, les guillemets « typographiques », les tirets longs
 * et les émojis n'y sont pas : un seul d'entre eux bascule TOUT le message en
 * UCS-2, où l'on ne tient plus que 70 caractères (67 une fois découpé). C'est
 * l'apostrophe courbe ’ collée à la place de ' qui, le plus souvent, double
 * la facture sans prévenir.
 */

/** Alphabet GSM de base : un caractère, un emplacement. */
const GSM_BASE = new Set(
  '@£$¥èéùìòÇ\nØø\rÅå\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e' +
  'ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§' +
  '¿abcdefghijklmnopqrstuvwxyzäöñüà',
)

/** Table d'extension : présents en GSM, mais comptés double. */
const GSM_EXTENSION = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '€'])

/**
 * Longueur d'un SMS, en segments.
 *
 * Renvoie `{ length, segments, unicode, billedCharacters }` :
 *  – `length` est ce que la personne a tapé, tel qu'elle le compte ;
 *  – `billedCharacters` est ce que l'opérateur compte, extensions doublées ;
 *  – `segments` est ce qui est facturé ;
 *  – `unicodeCharacters` nomme les caractères à remplacer, le cas échéant.
 *
 * Note : un message très long dont un caractère d'extension tomberait
 * exactement à cheval sur une coupure peut coûter un segment de plus. Le cas
 * est rare et l'écart est d'un segment ; on préfère un compte simple et
 * lisible à une exactitude illusoire.
 */
export function segmentsSms(message) {
  const texte = String(message ?? '')

  let emplacements = 0
  /*
   * On garde les caractères fautifs plutôt que de s'arrêter au premier : le
   * salon a besoin de savoir LESQUELS remplacer. « Votre message coûte deux
   * segments » n'aide personne ; « à cause de ’ et de À » se corrige en dix
   * secondes.
   */
  const fautifs = new Set()

  for (const caractere of texte) {
    if (GSM_BASE.has(caractere)) {
      emplacements += 1
    } else if (GSM_EXTENSION.has(caractere)) {
      emplacements += 2
    } else {
      fautifs.add(caractere)
    }
  }

  const unicode = fautifs.size > 0

  // En UCS-2 on compte en unités UTF-16 : un émoji en occupe deux.
  const comptees = unicode ? texte.length : emplacements
  const simple = unicode ? 70 : 160
  const multiple = unicode ? 67 : 153

  return {
    length: texte.length,
    billedCharacters: comptees,
    unicode,
    /** Les caractères qui ont fait basculer le message, à remplacer. */
    unicodeCharacters: [...fautifs].slice(0, 12),
    segments: comptees === 0 ? 0 : comptees <= simple ? 1 : Math.ceil(comptees / multiple),
  }
}

export default envoyerSms
