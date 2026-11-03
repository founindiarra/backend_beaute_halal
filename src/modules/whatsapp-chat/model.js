import { execute, query, queryOne } from '../../config/database.js'
import { config } from '../../config/env.js'
import { ApiError } from '../../lib/ApiError.js'
import { formatInternational, normaliserTelephone } from '../../lib/phone.js'
import { WhatsappQrError, envoyerTexte, evenements, statut, whatsappQrConfigure } from '../../lib/whatsappQr.js'
import { findByPhone } from '../customers/model.js'

/**
 * Discussions WhatsApp : conversations et messages conservés en base (le service Baileys ne garde rien).
 *
 *  – Réception : le backend relit le journal d'événements du service (`GET /v1/events`), numéro de séquence par
 *    numéro de séquence, et enregistre chaque message UNE seule fois (index unique sur l'identifiant WhatsApp).
 *  – Envoi : écrit depuis le dashboard, le message est d'abord enregistré (« envoi en cours »), puis confié au
 *    service. Un `clientRef` unique rend la requête rejouable sans doublon ; un message échoué se renvoie par
 *    « Réessayer », qui ne repart que si son état est bien « échec ».
 *  – Consentement : pas de première prise de contact sans fiche cliente consentante ; on ne répond jamais à une
 *    cliente qui a refusé WhatsApp.
 */

const APERCU = 160
const RANG_STATUT = ['sent', 'delivered', 'read']

const apercu = (texte, media) => {
  const base = String(texte ?? '').replace(/\s+/g, ' ').trim()
  const etiquette = { image: '📷 Photo', video: '🎬 Vidéo', audio: '🎤 Message vocal', document: '📄 Document', sticker: 'Sticker', location: '📍 Position', contact: '👤 Contact', other: 'Message' }[media] ?? ''
  if (!base) return (etiquette || 'Message').slice(0, APERCU)
  return `${media && etiquette ? `${etiquette.split(' ')[0]} ` : ''}${base}`.slice(0, APERCU)
}

/* ─────────────────────────── Présentation ─────────────────────────── */

const nomComplet = (ligne) => [ligne.customer_first_name, ligne.customer_last_name].filter(Boolean).join(' ').trim()

/** +225 01 02 03 04 05 : lisible, sans inventer ce que l'on ne sait pas. */
export function numeroLisible(chiffres) {
  const c = String(chiffres ?? '')
  if (!c) return ''
  if (c.startsWith('225') && c.length === 13) return `+225 ${c.slice(3).replace(/(\d{2})(?=\d)/g, '$1 ').trim()}`
  return `+${c}`
}

export function serialiserConversation(l) {
  const nom = nomComplet(l)
  return {
    id: l.id,
    phone: l.phone ?? null,
    phoneDisplay: l.phone ? numeroLisible(l.phone) : null,
    name: nom || l.push_name || (l.phone ? numeroLisible(l.phone) : 'Contact WhatsApp'),
    pushName: l.push_name ?? null,
    isCustomer: Boolean(l.customer_id),
    customerId: l.customer_id ?? null,
    whatsappOptIn: l.customer_id ? Boolean(Number(l.customer_whatsapp_opt_in ?? 1)) : null,
    lastMessageAt: l.last_message_at ?? null,
    lastMessage: l.last_message_preview ?? '',
    lastDirection: l.last_direction ?? null,
    unread: Number(l.unread_count) || 0,
    updatedAt: l.updated_at,
    rev: Number(l.rev) || 0,
  }
}

export function serialiserMessage(m) {
  return {
    id: Number(m.id),
    conversationId: m.conversation_id,
    direction: m.direction,
    origin: m.origin,
    text: m.body,
    mediaType: m.media_type ?? null,
    status: m.status,
    error: m.error_code ?? null,
    at: m.wa_timestamp,
    clientRef: m.client_ref ?? null,
    updatedAt: m.updated_at,
    rev: Number(m.rev) || 0,
  }
}

