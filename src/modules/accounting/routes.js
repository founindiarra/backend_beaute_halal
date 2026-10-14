import { randomUUID } from 'node:crypto'

import { Router } from 'express'
import { z } from 'zod'

import {
  deleteAccount,
  deleteCategory,
  deleteEntry,
  deleteTransfer,
  findAccount,
  findEntry,
  insertAccount,
  insertCategory,
  insertEntry,
  listAccounts,
  listCategories,
  listEntries,
  summary,
  updateAccount,
  updateCategory,
} from './model.js'
import { query } from '../../config/database.js'
import { ApiError } from '../../lib/ApiError.js'
import {
  paginationMeta,
  readPagination,
  sendCreated,
  sendData,
  sendList,
  sendNoContent,
} from '../../lib/http.js'
import { requirePermission } from '../../middleware/auth.js'
import { getQuery, validate } from '../../middleware/validate.js'

/**
 * Comptabilité — réservée à l'administratrice.
 *
 * Le garde est posé une seule fois, sur le préfixe : aucune route de ce
 * module ne peut être ajoutée plus tard en oubliant de la protéger.
 */
export const adminRouter = Router()

adminRouter.use('/accounting', requirePermission('accounting'))

const idParam = z.object({ id: z.coerce.number().int().positive() })
const aujourdhui = () => new Date().toISOString().slice(0, 10)

/* ═══════════════════════════════ Synthèse ═════════════════════════════ */

adminRouter.get(
  '/accounting/summary',
  validate({ query: z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }) }),
  async (request, response) => sendData(response, await summary(getQuery(request))),
)

/* ═══════════════════════════════ Comptes ══════════════════════════════ */

const accountBody = z.object({
  kind: z.enum(['cash', 'bank']).optional(),
  name: z.string().trim().min(2).max(120),
  bankName: z.string().trim().max(120).nullish(),
  accountNumber: z.string().trim().max(60).nullish(),
  note: z.string().trim().max(255).nullish(),
  isActive: z.boolean().optional(),
  position: z.coerce.number().int().min(0).max(999).optional(),
})

adminRouter.get('/accounting/accounts', async (_request, response) =>
  sendList(response, await listAccounts()),
)

adminRouter.post(
  '/accounting/accounts',
  validate({ body: accountBody }),
  async (request, response) => {
    /*
     * Une seule caisse. Tous les encaissements y entrent, et deux caisses
     * rendraient la question « où est l'argent liquide ? » sans réponse.
     * Les comptes bancaires, eux, sont libres.
     */
    if (request.body.kind === 'cash') {
      const [{ total }] = await query("SELECT COUNT(*) AS total FROM cash_accounts WHERE kind = 'cash'")
      if (Number(total) > 0) {
        throw ApiError.conflict('La caisse existe déjà. Créez plutôt un compte bancaire.')
      }
    }
    if (request.body.kind !== 'cash' && !request.body.bankName) {
      throw ApiError.unprocessable('Indiquez le nom de la banque.')
    }

    try {
      return sendCreated(response, await insertAccount(request.body))
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw ApiError.conflict('Ce numéro de compte existe déjà pour cette banque.')
      }
      throw error
    }
  },
)

adminRouter.patch(
  '/accounting/accounts/:id',
  validate({ params: idParam, body: accountBody.partial() }),
  async (request, response) => {
    const compte = await findAccount(request.params.id)
    if (!compte) throw ApiError.notFound('Ce compte n’existe pas.')

    try {
      return sendData(response, await updateAccount(compte.id, request.body))
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw ApiError.conflict('Ce numéro de compte existe déjà pour cette banque.')
      }
      throw error
    }
  },
)

adminRouter.delete(
  '/accounting/accounts/:id',
  validate({ params: idParam }),
  async (request, response) => {
    const compte = await findAccount(request.params.id)
    if (!compte) throw ApiError.notFound('Ce compte n’existe pas.')
    if (compte.kind === 'cash') {
      throw ApiError.conflict('La caisse ne peut pas être supprimée : tous les encaissements y entrent.')
    }
    if (compte.entries > 0) {
      throw ApiError.conflict(
        `Ce compte porte ${compte.entries} écriture(s). Désactivez-le plutôt que de le supprimer.`,
      )
    }

    await deleteAccount(compte.id)
    return sendNoContent(response)
  },
)

/* ═════════════════════════ Catégories de dépenses ═════════════════════ */

adminRouter.get('/accounting/categories', async (_request, response) =>
  sendList(response, await listCategories()),
)

adminRouter.post(
  '/accounting/categories',
  validate({ body: z.object({ name: z.string().trim().min(2).max(120), position: z.coerce.number().int().min(0).max(999).optional() }) }),
  async (request, response) => {
    try {
      return sendCreated(response, await insertCategory(request.body))
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw ApiError.conflict('Cette catégorie existe déjà.')
      throw error
    }
  },
)

adminRouter.patch(
  '/accounting/categories/:id',
  validate({
    params: idParam,
    body: z.object({
      name: z.string().trim().min(2).max(120).optional(),
      isActive: z.boolean().optional(),
      position: z.coerce.number().int().min(0).max(999).optional(),
    }),
  }),
  async (request, response) => {
    const categorie = await updateCategory(request.params.id, request.body)
    if (!categorie) throw ApiError.notFound('Cette catégorie n’existe pas.')
    return sendData(response, categorie)
  },
)

adminRouter.delete(
  '/accounting/categories/:id',
  validate({ params: idParam }),
  async (request, response) => {
    const [{ total }] = await query(
      'SELECT COUNT(*) AS total FROM ledger_entries WHERE category_id = ?',
      [request.params.id],
    )
    if (Number(total) > 0) {
      throw ApiError.conflict(
        `Cette catégorie est utilisée par ${total} dépense(s). Désactivez-la plutôt.`,
      )
    }
    if (!(await deleteCategory(request.params.id))) {
      throw ApiError.notFound('Cette catégorie n’existe pas.')
    }
    return sendNoContent(response)
  },
)

