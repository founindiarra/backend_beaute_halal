import { Router } from 'express'
import { z } from 'zod'

import { config } from '../../config/env.js'
import { query } from '../../config/database.js'
import { ApiError } from '../../lib/ApiError.js'
import { paginationMeta, readPagination, sendData } from '../../lib/http.js'
import {
  WhatsappQrError,
  connecter,
  deconnecter,
  qr,
  statut,
  synchroniserDesinscription,
  whatsappQrConfigurationManquante,
} from '../../lib/whatsappQr.js'
import { whatsappActionLimiter, whatsappLimiter } from '../../middleware/rateLimit.js'
import { getQuery, validate } from '../../middleware/validate.js'
import { envoyer, memeNumero } from '../messaging/model.js'

/**
 * Administration du compte WhatsApp du salon (service Baileys, connexion par QR code).
 *
 * Le droit « whatsapp » est vérifié dans routes/index.js (garde par préfixe) : réservé à l'administratrice,
 * jamais accordable à un agent. Le navigateur ne parle qu'à ces routes ; le service, son secret et ses
 * fichiers de session restent côté serveur.
 */
export const adminRouter = Router()

adminRouter.use('/whatsapp', whatsappLimiter)

const journalIncident = (action, error, request) => {
  // Jamais le message brut du service, jamais le QR : un code et l'identifiant de l'administratrice.
  console.error(`WhatsApp QR [${action}] ${error.code}${error.serviceCode ? `/${error.serviceCode}` : ''} (admin ${request.user?.id ?? '?'})`)
}

/** Traduit une erreur du service en erreur d'API contrôlée. */
function versApiError(error) {
  if (!(error instanceof WhatsappQrError)) return error
  const messages = {
    NOT_CONFIGURED: 'Le service WhatsApp n’est pas configuré sur le serveur.',
    UNREACHABLE: 'Le service WhatsApp est injoignable pour le moment.',
    TIMEOUT: 'Le service WhatsApp n’a pas répondu à temps.',
    AUTH_FAILED: 'Le serveur et le service WhatsApp ne partagent pas le même secret : contactez la personne qui administre le serveur.',
    NO_QR: 'Aucun QR code disponible pour le moment.',
    NOT_CONNECTED: 'WhatsApp n’est pas connecté.',
    RATE_LIMITED: 'Trop de demandes au service WhatsApp. Patientez un instant.',
    OPTED_OUT: 'Ce numéro est sur la liste de désinscription.',
    REJECTED: 'Ce destinataire est refusé par WhatsApp.',
    INVALID: 'Demande refusée par le service WhatsApp.',
  }
  const status = ['NOT_CONFIGURED', 'UNREACHABLE', 'AUTH_FAILED', 'SERVICE_ERROR'].includes(error.code) ? (error.code === 'NOT_CONFIGURED' ? 503 : 502) : error.status
  return new ApiError(status, messages[error.code] ?? 'Le service WhatsApp a rencontré une erreur.', {
    code: `WHATSAPP_${error.code}`,
  })
}

const pas = (request) => request.user

/** Enveloppe : exécute l'appel au service, consigne l'incident, renvoie une erreur contrôlée. */
async function appeler(action, request, fonction) {
  try {
    return await fonction()
  } catch (error) {
    if (error instanceof WhatsappQrError) journalIncident(action, error, request)
    throw versApiError(error)
  }
}

/** GET /admin/whatsapp/status — toujours 200 : « service indisponible » est un état, pas une panne du dashboard. */
adminRouter.get('/whatsapp/status', async (request, response) => {
  const manques = whatsappQrConfigurationManquante()
  const base = {
    provider: config.whatsapp.provider,
    enabled: config.whatsapp.enabled,
    configured: manques.length === 0,
    missing: manques,
    /** Numéro d'essai de l'administratrice (masqué) ; null = non configuré sur le serveur. */
    testPhone: config.admin.testPhone ? masquer(config.admin.testPhone) : null,
  }
  response.set('Cache-Control', 'no-store')
  if (config.whatsapp.provider !== 'qr') {
    return sendData(response, { ...base, service: { reachable: false, error: 'WRONG_PROVIDER' }, connection: null })
  }
  if (manques.length) {
    return sendData(response, { ...base, service: { reachable: false, error: 'NOT_CONFIGURED' }, connection: null })
  }
  try {
    const connection = await statut(pas(request))
    return sendData(response, { ...base, service: { reachable: true, error: null }, connection })
  } catch (error) {
    if (!(error instanceof WhatsappQrError)) throw error
    journalIncident('status', error, request)
    return sendData(response, { ...base, service: { reachable: false, error: error.code }, connection: null })
  }
})

/** POST /admin/whatsapp/connect — démarre la connexion ; le QR se récupère ensuite via /qr. */
adminRouter.post('/whatsapp/connect', whatsappActionLimiter, async (request, response) => {
  const connection = await appeler('connect', request, () => connecter(pas(request)))
  console.warn(`WhatsApp QR : connexion demandée par l’admin ${request.user.id}`)
  response.set('Cache-Control', 'no-store')
  return response.status(202).json({ success: true, data: { connection } })
})