const SELECT_CONV = `SELECT c.*, cu.first_name AS customer_first_name, cu.last_name AS customer_last_name,
       cu.whatsapp_opt_in AS customer_whatsapp_opt_in,
       CAST(UNIX_TIMESTAMP(c.updated_at) * 1000 AS UNSIGNED) AS rev
  FROM whatsapp_conversations c LEFT JOIN customers cu ON cu.id = c.customer_id`
const SELECT_MSG = `SELECT m.*, CAST(UNIX_TIMESTAMP(m.updated_at) * 1000 AS UNSIGNED) AS rev FROM whatsapp_messages m`

export const trouverConversation = (id) => queryOne(`${SELECT_CONV} WHERE c.id = ? LIMIT 1`, [id])

/* ─────────────────────────── Conversations ─────────────────────────── */

async function ficheDuNumero(phone) {
  if (!phone) return null
  try {
    return await findByPhone(phone)
  } catch {
    return null
  }
}

/** Retrouve ou crée la conversation d'un correspondant. Ne crée JAMAIS de fiche cliente. */
export async function conversationPour({ jid, phone, pushName = null }) {
  const cle = phone ? normaliserTelephone(phone) : null
  const court = cle && cle.length >= 8 ? cle.slice(-8) : null
  // Même personne = même identifiant WhatsApp, OU mêmes 8 derniers chiffres (ancienne forme « 225 + 8 chiffres » et forme
  // actuelle « 225 0X XX XX XX XX »). On préfère la conversation déjà liée à une fiche cliente.
  let ligne = await queryOne(
    `SELECT id, customer_id, push_name, phone FROM whatsapp_conversations
      WHERE jid = ? OR (? IS NOT NULL AND RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', ''), 8) = ?)
      ORDER BY (customer_id IS NOT NULL) DESC, (jid = ?) DESC, id ASC LIMIT 1`,
    [jid, court, court, jid],
  )
  if (!ligne) {
    const fiche = await ficheDuNumero(phone)
    await execute(
      'INSERT IGNORE INTO whatsapp_conversations (jid, phone, phone_key, push_name, customer_id) VALUES (?, ?, ?, ?, ?)',
      [jid, phone ?? null, cle || null, pushName, fiche?.id ?? null],
    )
    ligne = await queryOne('SELECT id, customer_id, push_name, phone FROM whatsapp_conversations WHERE jid = ? LIMIT 1', [jid])
    return ligne
  }
  const maj = []
  const params = []
  if (pushName && pushName !== ligne.push_name) { maj.push('push_name = ?'); params.push(pushName) }
  if (phone && !ligne.phone) { maj.push('phone = ?', 'phone_key = ?'); params.push(phone, cle || null) }
  if (!ligne.customer_id && phone) {
    const fiche = await ficheDuNumero(phone)
    if (fiche) { maj.push('customer_id = ?'); params.push(fiche.id) }
  }
  if (maj.length) await execute(`UPDATE whatsapp_conversations SET ${maj.join(', ')} WHERE id = ?`, [...params, ligne.id])
  return ligne
}

/** Met à jour l'aperçu de la conversation si ce message est le plus récent. */
async function rafraichirApercu(conversationId, { at, text, media, direction }) {
  await execute(
    `UPDATE whatsapp_conversations
        SET last_message_at = ?, last_message_preview = ?, last_direction = ?
      WHERE id = ? AND (last_message_at IS NULL OR last_message_at <= ?)`,
    [at, apercu(text, media), direction, conversationId, at],
  )
}

/* ─────────────────────────── Événements du service ─────────────────────────── */

