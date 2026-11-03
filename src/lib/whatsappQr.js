import { createHash, createHmac, randomBytes } from 'node:crypto'

import { config } from '../config/env.js'
import { formatInternational } from './phone.js'

/**
 * Client du service WhatsApp QR (Baileys) — le SEUL point par où le backend lui parle.
 *
 * Protocole (voir docs/API.md du service) : chaque requête porte quatre en-têtes
 *   X-BH-Timestamp  millisecondes depuis 1970
 *   X-BH-Nonce      16 à 64 caractères [A-Za-z0-9_-], unique
 *   X-BH-Actor      qui est à l'origine (≤ 64 caractères)
 *   X-BH-Signature  hex(HMAC-SHA256(secret, base))
 * où base = timestamp \n nonce \n MÉTHODE \n chemin (sans query) \n sha256(corps brut) \n acteur.
 *
 * Le secret ne sort jamais d'ici : ni dans une réponse, ni dans un journal, ni dans un message d'erreur.
 * Rien dans ce fichier ne bascule vers Meta : si le service est en panne, l'appelant reçoit une erreur
 * contrôlée (`WhatsappQrError`) et décide quoi consigner.
 */

export class WhatsappQrError extends Error {
  constructor(code, message, { status = 502, retryAfter = null, serviceCode = null } = {}) {
    super(message)
    this.name = 'WhatsappQrError'
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
    this.serviceCode = serviceCode
  }
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** Chaîne signée, exactement celle du service (src/utils/signature.js). */
export function chaineASigner({ timestamp, nonce, method, path, body, actor }) {
  return [timestamp, nonce, String(method).toUpperCase(), path, sha256(body ?? ''), actor ?? ''].join('\n')
}

export function signer(secret, parts) {
  return createHmac('sha256', secret).update(chaineASigner(parts)).digest('hex')
}

export function whatsappQrConfigurationManquante() {
  const manques = []
  if (!config.whatsapp.qr.url) manques.push('WHATSAPP_QR_SERVICE_URL')
  if (!config.whatsapp.qr.secret) manques.push('WHATSAPP_QR_SERVICE_SECRET')
  return manques
}

/** Configuré ≠ joignable : cette fonction ne contacte pas le service. */
export const whatsappQrConfigure = () => whatsappQrConfigurationManquante().length === 0

/** Acteur au format accepté par le service : court, sans caractère de contrôle. */
const acteurDe = (actor) => {
  const base = actor?.id ? `admin-${actor.id}` : 'systeme'
  return base.replace(/[^A-Za-z0-9_.@-]/g, '').slice(0, 64)
}

/**
 * Appelle le service. Renvoie `{ status, data }` pour toute réponse 2xx.
 * Lève `WhatsappQrError` sinon (jamais le texte brut du service).
 */
export async function appelerService(method, path, { body = null, actor = null, timeoutMs } = {}) {
  const manques = whatsappQrConfigurationManquante()
  if (manques.length) {
    throw new WhatsappQrError('NOT_CONFIGURED', 'Le service WhatsApp n’est pas configuré sur le serveur.', { status: 503 })
  }
  const brut = body === null ? '' : JSON.stringify(body)
  const timestamp = String(Date.now())
  const nonce = randomBytes(16).toString('hex')
  const acteur = acteurDe(actor)
  // Le service signe le chemin SANS la query string (voir middleware/auth.js du service).
  const signature = signer(config.whatsapp.qr.secret, { timestamp, nonce, method, path: path.split('?')[0], body: brut, actor: acteur })

  let reponse
  try {
    reponse = await fetch(`${config.whatsapp.qr.url}${path}`, {
      method,
      headers: {
        'X-BH-Timestamp': timestamp,
        'X-BH-Nonce': nonce,
        'X-BH-Actor': acteur,
        'X-BH-Signature': signature,
        ...(body === null ? {} : { 'Content-Type': 'application/json' }),
        Accept: 'application/json',
      },
      body: body === null ? undefined : brut,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs ?? config.whatsapp.qr.timeoutMs),
    })
  } catch (error) {
    const delai = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    throw new WhatsappQrError(
      delai ? 'TIMEOUT' : 'UNREACHABLE',
      delai ? 'Le service WhatsApp n’a pas répondu à temps.' : 'Le service WhatsApp est injoignable.',
      { status: delai ? 504 : 502 },
    )
  }

  const texte = await reponse.text().catch(() => '')
  let donnees = null
  try {
    donnees = texte ? JSON.parse(texte) : null
  } catch {
    donnees = null
  }

  if (reponse.ok) return { status: reponse.status, data: donnees }

