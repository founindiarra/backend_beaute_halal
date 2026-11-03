import { query } from '../../config/database.js'
import { getSettings } from '../salon/model.js'
import { listAccounts, listEntries } from './model.js'
import { CHARTE, formatDate, formatDateTime, formatMoney, marque } from '../../lib/pdf.js'
import PDFDocument from 'pdfkit'

/**
 * Rapport de comptabilité d'une période : tout ce qu'il faut pour arrêter les comptes.
 *
 *  – synthèse (encaissé, dépensé, résultat, transferts) et soldes des comptes ;
 *  – activité : rendez-vous par statut, chiffre d'affaires des prestations terminées, remises, restes à encaisser ;
 *  – répartition par prestation, par agent, par jour, par catégorie de dépenses ;
 *  – détail des encaissements, des dépenses et des restes à encaisser.
 *
 * Même source que l'écran Comptabilité (le grand livre `ledger_entries`) : rien n'est recalculé à part.
 */

const num = (v) => Number(v ?? 0)
const TERMINES = ['completed']

export async function buildReport({ from, to }) {
  const bornes = []
  const params = []
  if (from) { bornes.push('l.occurred_on >= ?'); params.push(from) }
  if (to) { bornes.push('l.occurred_on <= ?'); params.push(to) }
  const where = bornes.length ? `WHERE ${bornes.join(' AND ')}` : ''
  const andWhere = bornes.length ? `AND ${bornes.join(' AND ')}` : ''

  const rdvBornes = []
  const rdvParams = []
  if (from) { rdvBornes.push('a.appointment_date >= ?'); rdvParams.push(from) }
  if (to) { rdvBornes.push('a.appointment_date <= ?'); rdvParams.push(to) }
  const rdvWhere = rdvBornes.length ? `AND ${rdvBornes.join(' AND ')}` : ''

  const [settings, comptes, totaux] = await Promise.all([
    getSettings(),
    listAccounts(),
    query(
      `SELECT COALESCE(SUM(IF(l.kind = 'payment', l.amount, 0)), 0) AS encaisse,
              COALESCE(SUM(IF(l.kind = 'expense', l.amount, 0)), 0) AS depense,
              COALESCE(SUM(IF(l.kind = 'transfer' AND l.direction = 'out', l.amount, 0)), 0) AS transfere,
              COALESCE(SUM(IF(l.kind = 'adjustment', IF(l.direction = 'in', l.amount, -l.amount), 0)), 0) AS regul,
              COUNT(*) AS ecritures
         FROM ledger_entries l ${where}`,
      params,
    ),
  ])

  const mouvements = await query(
    `SELECT l.account_id, COALESCE(SUM(IF(l.direction = 'in', l.amount, 0)), 0) AS entrees,
            COALESCE(SUM(IF(l.direction = 'out', l.amount, 0)), 0) AS sorties
       FROM ledger_entries l ${where} GROUP BY l.account_id`,
    params,
  )
  const parCompte = new Map(mouvements.map((m) => [m.account_id, m]))

  const parCategorie = await query(
    `SELECT COALESCE(c.name, 'Sans catégorie') AS name, COALESCE(SUM(l.amount), 0) AS total, COUNT(*) AS nombre
       FROM ledger_entries l LEFT JOIN expense_categories c ON c.id = l.category_id
      WHERE l.kind = 'expense' ${andWhere}
      GROUP BY COALESCE(c.name, 'Sans catégorie') ORDER BY total DESC`,
    params,
  )

  const parJour = await query(
    `SELECT l.occurred_on AS jour,
            COALESCE(SUM(IF(l.kind = 'payment', l.amount, 0)), 0) AS encaisse,
            COALESCE(SUM(IF(l.kind = 'expense', l.amount, 0)), 0) AS depense
       FROM ledger_entries l ${where} GROUP BY l.occurred_on ORDER BY l.occurred_on`,
    params,
  )

  const [statuts, ca, parPrestation, parAgent, restes] = await Promise.all([
    query(`SELECT a.status, COUNT(*) AS nombre FROM appointments a WHERE 1 = 1 ${rdvWhere} GROUP BY a.status`, rdvParams),
    query(
      `SELECT COUNT(*) AS nombre,
              COALESCE(SUM(a.price), 0) AS brut,
              COALESCE(SUM(LEAST(a.discount_amount, a.price)), 0) AS remises,
              COALESCE(SUM((SELECT COALESCE(SUM(p.amount), 0) FROM appointment_payments p WHERE p.appointment_id = a.id)), 0) AS paye
         FROM appointments a WHERE a.status = 'completed' ${rdvWhere}`,
      rdvParams,
    ),
    query(
      `SELECT a.service_name AS name, COUNT(*) AS nombre,
              COALESCE(SUM(a.price - LEAST(a.discount_amount, a.price)), 0) AS total
         FROM appointments a WHERE a.status = 'completed' ${rdvWhere}
        GROUP BY a.service_name ORDER BY total DESC LIMIT 30`,
      rdvParams,
    ),
    query(
      `SELECT t.name AS name, COUNT(*) AS nombre,
              COALESCE(SUM(a.price - LEAST(a.discount_amount, a.price)), 0) AS total
         FROM appointments a JOIN team_members t ON t.id = a.staff_id
        WHERE a.status = 'completed' ${rdvWhere}
        GROUP BY t.id, t.name ORDER BY total DESC`,
      rdvParams,
    ),
    query(
      `SELECT a.reference, a.first_name, a.last_name, a.appointment_date AS date, a.status, a.service_name,
              (a.price - LEAST(a.discount_amount, a.price)) AS du,
              (SELECT COALESCE(SUM(p.amount), 0) FROM appointment_payments p WHERE p.appointment_id = a.id) AS paye
         FROM appointments a
        WHERE a.status IN ('arrived', 'in_progress', 'completed') ${rdvWhere}
       HAVING du - paye > 0
        ORDER BY a.appointment_date DESC LIMIT 200`,
      rdvParams,
    ),
  ])

  const [encaissements, depenses] = await Promise.all([
    listEntries({ kind: 'payment', from, to, limit: 2000, offset: 0 }),
    listEntries({ kind: 'expense', from, to, limit: 2000, offset: 0 }),
  ])

  const t = totaux[0]
  const c = ca[0]
  const brut = num(c.brut)
  const remises = num(c.remises)
  return {
    generatedAt: new Date().toISOString(),
    period: { from: from ?? null, to: to ?? null },
    salon: {
      name: settings.name || 'Beauté Halal',
      specialty: settings.specialty || '',
      phone: settings.phone_display || '',
      email: settings.email || '',
      address: [settings.address_line1, settings.address_line2, settings.address_city].filter(Boolean).join(', '),
    },
    summary: {
      collected: num(t.encaisse),
      spent: num(t.depense),
      net: num(t.encaisse) - num(t.depense),
      transferred: num(t.transfere),
      adjustments: num(t.regul),
      entries: Number(t.ecritures) || 0,
      treasury: comptes.reduce((s, a) => s + a.balance, 0),
    },
    accounts: comptes.map((a) => ({
      name: a.name,
      kind: a.kind,
      balance: a.balance,
      in: num(parCompte.get(a.id)?.entrees),
      out: num(parCompte.get(a.id)?.sorties),
    })),
    expensesByCategory: parCategorie.map((r) => ({ name: r.name, total: num(r.total), count: Number(r.nombre) })),
    days: parJour.map((r) => ({ date: r.jour, collected: num(r.encaisse), spent: num(r.depense) })),
    appointments: {
      byStatus: Object.fromEntries(statuts.map((r) => [r.status, Number(r.nombre)])),
      completed: Number(c.nombre) || 0,
      gross: brut,
      discounts: remises,
      revenue: brut - remises,
      paid: num(c.paye),
      outstanding: restes.reduce((s, r) => s + Math.max(num(r.du) - num(r.paye), 0), 0),
    },
    byService: parPrestation.map((r) => ({ name: r.name, count: Number(r.nombre), total: num(r.total) })),
    byAgent: parAgent.map((r) => ({ name: r.name, count: Number(r.nombre), total: num(r.total) })),
    outstanding: restes.map((r) => ({
      reference: r.reference,
      customer: `${r.first_name} ${r.last_name}`.trim(),
      date: r.date,
      status: r.status,
      service: r.service_name,
      due: num(r.du),
      paid: num(r.paye),
      balance: num(r.du) - num(r.paye),
    })),
    payments: encaissements.rows.map((e) => ({
      date: e.occurredOn, label: e.label, reference: e.appointment?.reference ?? '', account: e.account.name, by: e.recordedByName, amount: e.amount,
    })),
    expenses: depenses.rows.map((e) => ({
      date: e.occurredOn, label: e.label, category: e.category?.name ?? 'Sans catégorie', account: e.account.name, by: e.recordedByName, amount: e.amount,
    })),
  }
}

