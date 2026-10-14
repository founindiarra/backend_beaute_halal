import { Router } from 'express'
import { z } from 'zod'

import { buildSnapshot, findDocument, insertDocument, nextNumber, readSnapshot } from './model.js'
import { ApiError } from '../../lib/ApiError.js'
import { sendData, sendList } from '../../lib/http.js'
import { renderDocument } from '../../lib/pdf.js'
import { validate } from '../../middleware/validate.js'
import { findRow, listDocuments, logEvent } from '../operations/model.js'

/**
 * Proforma et reçu.
 *
 *   PROFORMA — à la confirmation, avant la prestation. Décrit ce qui est
 *              prévu : prestation, durée, tarif. Ne prouve aucun paiement.
 *   REÇU     — après enregistrement du paiement. Décrit ce qui a été
 *              encaissé, et fige les montants pour de bon.
 *
 * Les deux sont réimprimables depuis la fiche. Un reçu se réimprime toujours
 * à l'identique — c'est son instantané qui fait foi, pas l'état courant du
 * rendez-vous ; un proforma, lui, se réédite d'après l'état courant, puisque
 * son objet est justement d'annoncer ce qui est prévu à cet instant.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() })

export const adminRouter = Router()

/**
 * Émet un document et renvoie sa fiche. En cas de collision sur le numéro —
 * deux émissions simultanées — on réessaie : c'est l'index UNIQUE de la base
 * qui arbitre, jamais un compteur tenu en mémoire.
 */
async function issue(appointmentId, kind, actor) {
  const row = await findRow(appointmentId)
  if (!row) throw ApiError.notFound('Ce rendez-vous n’existe pas.')

  const snapshot = await buildSnapshot(row, kind)

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const number = await nextNumber(kind)
    try {
      const id = await insertDocument({ appointmentId, kind, number, snapshot }, actor)
      await logEvent(
        appointmentId,
        'document',
        `${kind === 'receipt' ? 'Reçu' : 'Proforma'} ${number} établi`,
        actor,
      )
      return { id, number, kind }
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error
    }
  }

  throw new ApiError(500, 'Impossible d’attribuer un numéro de document. Réessayez.')
}

/**
 * Émission d'un proforma. Utilisée à la confirmation du rendez-vous et
 * chaque fois qu'on en redemande un depuis la fiche.
 */
export async function issueProforma(appointmentId, actor) {
  return issue(appointmentId, 'proforma', actor)
}

adminRouter.get(
  '/appointments/:id/documents',
  validate({ params: idParam }),
  async (request, response) => {
    const rows = await listDocuments(request.params.id)
    return sendList(
      response,
      rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        number: row.number,
        issuedByName: row.issued_by_name,
        createdAt: row.created_at,
      })),
    )
  },
)

adminRouter.post(
  '/appointments/:id/documents/proforma',
  validate({ params: idParam }),
  async (request, response) => {
    const row = await findRow(request.params.id)
    if (!row) throw ApiError.notFound('Ce rendez-vous n’existe pas.')
    if (['pending', 'rejected', 'cancelled'].includes(row.status)) {
      throw ApiError.conflict('Confirmez d’abord le rendez-vous.')
    }
    return sendData(response, await issue(row.id, 'proforma', request.user))
  },
)

/**
 * Le reçu n'est établi qu'une fois un versement enregistré : un reçu sans
 * paiement ne prouverait rien et pourrait être présenté comme une quittance.
 */
adminRouter.post(
  '/appointments/:id/documents/receipt',
  validate({ params: idParam }),
  async (request, response) => {
    const row = await findRow(request.params.id)
    if (!row) throw ApiError.notFound('Ce rendez-vous n’existe pas.')

    const snapshot = await buildSnapshot(row, 'receipt')
    if (snapshot.totals.paid <= 0) {
      throw ApiError.conflict('Enregistrez d’abord un paiement.')
    }

    return sendData(response, await issue(row.id, 'receipt', request.user))
  },
)

/**
 * GET /admin/documents/:id/pdf
 *
 * Le téléchargement passe par le client HTTP du dashboard, avec le jeton
 * dans l'en-tête : la route est protégée comme les autres, aucun lien direct
 * ne permet d'ouvrir le reçu d'une cliente sans être connecté.
 */
adminRouter.get(
  '/documents/:id/pdf',
  validate({ params: idParam }),
  async (request, response) => {
    const row = await findDocument(request.params.id)
    if (!row) throw ApiError.notFound('Ce document n’existe pas.')

    let snapshot = readSnapshot(row)

    /*
     * Un proforma se réédite d'après l'état courant : il annonce ce qui est
     * prévu, et le rendez-vous a pu changer d'heure ou de coiffure depuis.
     * Un reçu, jamais : ce qui a été remis à la cliente est ce qui doit
     * ressortir, quelles que soient les écritures passées depuis.
     */
    if (row.kind === 'proforma') {
      const appointment = await findRow(row.appointment_id)
      if (appointment) snapshot = await buildSnapshot(appointment, 'proforma')
    }

    if (!snapshot) throw new ApiError(500, 'Le contenu de ce document est illisible.')

    const pdf = await renderDocument(snapshot, { numero: row.number })

    response.setHeader('Content-Type', 'application/pdf')
    response.setHeader('Content-Length', pdf.length)
    response.setHeader('Content-Disposition', `inline; filename="${row.number}.pdf"`)
    response.setHeader('Cache-Control', 'private, no-store')
    return response.end(pdf)
  },
)

export default adminRouter