/** GET /admin/whatsapp/qr — le QR courant, jamais mis en cache ni journalisé. */
adminRouter.get('/whatsapp/qr', async (request, response) => {
  const image = await appeler('qr', request, () => qr(pas(request)))
  response.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  response.set('Pragma', 'no-cache')
  return sendData(response, image)
})

/**
 * POST /admin/whatsapp/disconnect — déconnexion RÉELLE du compte (appareil délié, session supprimée sur le serveur).
 * Exige `{ "confirm": true }` : une requête accidentelle ne suffit pas.
 */
adminRouter.post(
  '/whatsapp/disconnect',
  whatsappActionLimiter,
  validate({ body: z.object({ confirm: z.literal(true, { error: 'Confirmation requise.' }) }) }),
  async (request, response) => {
    const connection = await appeler('disconnect', request, () => deconnecter(pas(request)))
    console.warn(`WhatsApp QR : déconnexion confirmée par l’admin ${request.user.id}`)
    response.set('Cache-Control', 'no-store')
    return sendData(response, { connection })
  },
)

/**
 * POST /admin/whatsapp/test-message — un texte d'essai vers le numéro saisi sur la page (`to`), à défaut vers ADMIN_TEST_PHONE.
 */
adminRouter.post(
  '/whatsapp/test-message',
  whatsappActionLimiter,
  validate({
    body: z.object({
      to: z.string().trim().max(24).optional(),
      text: z.string().trim().min(1).max(500).optional(),
    }),
  }),
  async (request, response) => {
    // Destinataire : le numéro saisi sur la page, sinon celui configuré sur le serveur (ADMIN_TEST_PHONE).
    const destinataire = request.body.to || config.admin.testPhone
    if (!destinataire) {
      throw new ApiError(422, 'Indiquez le numéro qui doit recevoir l’essai (ou configurez ADMIN_TEST_PHONE sur le serveur).', { code: 'WHATSAPP_TEST_NO_RECIPIENT' })
    }
    const texte = request.body.text || 'Essai de connexion WhatsApp — Beauté Halal.'
    const issue = await envoyer({ channel: 'whatsapp', kind: 'test', recipient: destinataire, body: texte }, request.user)
    return sendData(response, { status: issue.status, error: issue.error ?? null, logId: issue.id })
  },
)

/**
 * POST /admin/whatsapp/sync-optouts — pousse vers le service la liste des clientes qui ont refusé WhatsApp (la base fait foi).
 * Ajout seulement (PUT) : la sécurité va dans le sens du refus. Les retraits se font à chaque changement de fiche.
 */
adminRouter.post('/whatsapp/sync-optouts', whatsappActionLimiter, async (request, response) => {
  const lignes = await query('SELECT phone FROM customers WHERE whatsapp_opt_in = 0 AND phone IS NOT NULL LIMIT 2000')
  let envoyes = 0
  let echecs = 0
  for (const ligne of lignes) {
    const issue = await synchroniserDesinscription({ to: ligne.phone, desinscrit: true, actor: request.user })
    if (issue.ok) envoyes += 1
    else {
      echecs += 1
      if (issue.code === 'NOT_CONFIGURED' || issue.code === 'UNREACHABLE' || issue.code === 'TIMEOUT' || issue.code === 'AUTH_FAILED') break
    }
  }
  console.warn(`WhatsApp QR : synchronisation des désinscriptions demandée par l’admin ${request.user.id} (${envoyes} envoyées, ${echecs} en échec)`)
  return sendData(response, { total: lignes.length, synchronises: envoyes, echecs })
})

/* ─────────────── Journal des envois (sans contenu des messages) ─────────────── */

const masquer = (numero) => {
  const chiffres = String(numero ?? '').replace(/[^0-9]/g, '')
  if (chiffres.length < 6) return '••••'
  return `${chiffres.slice(0, 3)} ••• ••${chiffres.slice(-3)}`
}

const logsQuery = z.object({
  status: z.enum(['queued', 'sent', 'failed', 'skipped']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

/**
 * GET /admin/whatsapp/logs — ce qui est parti, ce qui a échoué et pourquoi.
 * On réutilise `message_logs` (canal « whatsapp »). Le texte des messages n'est jamais renvoyé ici,
 * et les numéros sont masqués.
 */
adminRouter.get('/whatsapp/logs', validate({ query: logsQuery }), async (request, response) => {
  const filtres = getQuery(request)
  const pagination = readPagination({ query: filtres })
  const where = ["channel = 'whatsapp'"]
  const params = []
  if (filtres.status) {
    where.push('status = ?')
    params.push(filtres.status)
  }
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM message_logs WHERE ${where.join(' AND ')}`, params)
  const rows = await query(
    `SELECT id, kind, recipient, status, error, created_at, sent_at
       FROM message_logs WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT ${Number(pagination.limit)} OFFSET ${Number(pagination.offset)}`,
    params,
  )
  response.set('Cache-Control', 'no-store')
  return response.json({
    success: true,
    data: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      recipient: masquer(r.recipient),
      status: r.status,
      error: r.error,
      createdAt: r.created_at,
      sentAt: r.sent_at,
    })),
    meta: paginationMeta(pagination, Number(total)),
  })
})
