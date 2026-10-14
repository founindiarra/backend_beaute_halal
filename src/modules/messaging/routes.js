import { randomUUID } from 'node:crypto'

import { Router } from 'express'
import { z } from 'zod'

import {
  KINDS,
  envoyer,
  findMessage,
  listMessages,
  messagingStats,
  rendezVousARappeler,
  souhaiterAnniversaires,
} from './model.js'
import { notifierCliente, reglageDe, tousLesReglages } from './notifications.js'
import { config } from '../../config/env.js'
import { ApiError } from '../../lib/ApiError.js'
import { paginationMeta, readPagination, sendData } from '../../lib/http.js'
import { segmentsSms, smsConfigurationManquante, smsPret } from '../../lib/sms.js'
import { requirePermission } from '../../middleware/auth.js'
import { getQuery, validate } from '../../middleware/validate.js'
import { birthdaysOn, findById as findCustomer, listCustomers, serializeCustomer } from '../customers/model.js'
import { getSettings } from '../salon/model.js'

export const adminRouter = Router()

adminRouter.use('/messaging', requirePermission('messaging'))

const idParam = z.object({ id: z.coerce.number().int().positive() })

/** Demain, au format « AAAA-MM-JJ » — la journée qu'on rappelle le soir. */
const demain = () => {
  const jour = new Date()
  jour.setDate(jour.getDate() + 1)
  return jour.toISOString().slice(0, 10)
}

/* ═══════════════════════════ État de la passerelle ════════════════════ */

/**
 * GET /admin/messaging/status
 *
 * Ce que l'écran a besoin de savoir avant de proposer un envoi : la
 * passerelle est-elle configurée, et si non, quelle variable manque. Le jeton
 * n'est jamais renvoyé — seulement le fait qu'il soit renseigné ou pas.
 */
adminRouter.get('/messaging/status', async (_request, response) => {
  const manques = smsConfigurationManquante()
  return sendData(response, {
    sms: {
      enabled: config.sms.enabled,
      ready: smsPret(),
      missing: manques,
      sender: config.sms.sender || null,
      url: config.sms.url ? config.sms.url.replace(/\/\/[^@]+@/, '//***@') : null,
      method: config.sms.method,
      authMode: config.sms.authMode,
      contentType: config.sms.contentType,
      fields: {
        to: config.sms.fieldTo,
        message: config.sms.fieldMessage,
        sender: config.sms.fieldSender,
      },
    },
    email: { enabled: config.mail.enabled },
    kinds: KINDS,
  })
})

/**
 * POST /admin/messaging/test
 *
 * Envoi d'essai vers un numéro choisi, qui renvoie la RÉPONSE BRUTE du
 * fournisseur. C'est le moyen le plus court de régler les noms de champs
 * attendus par KYA SMS sans toucher au code : on essaie, on lit ce qu'il
 * répond, on ajuste le `.env`.
 */
adminRouter.post(
  '/messaging/test',
  validate({
    body: z.object({
      to: z.string().trim().min(6).max(40),
      message: z.string().trim().min(1).max(600).optional(),
    }),
  }),
  async (request, response) => {
    const corps =
      request.body.message ||
      'Essai de configuration depuis le tableau de bord Beauté Halal. Aucune action requise.'

    const issue = await envoyer(
      { channel: 'sms', kind: 'test', recipient: request.body.to, body: corps },
      request.user,
    )

    const journal = await findMessage(issue.id)
    return sendData(response, {
      result: issue,
      log: journal,
      hint:
        issue.status === 'failed'
          ? 'Comparez la réponse du fournisseur avec les noms de champs du fichier .env (SMS_FIELD_TO, SMS_FIELD_MESSAGE, SMS_FIELD_SENDER).'
          : null,
    })
  },
)

/* ═══════════════════════════════ Journal ══════════════════════════════ */

const listQuery = z.object({
  channel: z.enum(['sms', 'email']).optional(),
  status: z.enum(['queued', 'sent', 'failed', 'skipped']).optional(),
  kind: z.string().max(32).optional(),
  search: z.string().max(120).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
})

adminRouter.get('/messaging/logs', validate({ query: listQuery }), async (request, response) => {
  const filters = getQuery(request)
  const pagination = readPagination({ query: filters })
  const { total, rows } = await listMessages({ ...filters, ...pagination })
  return response.json({ success: true, data: rows, meta: paginationMeta(pagination, total) })
})

adminRouter.get('/messaging/stats', async (_request, response) =>
  sendData(response, await messagingStats()),
)

adminRouter.get('/messaging/logs/:id', validate({ params: idParam }), async (request, response) => {
  const message = await findMessage(request.params.id)
  if (!message) throw ApiError.notFound('Ce message n’existe pas.')
  return sendData(response, message)
})

