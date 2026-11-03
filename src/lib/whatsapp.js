import { config } from '../config/env.js'
import { formatInternational } from './phone.js'
import { WhatsappQrError, envoyerTexte, whatsappQrConfigurationManquante } from './whatsappQr.js'

/**
 * Passerelle WhatsApp Business Cloud API (Meta).
 *
 * Deux types d'envoi :
 *  – `template` : modèle approuvé par Meta. Seul autorisé pour écrire le
 *    premier à une cliente (confirmation, rappel, remerciement…).
 *  – `text` : texte libre. Meta ne l'accepte que dans les 24 h qui suivent un
 *    message de la cliente ; ailleurs il est refusé (erreur renvoyée au journal).
 *
 * Ne lève jamais : le résultat dit ce qui s'est passé, l'appelant le consigne.
 */

export const whatsappProvider = () => config.whatsapp.provider

export function whatsappConfigurationManquante() {
  if (config.whatsapp.provider === 'qr') return whatsappQrConfigurationManquante()
  const manques = []
  if (!config.whatsapp.phoneNumberId) manques.push('WHATSAPP_PHONE_NUMBER_ID')
  if (!config.whatsapp.token) manques.push('WHATSAPP_ACCESS_TOKEN')
  return manques
}

export function whatsappPret() {
  if (config.whatsapp.provider === 'qr') return whatsappConfigurationManquante().length === 0
  return config.whatsapp.enabled && whatsappConfigurationManquante().length === 0
}

/** Numéro au format attendu par Meta : chiffres seuls, indicatif compris, sans « + ». */
export function numeroWhatsapp(saisie) {
  return formatInternational(saisie).replace(/[^0-9]/g, '')
}

/** Corps de requête Meta. `params` = valeurs des variables {{1}}, {{2}}… dans l'ordre. */
export function construireCorps({ to, template, language, params = [], text }) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to }
  if (template) {
    const composant = params.length
      ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p ?? '').replace(/[\n\t]+/g, ' ').slice(0, 1000) || '-' })) }]
      : []
    return {
      ...base,
      type: 'template',
      template: { name: template, language: { code: language || config.whatsapp.language }, components: composant },
    }
  }
  return { ...base, type: 'text', text: { preview_url: false, body: text } }
}

/**
 * Point d'entrée UNIQUE des envois WhatsApp. Le fournisseur est choisi par WHATSAPP_PROVIDER, jamais deviné :
 * « qr » → service Baileys (texte), « meta » → API officielle (modèles). Aucun repli de l'un vers l'autre.
 */
export async function envoyerWhatsapp({ to, template, language, params, text, reference, actor }) {
  if (config.whatsapp.provider === 'qr') return envoyerWhatsappQr({ to, text, reference, actor })
  return envoyerWhatsappMeta({ to, template, language, params, text })
}

/** Service QR : un texte, un destinataire. Ne lève jamais ; le résultat dit ce qui s'est passé. */
async function envoyerWhatsappQr({ to, text, reference, actor }) {
  // Pas de contrôle WHATSAPP_ENABLED ici : ce drapeau concerne l'API Meta. Avec le service QR, les messages partent
  // depuis le numéro WhatsApp connecté dès que le service est configuré (comme le chat du dashboard).
  const manques = whatsappQrConfigurationManquante()
  if (manques.length) return { status: 'failed', error: `Configuration WhatsApp incomplète : ${manques.join(', ')}.` }
  if (!text) return { status: 'failed', error: 'Aucun contenu à envoyer.' }
  if (!numeroWhatsapp(to)) return { status: 'failed', error: 'Numéro de destinataire manquant.' }
  try {
    const issue = await envoyerTexte({ to, text, reference, actor })
    // « Accepté par WhatsApp » ≠ « lu » : le service ne confirme pas la livraison, nous non plus.
    return { status: 'sent', reference: issue.messageId }
  } catch (error) {
    if (!(error instanceof WhatsappQrError)) return { status: 'failed', error: 'Envoi WhatsApp impossible.' }
    if (error.code === 'OPTED_OUT') return { status: 'skipped', error: 'Le destinataire est sur la liste de désinscription du service.' }
    if (error.code === 'NOT_CONNECTED') return { status: 'failed', error: 'WhatsApp n’est pas connecté : scannez le QR code depuis le dashboard.' }
    if (error.code === 'RATE_LIMITED') return { status: 'failed', error: `Limite d’envoi atteinte${error.retryAfter ? ` (réessayer dans ${error.retryAfter} s)` : ''}.` }
    if (error.code === 'REJECTED') return { status: 'failed', error: error.serviceCode === 'NOT_ON_WHATSAPP' ? 'Ce numéro n’a pas WhatsApp.' : 'Destinataire refusé par WhatsApp.' }
    console.error(`WhatsApp QR : envoi en échec (${error.code}${error.serviceCode ? `/${error.serviceCode}` : ''})`)
    return { status: 'failed', error: error.message.slice(0, 200) }
  }
}

async function envoyerWhatsappMeta({ to, template, language, params, text }) {
  if (!config.whatsapp.enabled) {
    return { status: 'skipped', error: 'WhatsApp est désactivé (WHATSAPP_ENABLED).' }
  }
  const manques = whatsappConfigurationManquante()
  if (manques.length) {
    return { status: 'failed', error: `Configuration WhatsApp incomplète : ${manques.join(', ')}.` }
  }
  const numero = numeroWhatsapp(to)
  if (!numero) return { status: 'failed', error: 'Numéro de destinataire manquant.' }
  if (!template && !text) return { status: 'failed', error: 'Aucun contenu à envoyer.' }

  const url = `${config.whatsapp.graphUrl}/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`

  try {
    const reponse = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(construireCorps({ to: numero, template, language, params, text })),
      signal: AbortSignal.timeout(config.whatsapp.timeoutMs),
    })
    const texte = await reponse.text()
    let charge = null
    try { charge = JSON.parse(texte) } catch { charge = null }

    if (!reponse.ok) {
      const detail = charge?.error?.message
      return {
        status: 'failed',
        error: `WhatsApp a répondu ${reponse.status}${detail ? ` : ${detail}` : '.'}`,
        response: texte.slice(0, 2000),
      }
    }
    return { status: 'sent', reference: charge?.messages?.[0]?.id ?? null, response: texte.slice(0, 2000) }
  } catch (error) {
    const expire = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return {
      status: 'failed',
      error: expire ? 'WhatsApp n’a pas répondu à temps.' : `Envoi impossible : ${error.message}`,
    }
  }
}

export default envoyerWhatsapp