  const serviceCode = typeof donnees?.error?.code === 'string' ? donnees.error.code.slice(0, 40) : null
  const retryAfter = Number(reponse.headers.get('retry-after')) || null
  if (reponse.status === 401 || reponse.status === 403) {
    // Secret différent des deux côtés, horloge décalée, ou IP non autorisée : c'est une panne de configuration.
    throw new WhatsappQrError('AUTH_FAILED', 'Le service WhatsApp a refusé la signature du backend.', { status: 502, serviceCode })
  }
  if (reponse.status === 404 && serviceCode === 'NO_QR') {
    throw new WhatsappQrError('NO_QR', 'Aucun QR code disponible pour le moment.', { status: 404, serviceCode })
  }
  if (reponse.status === 409) {
    throw new WhatsappQrError('NOT_CONNECTED', 'WhatsApp n’est pas connecté.', { status: 409, serviceCode })
  }
  if (reponse.status === 422) {
    throw new WhatsappQrError(serviceCode === 'RECIPIENT_OPTED_OUT' ? 'OPTED_OUT' : 'REJECTED', 'Destinataire refusé par le service WhatsApp.', { status: 422, serviceCode })
  }
  if (reponse.status === 429) {
    throw new WhatsappQrError('RATE_LIMITED', 'Limite d’envoi du service WhatsApp atteinte.', { status: 429, retryAfter, serviceCode })
  }
  if (reponse.status === 400 || reponse.status === 413) {
    throw new WhatsappQrError('INVALID', 'Le service WhatsApp a refusé la demande.', { status: 400, serviceCode })
  }
  throw new WhatsappQrError('SERVICE_ERROR', 'Le service WhatsApp a rencontré une erreur.', { status: 502, serviceCode })
}

/* ───────────────────────── Réponses validées ───────────────────────── */

const ETATS = ['disconnected', 'connecting', 'waiting_qr', 'connected', 'disconnecting', 'error']
const ERREURS = ['qr_expired', 'logged_out', 'connection_replaced', 'reconnecting', 'reconnect_failed', 'open_failed']
const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)

/** Ne garde que les champs connus, de types connus : rien d'autre ne parvient au navigateur. */
export function nettoyerStatut(d) {
  const etat = ETATS.includes(d?.state) ? d.state : 'error'
  const erreur = typeof d?.lastError === 'string' ? (ERREURS.includes(d.lastError) || /^closed_\d{1,4}$/.test(d.lastError) ? d.lastError : 'unknown') : null
  return {
    state: etat,
    connected: etat === 'connected' && d?.connected === true,
    phone: typeof d?.phone === 'string' ? d.phone.slice(0, 24) : null,
    connectedAt: iso(d?.connectedAt),
    since: iso(d?.since),
    hasQr: d?.hasQr === true,
    qrExpiresAt: iso(d?.qrExpiresAt),
    lastError: erreur,
    reconnectAttempts: Number.isInteger(d?.reconnectAttempts) ? d.reconnectAttempts : 0,
    hasSavedSession: d?.hasSavedSession === true,
  }
}

export async function statut(actor) {
  const { data } = await appelerService('GET', '/v1/status', { actor })
  return nettoyerStatut(data)
}
export async function connecter(actor) {
  const { data } = await appelerService('POST', '/v1/connect', { actor, body: {} })
  return nettoyerStatut(data)
}
export async function deconnecter(actor) {
  const { data } = await appelerService('POST', '/v1/disconnect', { actor, body: {} })
  return nettoyerStatut(data)
}
export async function qr(actor) {
  const { data } = await appelerService('GET', '/v1/qr', { actor })
  const dataUrl = data?.dataUrl
  if (typeof dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl) || dataUrl.length > 200_000) {
    throw new WhatsappQrError('SERVICE_ERROR', 'Réponse du service WhatsApp invalide.', { status: 502 })
  }
  return { dataUrl, expiresAt: iso(data?.expiresAt) }
}

/** Envoie un texte. `to` : n'importe quel format de numéro ; renvoie la réponse validée. */
export async function envoyerTexte({ to, text, reference, actor = null, kind = null }) {
  const international = formatInternational(to)
  const numero = `+${String(international).replace(/[^0-9]/g, '')}`
  const corps = { to: numero, text, ...(reference ? { reference: String(reference).slice(0, 64) } : {}), ...(kind === 'chat' ? { kind: 'chat' } : {}) }
  const envoyer = () => appelerService('POST', '/v1/send', { actor, body: corps })
  let reponse
  try {
    reponse = await envoyer()
  } catch (error) {
    // Service « non connecté » alors que la session est enregistrée (redémarrage, reconnexion) : on le relance et on réessaie UNE fois.
    if (!(error instanceof WhatsappQrError) || error.code !== 'NOT_CONNECTED' || !(await reconnecterSiPossible(actor))) throw error
    reponse = await envoyer()
  }
  const { data } = reponse
  return {
    messageId: typeof data?.messageId === 'string' ? data.messageId.slice(0, 120) : null,
    status: data?.status === 'sent_to_whatsapp' ? 'sent_to_whatsapp' : 'unknown',
  }
}