/* ═══════════════════════════════ Envois ═══════════════════════════════ */

/** Longueur et nombre de segments — l'écran s'en sert pour annoncer le coût. */
adminRouter.post(
  '/messaging/preview',
  validate({ body: z.object({ message: z.string().max(2000) }) }),
  async (request, response) => sendData(response, segmentsSms(request.body.message)),
)

/** Message à une seule cliente. */
adminRouter.post(
  '/messaging/send',
  validate({
    body: z.object({
      customerId: z.coerce.number().int().positive(),
      channel: z.enum(['sms', 'email']).optional(),
      subject: z.string().trim().max(200).nullish(),
      message: z.string().trim().min(1).max(2000),
    }),
  }),
  async (request, response) => {
    const row = await findCustomer(request.body.customerId)
    if (!row) throw ApiError.notFound('Cette cliente n’existe pas.')

    const issue = await envoyer(
      {
        channel: request.body.channel ?? 'sms',
        kind: 'manual',
        customer: serializeCustomer(row),
        subject: request.body.subject ?? null,
        body: request.body.message,
      },
      request.user,
    )

    return sendData(response, { ...issue, log: await findMessage(issue.id) })
  },
)

/**
 * Envoi groupé.
 *
 * Les destinataires sont désignés soit un par un, soit par un segment de la
 * page Clientes. Les envois partent l'un après l'autre : une passerelle SMS
 * n'aime pas qu'on lui jette cent requêtes d'un coup, et un envoi groupé qui
 * se fait refuser à mi-parcours est pire qu'un envoi lent.
 *
 * La campagne porte une référence commune : on retrouve d'un coup tout ce qui
 * est parti ensemble, et ce qui a échoué.
 */
adminRouter.post(
  '/messaging/campaign',
  validate({
    body: z
      .object({
        channel: z.enum(['sms', 'email']).optional(),
        subject: z.string().trim().max(200).nullish(),
        message: z.string().trim().min(1).max(2000),
        customerIds: z.array(z.coerce.number().int().positive()).max(500).optional(),
        segment: z.enum(['all', 'new', 'returning', 'birthday']).optional(),
      })
      .refine((d) => d.customerIds?.length || d.segment, {
        message: 'Indiquez des destinataires ou un segment.',
        path: ['customerIds'],
      }),
  }),
  async (request, response) => {
    const canal = request.body.channel ?? 'sms'

    let destinataires = []
    if (request.body.customerIds?.length) {
      const rows = await Promise.all(request.body.customerIds.map((id) => findCustomer(id)))
      destinataires = rows.filter(Boolean).map(serializeCustomer)
    } else {
      const { rows } = await listCustomers({
        segment: request.body.segment === 'all' ? null : request.body.segment,
        limit: 500,
        offset: 0,
      })
      destinataires = rows
    }

    if (!destinataires.length) {
      throw ApiError.unprocessable('Aucune cliente ne correspond à cette sélection.')
    }

    const reference = randomUUID().slice(0, 16)
    const resultats = []

    for (const cliente of destinataires) {
      const corps = request.body.message
        .replace(/\{prenom\}/g, cliente.firstName)
        .replace(/\{nom\}/g, cliente.lastName)

      const issue = await envoyer(
        {
          channel: canal,
          kind: 'campaign',
          customer: cliente,
          subject: request.body.subject ?? null,
          body: corps,
          campaignRef: reference,
        },
        request.user,
      )
      resultats.push({ customerId: cliente.id, name: cliente.fullName, ...issue })
    }

    const compte = (etat) => resultats.filter((r) => r.status === etat).length
    return sendData(response, {
      campaignRef: reference,
      total: resultats.length,
      sent: compte('sent'),
      failed: compte('failed'),
      skipped: compte('skipped'),
      results: resultats,
    })
  },
)

/* ═══════════════════════════════ Rappels ══════════════════════════════ */

/**
 * GET /admin/messaging/reminders?date=
 *
 * Les rendez-vous confirmés d'une journée — demain par défaut — avec, pour
 * chacun, si le rappel est déjà parti. Le salon voit d'un coup d'œil qui
 * reste à prévenir.
 */
adminRouter.get(
  '/messaging/reminders',
  validate({ query: z.object({ date: z.iso.date().optional() }) }),
  async (request, response) => {
    const reglages = await getSettings()
    const reglage = reglageDe('reminder', reglages)
    const jour = getQuery(request).date ?? demain()
    const rendezVous = await rendezVousARappeler(jour)

    return sendData(response, {
      date: jour,
      enabled: reglage.enabled,
      channel: reglage.channel,
      template: reglage.template,
      appointments: rendezVous,
      pending: rendezVous.filter((r) => !r.alreadyReminded).length,
    })
  },
)