/* ─────────────────────────────── CSV ─────────────────────────────── */

const cell = (v) => {
  const t = String(v ?? '')
  return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}
const ligneCsv = (...cols) => cols.map(cell).join(';')
const iso = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '')

/** Tableur (Excel français : séparateur « ; », UTF-8 avec BOM). */
export function reportToCsv(r) {
  const L = []
  L.push(ligneCsv('RAPPORT DE COMPTABILITÉ', r.salon.name))
  L.push(ligneCsv('Période', iso(r.period.from) || 'début', iso(r.period.to) || 'aujourd’hui'))
  L.push(ligneCsv('Établi le', r.generatedAt.slice(0, 16).replace('T', ' ')))
  L.push('')
  L.push(ligneCsv('SYNTHÈSE'))
  L.push(ligneCsv('Encaissé', r.summary.collected))
  L.push(ligneCsv('Dépensé', r.summary.spent))
  L.push(ligneCsv('Résultat', r.summary.net))
  L.push(ligneCsv('Transferts', r.summary.transferred))
  L.push(ligneCsv('Trésorerie actuelle', r.summary.treasury))
  L.push('')
  L.push(ligneCsv('COMPTES', 'Entrées', 'Sorties', 'Solde actuel'))
  for (const a of r.accounts) L.push(ligneCsv(a.name, a.in, a.out, a.balance))
  L.push('')
  L.push(ligneCsv('ACTIVITÉ'))
  L.push(ligneCsv('Prestations terminées', r.appointments.completed))
  L.push(ligneCsv('Chiffre d’affaires brut', r.appointments.gross))
  L.push(ligneCsv('Remises', r.appointments.discounts))
  L.push(ligneCsv('Chiffre d’affaires net', r.appointments.revenue))
  L.push(ligneCsv('Reste à encaisser', r.appointments.outstanding))
  L.push('')
  L.push(ligneCsv('PAR PRESTATION', 'Nombre', 'Total'))
  for (const s of r.byService) L.push(ligneCsv(s.name, s.count, s.total))
  L.push('')
  L.push(ligneCsv('PAR AGENT', 'Nombre', 'Total'))
  for (const s of r.byAgent) L.push(ligneCsv(s.name, s.count, s.total))
  L.push('')
  L.push(ligneCsv('DÉPENSES PAR CATÉGORIE', 'Nombre', 'Total'))
  for (const s of r.expensesByCategory) L.push(ligneCsv(s.name, s.count, s.total))
  L.push('')
  L.push(ligneCsv('PAR JOUR', 'Encaissé', 'Dépensé'))
  for (const d of r.days) L.push(ligneCsv(iso(d.date), d.collected, d.spent))
  L.push('')
  L.push(ligneCsv('ENCAISSEMENTS', 'Date', 'Référence', 'Compte', 'Enregistré par', 'Montant'))
  for (const p of r.payments) L.push(ligneCsv(p.label, iso(p.date), p.reference, p.account, p.by, p.amount))
  L.push('')
  L.push(ligneCsv('DÉPENSES', 'Date', 'Catégorie', 'Compte', 'Enregistré par', 'Montant'))
  for (const e of r.expenses) L.push(ligneCsv(e.label, iso(e.date), e.category, e.account, e.by, e.amount))
  L.push('')
  L.push(ligneCsv('RESTES À ENCAISSER', 'Référence', 'Date', 'Prestation', 'Dû', 'Payé', 'Reste'))
  for (const o of r.outstanding) L.push(ligneCsv(o.customer, o.reference, iso(o.date), o.service, o.due, o.paid, o.balance))
  return `﻿${L.join('\r\n')}\r\n`
}