const attendre = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Relance la connexion avec la session déjà enregistrée (aucun QR à scanner) et attend jusqu'à ~12 s qu'elle soit établie.
 * Renvoie true si le service est « connected ». Ne lève jamais, ne s'applique pas si un nouveau scan est nécessaire.
 */
export async function reconnecterSiPossible(actor = null) {
  try {
    let etat = await statut(actor)
    if (etat.state === 'connected') return true
    if (!etat.hasSavedSession || ['waiting_qr', 'disconnecting'].includes(etat.state)) return false
    if (etat.state !== 'connecting') etat = await connecter(actor)
    for (let i = 0; i < 8 && etat.state !== 'connected'; i += 1) {
      await attendre(1500)
      etat = await statut(actor)
      if (['waiting_qr', 'error'].includes(etat.state)) return false
    }
    return etat.state === 'connected'
  } catch {
    return false
  }
}

/**
 * Synchronise la liste de désinscription du service avec la base (le BACKEND reste la source de vérité).
 * `desinscrit = true` → PUT (le service refusera tout envoi) ; `false` → DELETE.
 * Ne lève jamais : renvoie `{ ok, code }`. Une panne ici n'empêche rien, la base fait foi à chaque envoi.
 */
export async function synchroniserDesinscription({ to, desinscrit, actor = null }) {
  const chiffres = String(formatInternational(to)).replace(/[^0-9]/g, '')
  if (chiffres.length < 8) return { ok: false, code: 'INVALID' }
  try {
    await appelerService(desinscrit ? 'PUT' : 'DELETE', `/v1/optout/${chiffres}`, { actor })
    return { ok: true, code: null }
  } catch (error) {
    return { ok: false, code: error instanceof WhatsappQrError ? error.code : 'SERVICE_ERROR' }
  }
}

/* ───────────────────────── Discussions : événements du service ───────────────────────── */

const RE_JID = /^(?:[0-9]{6,20}@s\.whatsapp\.net|[0-9]{4,30}@lid)$/
const RE_ID = /^[A-Za-z0-9_.:-]{1,120}$/
const MEDIAS = ['image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'other']

/** Ne garde que les événements bien formés, avec des champs de types connus. */
export function nettoyerEvenement(e) {
  if (!e || typeof e !== 'object' || !Number.isInteger(e.seq) || e.seq < 1) return null
  if (typeof e.id !== 'string' || !RE_ID.test(e.id) || typeof e.jid !== 'string' || !RE_JID.test(e.jid)) return null
  if (e.type === 'status') {
    return ['delivered', 'read', 'failed'].includes(e.status) ? { type: 'status', seq: e.seq, id: e.id, jid: e.jid, status: e.status } : null
  }
  if (e.type !== 'message' || !['in', 'out'].includes(e.direction)) return null
  const phone = typeof e.phone === 'string' && /^[0-9]{8,15}$/.test(e.phone) ? e.phone : null
  const ts = Number.isFinite(e.ts) && e.ts > 946684800000 && e.ts < Date.now() + 86_400_000 ? e.ts : Date.now()
  return {
    type: 'message',
    seq: e.seq,
    id: e.id,
    direction: e.direction,
    jid: e.jid,
    phone,
    pushName: typeof e.pushName === 'string' ? e.pushName.replace(/[\u0000-\u001f]/g, '').slice(0, 80) || null : null,
    text: typeof e.text === 'string' ? e.text.slice(0, 4096) : '',
    mediaType: MEDIAS.includes(e.mediaType) ? e.mediaType : null,
    ts,
    origin: ['client', 'phone', 'api'].includes(e.origin) ? e.origin : e.direction === 'in' ? 'client' : 'phone',
  }
}

/** Lit un lot d'événements après le numéro `after`. */
export async function evenements({ after = 0, limit = 100, actor = null } = {}) {
  const { data } = await appelerService('GET', `/v1/events?after=${Math.max(0, Number(after) || 0)}&limit=${Math.min(Math.max(Number(limit) || 100, 1), 500)}`, { actor })
  const liste = Array.isArray(data?.events) ? data.events.map(nettoyerEvenement).filter(Boolean) : []
  return {
    events: liste,
    lastSeq: Number.isInteger(data?.lastSeq) ? data.lastSeq : 0,
    gap: data?.gap === true,
    // Nombre d'événements reçus mais rejetés (mal formés) : sert à repérer un service incompatible.
    rejected: Array.isArray(data?.events) ? data.events.length - liste.length : 0,
  }
}