/* ═══════════════════════════════ Écritures ════════════════════════════ */

const entriesQuery = z.object({
  accountId: z.coerce.number().int().positive().optional(),
  kind: z.enum(['payment', 'expense', 'transfer', 'adjustment']).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  search: z.string().max(120).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
})

adminRouter.get(
  '/accounting/entries',
  validate({ query: entriesQuery }),
  async (request, response) => {
    const filters = getQuery(request)
    const pagination = readPagination({ query: filters })
    const { total, rows } = await listEntries({ ...filters, ...pagination })
    return response.json({ success: true, data: rows, meta: paginationMeta(pagination, total) })
  },
)

/* ── Dépense ── */

adminRouter.post(
  '/accounting/expenses',
  validate({
    body: z.object({
      accountId: z.coerce.number().int().positive(),
      categoryId: z.coerce.number().int().positive().nullish(),
      amount: z.coerce.number().positive('Le montant doit être supérieur à zéro.'),
      label: z.string().trim().min(2).max(255),
      occurredOn: z.iso.date().optional(),
    }),
  }),
  async (request, response) => {
    const compte = await findAccount(request.body.accountId)
    if (!compte) throw ApiError.unprocessable('Ce compte n’existe pas.')
    if (!compte.isActive) throw ApiError.unprocessable('Ce compte est désactivé.')

    const montant = Math.round(Number(request.body.amount) * 100) / 100

    /*
     * On refuse de descendre un compte sous zéro. Une caisse négative n'existe
     * pas dans la réalité : c'est toujours le signe d'une saisie oubliée ou
     * d'une erreur de montant, et mieux vaut le dire tout de suite.
     */
    if (montant > compte.balance) {
      throw ApiError.unprocessable(
        `Solde insuffisant : ${compte.name} ne contient que ${compte.balance} FCFA.`,
      )
    }

    const id = await insertEntry(
      {
        accountId: compte.id,
        kind: 'expense',
        direction: 'out',
        amount: montant,
        label: request.body.label,
        occurredOn: request.body.occurredOn ?? aujourdhui(),
        categoryId: request.body.categoryId ?? null,
      },
      request.user,
    )

    return sendCreated(response, await findEntry(id))
  },
)

/* ── Transfert ── */

adminRouter.post(
  '/accounting/transfers',
  validate({
    body: z.object({
      fromAccountId: z.coerce.number().int().positive(),
      toAccountId: z.coerce.number().int().positive(),
      amount: z.coerce.number().positive(),
      label: z.string().trim().max(255).nullish(),
      occurredOn: z.iso.date().optional(),
    }),
  }),
  async (request, response) => {
    const { fromAccountId, toAccountId } = request.body
    if (fromAccountId === toAccountId) {
      throw ApiError.unprocessable('Les deux comptes doivent être différents.')
    }

    const [source, destination] = await Promise.all([
      findAccount(fromAccountId),
      findAccount(toAccountId),
    ])
    if (!source || !destination) throw ApiError.unprocessable('Compte introuvable.')
    if (!source.isActive || !destination.isActive) {
      throw ApiError.unprocessable('Un des deux comptes est désactivé.')
    }

    const montant = Math.round(Number(request.body.amount) * 100) / 100
    if (montant > source.balance) {
      throw ApiError.unprocessable(
        `Solde insuffisant : ${source.name} ne contient que ${source.balance} FCFA.`,
      )
    }

    /*
     * Un transfert, c'est deux écritures qui ne valent rien l'une sans
     * l'autre. La référence commune les relie : l'écran les affiche comme une
     * seule opération, et les annuler retire bien les deux.
     */
    const reference = randomUUID().slice(0, 16)
    const quand = request.body.occurredOn ?? aujourdhui()
    const intitule = request.body.label || `${source.name} → ${destination.name}`

    await insertEntry(
      {
        accountId: source.id,
        kind: 'transfer',
        direction: 'out',
        amount: montant,
        label: intitule,
        occurredOn: quand,
        transferRef: reference,
      },
      request.user,
    )
    await insertEntry(
      {
        accountId: destination.id,
        kind: 'transfer',
        direction: 'in',
        amount: montant,
        label: intitule,
        occurredOn: quand,
        transferRef: reference,
      },
      request.user,
    )

    return sendCreated(response, {
      transferRef: reference,
      amount: montant,
      from: { id: source.id, name: source.name },
      to: { id: destination.id, name: destination.name },
      occurredOn: quand,
    })
  },
)

/* ── Annulation ── */

adminRouter.delete(
  '/accounting/entries/:id',
  validate({ params: idParam }),
  async (request, response) => {
    const ecriture = await findEntry(request.params.id)
    if (!ecriture) throw ApiError.notFound('Cette écriture n’existe pas.')

    /*
     * Un encaissement ne s'annule pas d'ici : il appartient au rendez-vous
     * qui l'a produit, et c'est en annulant le versement, sur la fiche, que
     * la caisse se corrige. Autrement la caisse et les reçus diraient deux
     * choses différentes.
     */
    if (ecriture.kind === 'payment') {
      throw ApiError.conflict(
        'Un encaissement s’annule depuis la fiche du rendez-vous, en retirant le versement.',
      )
    }

    if (ecriture.transferRef) {
      const retirees = await deleteTransfer(ecriture.transferRef)
      return sendData(response, { deleted: retirees, transferRef: ecriture.transferRef })
    }

    await deleteEntry(ecriture.id)
    return sendNoContent(response)
  },
)