/** Applique UN événement. Idempotent : rejouer le même événement ne change rien. */
export async function appliquerEvenement(e) {
  if (e.type === 'status') {
    // Les états ne font que monter (envoyé → remis → lu) ; jamais de retour en arrière.
    await execute(
      `UPDATE whatsapp_messages SET status = ?, error_code = NULL
        WHERE wa_message_id = ? AND direction = 'out'
          AND FIELD(status, 'sent', 'delivered', 'read') < FIELD(?, 'sent', 'delivered', 'read')`,
      [e.status === 'failed' ? 'failed' : e.status, e.id, e.status === 'failed' ? 'sent' : e.status],
    )
    return false
  }
  const conv = await conversationPour({ jid: e.jid, phone: e.phone, pushName: e.pushName })
  if (!conv) return false
  const entrant = e.direction === 'in'
  const origine = entrant ? 'client' : e.origin === 'api' ? 'auto' : 'phone'
  const at = new Date(e.ts)
  const r = await execute(
    `INSERT IGNORE INTO whatsapp_messages (conversation_id, wa_message_id, direction, origin, body, media_type, status, wa_timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [conv.id, e.id, e.direction, origine, e.text, e.mediaType, entrant ? 'received' : 'sent', at],
  )
  if (!r.affectedRows) return false // déjà connu : aucun doublon, aucun compteur
  await rafraichirApercu(conv.id, { at, text: e.text, media: e.mediaType, direction: e.direction })
  if (entrant) await execute('UPDATE whatsapp_conversations SET unread_count = unread_count + 1 WHERE id = ?', [conv.id])
  return true
}

let enCours = null
let dernierPassage = 0
const etat = { dernierPassage: null, derniereErreur: null, evenementsTraites: 0, perte: false }

export const etatSynchronisation = () => ({ ...etat })

async function passage() {
  const ligne = await queryOne('SELECT last_seq FROM whatsapp_sync_state WHERE id = 1')
  let apres = Number(ligne?.last_seq) || 0
  let traites = 0
  for (let page = 0; page < 6; page += 1) {
    const lot = await evenements({ after: apres, limit: 200 })
    // Le service a perdu son journal (fichier supprimé) : on repart de zéro ; les doublons sont écartés par l'index unique.
    if (lot.lastSeq < apres) {
      apres = 0
      await execute('UPDATE whatsapp_sync_state SET last_seq = 0 WHERE id = 1')
      continue
    }
    if (lot.gap) etat.perte = true
    for (const e of lot.events) {
      try {
        if (await appliquerEvenement(e)) traites += 1
      } catch (error) {
        // Un événement illisible ne doit pas bloquer tous les suivants : on journalise un code, jamais le contenu.
        console.error(`WhatsApp chat : événement ${e.seq} non enregistré (${error?.code ?? 'ERREUR'})`)
      }
      apres = e.seq
    }
    if (lot.events.length) await execute('UPDATE whatsapp_sync_state SET last_seq = ? WHERE id = 1', [apres])
    else if (lot.lastSeq > apres && lot.rejected > 0) {
      // Événements tous rejetés (format inconnu) : on avance pour ne pas boucler.
      apres = lot.lastSeq
      await execute('UPDATE whatsapp_sync_state SET last_seq = ? WHERE id = 1', [apres])
    }
    if (lot.events.length < 200) break
  }
  return traites
}

/**
 * Relit les nouveaux événements du service. Appels simultanés fusionnés, au plus une relecture par seconde.
 * Ne lève jamais : renvoie { ok, traites, code }.
 */
export async function synchroniser({ forcer = false } = {}) {
  if (!config.whatsapp.chat.enabled || config.whatsapp.provider !== 'qr' || !whatsappQrConfigure()) return { ok: false, traites: 0, code: 'DISABLED' }
  if (enCours) return enCours
  if (!forcer && Date.now() - dernierPassage < 1000) return { ok: etat.derniereErreur === null, traites: 0, code: etat.derniereErreur }
  enCours = (async () => {
    try {
      const traites = await passage()
      etat.dernierPassage = new Date().toISOString()
      etat.derniereErreur = null
      etat.evenementsTraites += traites
      return { ok: true, traites, code: null }
    } catch (error) {
      const code = error instanceof WhatsappQrError ? error.code : 'ERREUR'
      etat.derniereErreur = code
      return { ok: false, traites: 0, code }
    } finally {
      dernierPassage = Date.now()
      enCours = null
    }
  })()
  return enCours
}

let minuteur = null
/** Démarre la relecture périodique (appelée au démarrage du serveur). Ne retient pas le processus à l'arrêt. */
export function demarrerSynchronisation() {
  if (minuteur || !config.whatsapp.chat.enabled || config.whatsapp.provider !== 'qr' || !whatsappQrConfigure()) return false
  minuteur = setInterval(() => void synchroniser(), config.whatsapp.chat.syncSeconds * 1000)
  minuteur.unref?.()
  return true
}
export function arreterSynchronisation() {
  clearInterval(minuteur)
  minuteur = null
}

/* ─────────────────────────── Lecture ─────────────────────────── */

export async function listerConversations({ q = '', nonLues = false, limit = 30, offset = 0 } = {}) {
  const where = []
  const params = []
  if (nonLues) where.push('c.unread_count > 0')
  const terme = String(q ?? '').trim()
  if (terme) {
    const chiffres = terme.replace(/[^0-9]/g, '')
    const morceaux = ['c.push_name LIKE ?', 'cu.first_name LIKE ?', 'cu.last_name LIKE ?', "CONCAT(cu.first_name, ' ', cu.last_name) LIKE ?"]
    params.push(`%${terme}%`, `%${terme}%`, `%${terme}%`, `%${terme}%`)
    if (chiffres.length >= 3) { morceaux.push('c.phone LIKE ?'); params.push(`%${chiffres}%`) }
    where.push(`(${morceaux.join(' OR ')})`)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM whatsapp_conversations c LEFT JOIN customers cu ON cu.id = c.customer_id ${clause}`, params)
  const lignes = await query(
    `${SELECT_CONV} ${clause} ORDER BY (c.last_message_at IS NULL), c.last_message_at DESC, c.id DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  )
  return { rows: lignes.map(serialiserConversation), total: Number(total) }
}

export async function totalNonLus() {
  const [r] = await query('SELECT COALESCE(SUM(unread_count), 0) AS n, COUNT(CASE WHEN unread_count > 0 THEN 1 END) AS conversations FROM whatsapp_conversations')
  return { messages: Number(r?.n) || 0, conversations: Number(r?.conversations) || 0 }
}

/** Messages d'une conversation, du plus ancien au plus récent ; `avant` = identifiant du plus ancien déjà affiché. */
export async function messagesDe(conversationId, { avant = null, limit = 40 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 40, 1), 100)
  const params = [conversationId]
  let borne = ''
  if (avant) { borne = 'AND m.id < ?'; params.push(Number(avant)) }
  const lignes = await query(`${SELECT_MSG} WHERE m.conversation_id = ? ${borne} ORDER BY m.wa_timestamp DESC, m.id DESC LIMIT ${n + 1}`, params)
  const plus = lignes.length > n
  return { rows: lignes.slice(0, n).reverse().map(serialiserMessage), hasMore: plus }
}

/** Ce qui a changé depuis `since` (millisecondes). Les lignes déjà connues du navigateur reviennent : il fusionne par identifiant. */
export async function changementsDepuis(since, { limit = 200 } = {}) {
  const depuis = Math.max(0, Number(since) || 0)
  const [conversations, messages] = await Promise.all([
    query(`${SELECT_CONV} WHERE c.updated_at >= FROM_UNIXTIME(?) ORDER BY c.updated_at ASC LIMIT 200`, [depuis / 1000]),
    query(`${SELECT_MSG} WHERE m.updated_at >= FROM_UNIXTIME(?) ORDER BY m.updated_at ASC, m.id ASC LIMIT ${Number(limit)}`, [depuis / 1000]),
  ])
  const revs = [...conversations.map((c) => Number(c.rev)), ...messages.map((m) => Number(m.rev))]
  return {
    conversations: conversations.map(serialiserConversation),
    messages: messages.map(serialiserMessage),
    cursor: revs.length ? Math.max(...revs) : depuis,
    more: messages.length >= limit || conversations.length >= 200,
  }
}

/** Curseur « maintenant » : plus récent changement connu (ms). Lu AVANT la liste pour qu'aucun changement ne passe entre les deux. */
export async function curseurActuel() {
  const [r] = await query(
    `SELECT CAST(GREATEST(
        COALESCE((SELECT UNIX_TIMESTAMP(MAX(updated_at)) FROM whatsapp_conversations), 0),
        COALESCE((SELECT UNIX_TIMESTAMP(MAX(updated_at)) FROM whatsapp_messages), 0)) * 1000 AS UNSIGNED) AS curseur`,
  )
  return Number(r?.curseur) || 0
}

export async function marquerLue(conversationId) {
  await execute('UPDATE whatsapp_conversations SET unread_count = 0 WHERE id = ? AND unread_count > 0', [conversationId])
}

/* ─────────────────────────── Envoi ─────────────────────────── */

const CODES_ENVOI = {
  NOT_CONNECTED: 'Le WhatsApp du salon n’est pas connecté au service d’envoi (le contact n’y est pour rien). Ouvrez WhatsApp › Connexion et journal, vérifiez l’état, puis réessayez.',
  UNREACHABLE: 'Le service WhatsApp est injoignable.',
  TIMEOUT: 'Le service WhatsApp n’a pas répondu à temps.',
  NOT_CONFIGURED: 'Le service WhatsApp n’est pas configuré.',
  AUTH_FAILED: 'Le service WhatsApp refuse la signature du serveur.',
  RATE_LIMITED: 'Trop de messages envoyés : patientez un instant.',
  OPTED_OUT: 'Ce numéro est sur la liste de désinscription.',
  REJECTED: 'Ce numéro n’a pas WhatsApp, ou WhatsApp a refusé le message.',
  INVALID: 'Message refusé par le service WhatsApp.',
}
export const messageErreurEnvoi = (code) => CODES_ENVOI[code] ?? 'L’envoi a échoué.'

/**
 * Peut-on écrire à cette conversation ? Le salon peut écrire à n'importe quel numéro depuis le chat (y compris une personne
 * non enregistrée qui ne lui a jamais écrit). Seul reste bloqué un contact dont le numéro est inconnu (impossible techniquement : WhatsApp exige un numéro).
 */
export async function verifierDroitDEcrire(conv) {
  if (!conv.phone) {
    throw ApiError.unprocessable('Le numéro de ce contact n’est pas connu : impossible de lui répondre depuis le dashboard.', { code: 'WHATSAPP_CHAT_NO_PHONE' })
  }
}

/** Confie une ligne « sending » au service et enregistre le résultat. Ne lève pas pour une panne : le message passe en « échec ». */
async function transmettre(ligne, conv, actor) {
  let issue
  try {
    issue = await envoyerTexte({ to: conv.phone, text: ligne.body, reference: `chat-${ligne.id}`, actor, kind: 'chat' })
  } catch (error) {
    const code = error instanceof WhatsappQrError ? error.code : 'ERREUR'
    await execute("UPDATE whatsapp_messages SET status = 'failed', error_code = ? WHERE id = ? AND status = 'sending'", [code.slice(0, 40), ligne.id])
    // Diagnostic : « pas connecté » alors que la page dit « Connecté » = le service a changé d'état entre-temps (redémarrage, reconnexion).
    let etat = ''
    if (code === 'NOT_CONNECTED') etat = await statut(actor).then((s) => ` — état réel du service : ${s.state ?? '?'}${s.lastError ? ` (${s.lastError})` : ''}`).catch(() => ' — état du service illisible')
    console.error(`WhatsApp chat : envoi ${ligne.id} en échec (${code}) — admin ${actor?.id ?? '?'}${etat}`)
    return queryOne(`${SELECT_MSG} WHERE m.id = ?`, [ligne.id])
  }
  try {
    await execute("UPDATE whatsapp_messages SET status = 'sent', error_code = NULL, wa_message_id = ? WHERE id = ? AND status = 'sending'", [issue.messageId, ligne.id])
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY' && issue.messageId) {
      // L'événement « message envoyé » du service est arrivé avant la réponse : on fusionne dans la ligne existante.
      const existante = await queryOne('SELECT id FROM whatsapp_messages WHERE wa_message_id = ?', [issue.messageId])
      if (existante) {
        await execute("UPDATE whatsapp_messages SET origin = 'dashboard', sent_by = ?, client_ref = ?, body = ? WHERE id = ?", [actor?.id ?? null, ligne.client_ref, ligne.body, existante.id])
        await execute('DELETE FROM whatsapp_messages WHERE id = ?', [ligne.id])
        return queryOne(`${SELECT_MSG} WHERE m.id = ?`, [existante.id])
      }
    }
    throw error
  }
  await rafraichirApercu(conv.id, { at: ligne.wa_timestamp, text: ligne.body, media: null, direction: 'out' })
  return queryOne(`${SELECT_MSG} WHERE m.id = ?`, [ligne.id])
}

/**
 * Écrit à une conversation. `clientRef` identifie l'intention d'envoi : le même `clientRef` ne produit jamais deux messages.
 */
export async function envoyerDansConversation({ conversationId, texte, clientRef, actor }) {
  const conv = await trouverConversation(conversationId)
  if (!conv) throw ApiError.notFound('Conversation introuvable.')
  await verifierDroitDEcrire(conv)

  const deja = clientRef ? await queryOne(`${SELECT_MSG} WHERE m.client_ref = ?`, [clientRef]) : null
  if (deja) {
    if (Number(deja.conversation_id) !== Number(conv.id)) throw ApiError.conflict('Cette référence d’envoi appartient à une autre conversation.')
    return { message: serialiserMessage(deja), rejoue: true }
  }

  const at = new Date()
  const r = await execute(
    "INSERT INTO whatsapp_messages (conversation_id, client_ref, direction, origin, body, status, sent_by, wa_timestamp) VALUES (?, ?, 'out', 'dashboard', ?, 'sending', ?, ?)",
    [conv.id, clientRef ?? null, texte, actor?.id ?? null, at],
  ).catch(async (error) => {
    if (error?.code === 'ER_DUP_ENTRY') return null // deux requêtes simultanées avec le même clientRef : la première gagne
    throw error
  })
  if (!r) {
    const gagnante = await queryOne(`${SELECT_MSG} WHERE m.client_ref = ?`, [clientRef])
    return { message: serialiserMessage(gagnante), rejoue: true }
  }
  const ligne = await queryOne('SELECT * FROM whatsapp_messages WHERE id = ?', [r.insertId])
  const final = await transmettre(ligne, conv, actor)
  return { message: serialiserMessage(final), rejoue: false }
}

/** « Réessayer » : ne repart que si le message est en échec, et une seule fois même en cas de double clic. */
export async function reessayer({ messageId, actor }) {
  const ligne = await queryOne('SELECT * FROM whatsapp_messages WHERE id = ?', [messageId])
  if (!ligne || ligne.direction !== 'out') throw ApiError.notFound('Message introuvable.')
  const conv = await trouverConversation(ligne.conversation_id)
  await verifierDroitDEcrire(conv)
  const pris = await execute("UPDATE whatsapp_messages SET status = 'sending', error_code = NULL WHERE id = ? AND status = 'failed'", [ligne.id])
  if (!pris.affectedRows) {
    const actuel = await queryOne(`${SELECT_MSG} WHERE m.id = ?`, [ligne.id])
    return { message: serialiserMessage(actuel), rejoue: true }
  }
  const final = await transmettre({ ...ligne, status: 'sending' }, conv, actor)
  return { message: serialiserMessage(final), rejoue: false }
}

/** Démarre (ou retrouve) la conversation avec un numéro. Le consentement est vérifié avant tout envoi. */
export async function ouvrirConversationAvec(saisie) {
  const international = formatInternational(saisie)
  const chiffres = String(international).replace(/[^0-9]/g, '')
  if (chiffres.length < 10 || chiffres.length > 15 || !/^225/.test(chiffres)) {
    throw ApiError.unprocessable('Numéro invalide : indiquez un numéro ivoirien (ex. 01 02 03 04 05) ou au format international.', { code: 'WHATSAPP_CHAT_INVALID_NUMBER' })
  }
  const conv = await conversationPour({ jid: `${chiffres}@s.whatsapp.net`, phone: chiffres })
  return trouverConversation(conv.id)
}

export const _test = { apercu, passage }