/**
 * POST /admin/messaging/reminders/send
 *
 * Envoie les rappels du jour demandé. Idempotent : un rendez-vous déjà
 * rappelé est ignoré, ce que dit le journal. On peut donc cliquer deux fois,
 * ou laisser deux personnes cliquer en même temps, sans doubler les SMS.
 *
 * Les envois partent l'un après l'autre : une passerelle SMS n'aime pas
 * recevoir cinquante requêtes d'un coup.
 */
adminRouter.post(
  '/messaging/reminders/send',
  validate({
    body: z
      .object({
        date: z.iso.date().optional(),
        appointmentIds: z.array(z.coerce.number().int().positive()).max(200).optional(),
      })
      .optional()
      .default({}),
  }),
  async (request, response) => {
    const reglage = reglageDe('reminder', await getSettings())
    if (!reglage.enabled) {
      throw ApiError.unprocessable('Les rappels sont désactivés dans les modèles de messages.')
    }

    const jour = request.body?.date ?? demain()
    let rendezVous = (await rendezVousARappeler(jour)).filter((r) => !r.alreadyReminded)

    if (request.body?.appointmentIds?.length) {
      const voulus = new Set(request.body.appointmentIds.map(Number))
      rendezVous = rendezVous.filter((r) => voulus.has(r.id))
    }

    const resultats = []
    for (const rendezVous_ of rendezVous) {
      const issue = await notifierCliente('reminder', { appointment: rendezVous_ }, request.user)
      resultats.push({
        appointmentId: rendezVous_.id,
        reference: rendezVous_.reference,
        name: rendezVous_.fullName,
        status: issue?.status ?? 'skipped',
        error: issue?.error ?? null,
      })
    }

    const compte = (etat) => resultats.filter((r) => r.status === etat).length
    return sendData(response, {
      date: jour,
      total: resultats.length,
      sent: compte('sent'),
      failed: compte('failed'),
      skipped: compte('skipped'),
      results: resultats,
    })
  },
)

/* ═══════════════════════ Modèles de messages ══════════════════════════ */

/**
 * GET /admin/messaging/templates — ce que le salon dit, et quand.
 *
 * Renvoie les cinq événements du parcours avec leur réglage effectif :
 * celui que le salon a choisi, ou la valeur par défaut. Aucun réglage n'est
 * obligatoire — tout fonctionne sans rien toucher.
 */
adminRouter.get('/messaging/templates', async (_request, response) =>
  sendData(response, await tousLesReglages()),
)

/* ═════════════════════════════ Anniversaires ══════════════════════════ */

adminRouter.get(
  '/messaging/birthdays',
  validate({ query: z.object({ date: z.iso.date().optional() }) }),
  async (request, response) => {
    const reglages = await getSettings()
    const clientes = await birthdaysOn(getQuery(request).date ?? null)
    return sendData(response, {
      enabled: reglages.birthday_enabled === '1',
      channel: reglages.birthday_channel || 'sms',
      template: reglages.birthday_template || '',
      customers: clientes,
    })
  },
)

/**
 * Envoie les vœux du jour.
 *
 * Idempotent : une cliente déjà souhaitée aujourd'hui est ignorée. On peut
 * donc appeler cette route deux fois sans dédoubler les messages — ce qui
 * arrive forcément un jour, à deux personnes qui cliquent en même temps.
 */
adminRouter.post(
  '/messaging/birthdays/send',
  validate({
    body: z
      .object({
        date: z.iso.date().optional(),
        customerIds: z.array(z.coerce.number().int().positive()).max(200).optional(),
      })
      .optional()
      .default({}),
  }),
  async (request, response) => {
    const reglages = await getSettings()
    const modele = reglages.birthday_template
    if (!modele) throw ApiError.unprocessable('Aucun modèle de message d’anniversaire n’est défini.')

    let clientes = await birthdaysOn(request.body?.date ?? null)
    if (request.body?.customerIds?.length) {
      const voulus = new Set(request.body.customerIds.map(Number))
      clientes = clientes.filter((c) => voulus.has(c.id))
    }

    if (!clientes.length) {
      return sendData(response, { total: 0, sent: 0, failed: 0, skipped: 0, results: [] })
    }

    const resultats = await souhaiterAnniversaires(
      { customers: clientes, modele, channel: reglages.birthday_channel || 'sms' },
      request.user,
    )

    const compte = (etat) => resultats.filter((r) => r.status === etat).length
    return sendData(response, {
      total: resultats.length,
      sent: compte('sent'),
      failed: compte('failed'),
      skipped: compte('skipped'),
      results: resultats,
    })
  },
)