/* ─────────────────────────────── PDF ─────────────────────────────── */

const STATUTS = { pending: 'En attente', contacted: 'Contactée', confirmed: 'Confirmés', arrived: 'Arrivées', in_progress: 'En cours', completed: 'Terminés', cancelled: 'Annulés', rejected: 'Refusés', no_show: 'Non honorés' }

export function renderReportPdf(r) {
  const { BRUN, OR, OR_CLAIR, SABLE, ENCRE, GRIS, LIGNE, CREME, IVOIRE, PAGE_L, PAGE_H, MARGE, UTILE, POLICES } = CHARTE
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true })
    const morceaux = []
    doc.on('data', (m) => morceaux.push(m))
    doc.on('end', () => resolve(Buffer.concat(morceaux)))
    doc.on('error', reject)
    for (const [nom, fichier] of Object.entries(POLICES)) doc.registerFont(nom, fichier)

    const BAS = PAGE_H - 56
    let y = 0
    const fond = () => doc.rect(0, 0, PAGE_L, PAGE_H).fill(CREME)
    const periode = `du ${r.period.from ? formatDate(r.period.from) : 'début'} au ${r.period.to ? formatDate(r.period.to) : 'jour'}`

    const entete = () => {
      fond()
      doc.rect(0, 0, PAGE_L, 92).fill(BRUN)
      doc.rect(0, 92, PAGE_L, 3).fill(OR)
      marque(doc, MARGE + 26, 46, 26)
      doc.fillColor(CREME).font('Display-Bold').fontSize(19).text(r.salon.name.toUpperCase(), MARGE + 66, 24, { characterSpacing: 2, lineBreak: false })
      doc.font('Jost').fontSize(7.5).fillColor(OR_CLAIR).text('RAPPORT DE COMPTABILITÉ', MARGE + 66, 50, { characterSpacing: 2.2, lineBreak: false })
      doc.font('Jost').fontSize(8).fillColor('#e8dccb').text(`Période ${periode}`, MARGE + 66, 64, { lineBreak: false })
      doc.font('Jost').fontSize(7.5).fillColor('#e8dccb').text(`Établi le ${formatDateTime(r.generatedAt)}`, PAGE_L - MARGE - 200, 30, { width: 200, align: 'right', lineBreak: false })
      y = 116
    }
    const saut = (besoin) => {
      if (y + besoin <= BAS) return
      doc.addPage()
      entete()
    }
    const titre = (texte) => {
      saut(40)
      doc.font('Jost-SemiBold').fontSize(8).fillColor(OR).text(texte.toUpperCase(), MARGE, y, { characterSpacing: 1.8, lineBreak: false })
      doc.moveTo(MARGE, y + 13).lineTo(MARGE + UTILE, y + 13).lineWidth(0.5).strokeColor(LIGNE).stroke()
      y += 22
    }

    /** Tableau : colonnes [{ label, width, align }], lignes de tableaux de textes. */
    const tableau = (colonnes, lignes, { total = null } = {}) => {
      const dessineEntete = () => {
        doc.rect(MARGE, y, UTILE, 18).fill(BRUN)
        let x = MARGE
        doc.font('Jost-SemiBold').fontSize(7).fillColor(CREME)
        for (const c of colonnes) {
          doc.text(c.label.toUpperCase(), x + 6, y + 6, { width: c.width - 12, align: c.align ?? 'left', characterSpacing: 0.8, lineBreak: false })
          x += c.width
        }
        y += 18
      }
      saut(18 + 20)
      dessineEntete()
      lignes.forEach((ligne, i) => {
        if (y + 17 > BAS) {
          doc.addPage()
          entete()
          dessineEntete()
        }
        if (i % 2 === 0) doc.rect(MARGE, y, UTILE, 17).fill(IVOIRE)
        let x = MARGE
        doc.font('Jost').fontSize(8).fillColor(ENCRE)
        colonnes.forEach((c, k) => {
          doc.text(String(ligne[k] ?? ''), x + 6, y + 5, { width: c.width - 12, align: c.align ?? 'left', lineBreak: false, ellipsis: true })
          x += c.width
        })
        y += 17
      })
      if (total) {
        saut(20)
        doc.moveTo(MARGE, y + 1).lineTo(MARGE + UTILE, y + 1).lineWidth(0.8).strokeColor(SABLE).stroke()
        let x = MARGE
        doc.font('Jost-SemiBold').fontSize(8.5).fillColor(BRUN)
        colonnes.forEach((c, k) => {
          doc.text(String(total[k] ?? ''), x + 6, y + 6, { width: c.width - 12, align: c.align ?? 'left', lineBreak: false })
          x += c.width
        })
        y += 20
      }
      y += 16
    }

    const vide = (texte) => {
      saut(24)
      doc.font('Jost').fontSize(8.5).fillColor(GRIS).text(texte, MARGE, y, { lineBreak: false })
      y += 22
    }

    entete()

    /* Synthèse : quatre cartes */
    const cartes = [
      ['Encaissé', formatMoney(r.summary.collected)],
      ['Dépensé', formatMoney(r.summary.spent)],
      ['Résultat', formatMoney(r.summary.net)],
      ['Trésorerie actuelle', formatMoney(r.summary.treasury)],
    ]
    const w = (UTILE - 18) / 4
    cartes.forEach(([libelle, valeur], i) => {
      const x = MARGE + i * (w + 6)
      doc.roundedRect(x, y, w, 52, 6).fillAndStroke(IVOIRE, LIGNE)
      doc.font('Jost').fontSize(7).fillColor(GRIS).text(libelle.toUpperCase(), x + 10, y + 11, { width: w - 20, characterSpacing: 1, lineBreak: false })
      doc.font('Display-Bold').fontSize(14).fillColor(BRUN).text(valeur, x + 10, y + 27, { width: w - 20, lineBreak: false })
    })
    y += 70

    titre('Comptes')
    tableau(
      [{ label: 'Compte', width: UTILE - 3 * 110 }, { label: 'Entrées', width: 110, align: 'right' }, { label: 'Sorties', width: 110, align: 'right' }, { label: 'Solde actuel', width: 110, align: 'right' }],
      r.accounts.map((a) => [a.name, formatMoney(a.in), formatMoney(a.out), formatMoney(a.balance)]),
    )

    titre('Activité de la période')
    const A = r.appointments
    tableau(
      [{ label: 'Indicateur', width: UTILE - 150 }, { label: 'Valeur', width: 150, align: 'right' }],
      [
        ['Prestations terminées', A.completed],
        ['Chiffre d’affaires brut', formatMoney(A.gross)],
        ['Remises accordées', formatMoney(A.discounts)],
        ['Chiffre d’affaires net', formatMoney(A.revenue)],
        ['Déjà encaissé sur ces prestations', formatMoney(A.paid)],
        ['Reste à encaisser', formatMoney(A.outstanding)],
        ['Transferts entre comptes', formatMoney(r.summary.transferred)],
        ['Régularisations', formatMoney(r.summary.adjustments)],
      ],
    )
    const statuts = Object.entries(A.byStatus).map(([k, v]) => [STATUTS[k] ?? k, v])
    if (statuts.length) {
      titre('Rendez-vous par statut')
      tableau([{ label: 'Statut', width: UTILE - 150 }, { label: 'Nombre', width: 150, align: 'right' }], statuts)
    }

    titre('Prestations terminées, par type')
    if (r.byService.length) {
      tableau(
        [{ label: 'Prestation', width: UTILE - 230 }, { label: 'Nombre', width: 80, align: 'right' }, { label: 'Total net', width: 150, align: 'right' }],
        r.byService.map((s) => [s.name, s.count, formatMoney(s.total)]),
      )
    } else vide('Aucune prestation terminée sur la période.')

    titre('Par agent / coiffeuse (agent principal)')
    if (r.byAgent.length) {
      tableau(
        [{ label: 'Agent', width: UTILE - 230 }, { label: 'Prestations', width: 80, align: 'right' }, { label: 'Total net', width: 150, align: 'right' }],
        r.byAgent.map((s) => [s.name, s.count, formatMoney(s.total)]),
      )
    } else vide('Aucune prestation terminée avec un agent sur la période.')

    titre('Dépenses par catégorie')
    if (r.expensesByCategory.length) {
      tableau(
        [{ label: 'Catégorie', width: UTILE - 230 }, { label: 'Nombre', width: 80, align: 'right' }, { label: 'Total', width: 150, align: 'right' }],
        r.expensesByCategory.map((s) => [s.name, s.count, formatMoney(s.total)]),
        { total: ['Total', r.expensesByCategory.reduce((n, s) => n + s.count, 0), formatMoney(r.summary.spent)] },
      )
    } else vide('Aucune dépense sur la période.')

    titre('Jour par jour')
    if (r.days.length) {
      tableau(
        [{ label: 'Date', width: UTILE - 3 * 110 }, { label: 'Encaissé', width: 110, align: 'right' }, { label: 'Dépensé', width: 110, align: 'right' }, { label: 'Résultat', width: 110, align: 'right' }],
        r.days.map((d) => [formatDate(d.date), formatMoney(d.collected), formatMoney(d.spent), formatMoney(d.collected - d.spent)]),
        { total: ['Total', formatMoney(r.summary.collected), formatMoney(r.summary.spent), formatMoney(r.summary.net)] },
      )
    } else vide('Aucun mouvement sur la période.')

    titre('Encaissements')
    if (r.payments.length) {
      tableau(
        [{ label: 'Date', width: 62 }, { label: 'Libellé', width: UTILE - 62 - 70 - 90 - 96 }, { label: 'Réf.', width: 70 }, { label: 'Par', width: 90 }, { label: 'Montant', width: 96, align: 'right' }],
        r.payments.map((p) => [formatDate(p.date), p.label, p.reference, p.by, formatMoney(p.amount)]),
        { total: ['', 'Total encaissé', '', '', formatMoney(r.summary.collected)] },
      )
    } else vide('Aucun encaissement sur la période.')

    titre('Dépenses')
    if (r.expenses.length) {
      tableau(
        [{ label: 'Date', width: 62 }, { label: 'Libellé', width: UTILE - 62 - 100 - 90 - 96 }, { label: 'Catégorie', width: 100 }, { label: 'Par', width: 90 }, { label: 'Montant', width: 96, align: 'right' }],
        r.expenses.map((e) => [formatDate(e.date), e.label, e.category, e.by, formatMoney(e.amount)]),
        { total: ['', 'Total dépensé', '', '', formatMoney(r.summary.spent)] },
      )
    } else vide('Aucune dépense sur la période.')

    titre('Restes à encaisser')
    if (r.outstanding.length) {
      tableau(
        [{ label: 'Réf.', width: 66 }, { label: 'Cliente', width: 120 }, { label: 'Date', width: 62 }, { label: 'Dû', width: 80, align: 'right' }, { label: 'Payé', width: 80, align: 'right' }, { label: 'Reste', width: UTILE - 66 - 120 - 62 - 160, align: 'right' }],
        r.outstanding.map((o) => [o.reference, o.customer, formatDate(o.date), formatMoney(o.due), formatMoney(o.paid), formatMoney(o.balance)]),
        { total: ['', 'Total', '', '', '', formatMoney(A.outstanding)] },
      )
    } else vide('Aucun reste à encaisser sur la période.')

    /* Pied de page, sur toutes les pages */
    const total = doc.bufferedPageRange().count
    for (let i = 0; i < total; i += 1) {
      doc.switchToPage(i)
      doc.moveTo(MARGE, PAGE_H - 40).lineTo(PAGE_L - MARGE, PAGE_H - 40).lineWidth(0.5).strokeColor(SABLE).stroke()
      doc.font('Jost').fontSize(7.5).fillColor(GRIS).text(`${r.salon.name} · rapport de comptabilité · ${periode}`, MARGE, PAGE_H - 32, { width: UTILE - 60, lineBreak: false })
      doc.text(`Page ${i + 1} / ${total}`, PAGE_L - MARGE - 60, PAGE_H - 32, { width: 60, align: 'right', lineBreak: false })
    }
    doc.end()
  })
}
