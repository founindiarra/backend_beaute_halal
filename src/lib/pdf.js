import PDFDocument from 'pdfkit'

/**
 * Mise en page des documents du salon : proforma et reçu.
 *
 * Un seul gabarit pour les deux — même bandeau, mêmes cartes, même pied.
 * Seuls le titre, la mention d'avertissement et le bloc financier changent :
 *   – le proforma détaille le calcul du montant à payer ;
 *   – le reçu ne montre que les versements enregistrés.
 *
 * Tout tient sur UNE page A4. Les polices sont celles intégrées au format PDF
 * (Helvetica et Times) : aucun fichier à déployer, et l'encodage WinAnsi
 * couvre les accents français.
 */

const BRUN = '#58301a'
const BRUN_CLAIR = '#7c4527'
const OR = '#b08a57'
const OR_CLAIR = '#cbac81'
const ENCRE = '#3a2113'
const GRIS = '#7d6b5d'
const LIGNE = '#e6dcd1'
const CREME = '#fdfbf7'
const IVOIRE = '#f8f2e9'

const PAGE_L = 595.28
const PAGE_H = 841.89
const MARGE = 44
const UTILE = PAGE_L - MARGE * 2

/**
 * « 20 000 FCFA ».
 *
 * `Intl` sépare les milliers par une espace fine insécable (U+202F). Les
 * polices intégrées au PDF ne connaissent pas ce caractère et l'impriment en
 * barre oblique : « 20/000 FCFA ». On le ramène donc à une espace ordinaire —
 * c'est le seul endroit où ce remplacement est nécessaire, et l'oublier se
 * voit immédiatement sur le reçu.
 */
const formatMoney = (value, currency = 'FCFA') => {
  const nombre = new Intl.NumberFormat('fr-FR')
    .format(Math.round(Number(value ?? 0)))
    .replace(/[  ]/g, ' ')
  return `${nombre} ${currency}`
}

const formatDate = (value) => {
  if (!value) return '—'
  const text = String(value)
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (match) return `${match[3]}/${match[2]}/${match[1]}`
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('fr-FR')
}

const formatDateTime = (value) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.toLocaleDateString('fr-FR')} à ${date.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  })}`
}

const formatDuration = (minutes) => {
  if (!minutes) return '—'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `${rest} min`
  if (!rest) return `${hours} h`
  return `${hours} h ${String(rest).padStart(2, '0')}`
}

const methodLabel = (method) => (method === 'cash' ? 'Espèces' : method || '—')

const REDUCTION_LABELS = {
  loyalty: 'Fidélité',
  relationship: 'Relation client',
  gesture: 'Geste commercial',
  partnership: 'Partenariat',
  other: 'Autre',
}

/* ───────────────────────────── Briques ──────────────────────────────── */

/** La marque : trois locks sous une courbe, dans un médaillon. */
function marque(doc, cx, cy, rayon) {
  doc.save()
  doc.circle(cx, cy, rayon).lineWidth(1).strokeColor(OR_CLAIR).stroke()
  doc.circle(cx, cy, rayon - 3.5).lineWidth(0.4).strokeColor(OR).stroke()

  const echelle = (rayon * 1.05) / 18
  doc.translate(cx - 16 * echelle, cy - 18 * echelle).scale(echelle)
  doc.lineCap('round').strokeColor(OR_CLAIR)
  doc.lineWidth(1.8).path('M5 11.5C8.5 4.5 23.5 4.5 27 11.5').stroke()
  doc.opacity(0.6).lineWidth(3).path('M9 13.5c-1 4 1 7 0 12').stroke()
  doc.path('M23 13.5c-1 4 1 7 0 12').stroke()
  doc.opacity(1).lineWidth(3.4).path('M16 11c-1.4 6 1.4 11 0 22').stroke()
  doc.restore()
}

function bandeau(doc, snapshot, titre, numero) {
  const { salon } = snapshot
  const HAUTEUR = 128

  doc.rect(0, 0, PAGE_L, HAUTEUR).fill(BRUN)
  doc.rect(0, HAUTEUR, PAGE_L, 3).fill(OR)

  marque(doc, MARGE + 28, 60, 28)

  const gauche = MARGE + 72
  doc
    .fillColor(CREME)
    .font('Times-Bold')
    .fontSize(21)
    .text((salon.name || 'Beauté Halal').toUpperCase(), gauche, 32, {
      width: 250,
      characterSpacing: 2.2,
      lineBreak: false,
    })

  if (salon.specialty) {
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor(OR_CLAIR)
      .text(salon.specialty.toUpperCase(), gauche, 58, {
        width: 250,
        characterSpacing: 2.4,
        lineBreak: false,
      })
  }

  const coordonnees = [salon.address, salon.phone, salon.email].filter(Boolean)
  if (coordonnees.length) {
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor('#e8dccb')
      .text(coordonnees.join('   ·   '), gauche, 78, { width: 270 })
  }

  const largeur = 200
  const droite = PAGE_L - MARGE - largeur
  doc
    .font('Times-Roman')
    .fontSize(titre.length > 6 ? 25 : 34)
    .fillColor(CREME)
    .text(titre.toUpperCase(), droite, titre.length > 6 ? 33 : 26, {
      width: largeur,
      align: 'right',
      characterSpacing: titre.length > 6 ? 3 : 5,
      lineBreak: false,
    })
  doc
    .font('Helvetica-Bold')
    .fontSize(9.5)
    .fillColor(OR_CLAIR)
    .text(numero, droite, 72, { width: largeur, align: 'right', characterSpacing: 1.2 })
  doc
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor('#e8dccb')
    .text(`Établi le ${formatDateTime(snapshot.issuedAt)}`, droite, 90, {
      width: largeur,
      align: 'right',
    })
}

/** Petit intitulé doré, en capitales espacées, avec filet. */
function intitule(doc, texte, x, y, largeur) {
  doc
    .font('Helvetica-Bold')
    .fontSize(7)
    .fillColor(OR)
    .text(texte.toUpperCase(), x, y, { width: largeur, characterSpacing: 1.8, lineBreak: false })
  doc
    .moveTo(x, y + 12)
    .lineTo(x + largeur, y + 12)
    .lineWidth(0.5)
    .strokeColor(LIGNE)
    .stroke()
  return y + 20
}

function carte(doc, x, y, largeur, hauteur, { remplissage = IVOIRE } = {}) {
  doc.roundedRect(x, y, largeur, hauteur, 6).fillAndStroke(remplissage, LIGNE)
}

/** « libellé » petit et gris, « valeur » plus grande en dessous. */
function champ(doc, libelle, valeur, x, y, largeur, { taille = 9.5, police = 'Helvetica' } = {}) {
  doc
    .font('Helvetica')
    .fontSize(7)
    .fillColor(GRIS)
    .text(libelle, x, y, { width: largeur, lineBreak: false })
  doc
    .font(police)
    .fontSize(taille)
    .fillColor(ENCRE)
    .text(valeur || '—', x, y + 10, { width: largeur, height: taille + 4, ellipsis: true })
}

/** Deux colonnes de champs. Renvoie l'ordonnée sous la dernière ligne. */
function grille(doc, paires, x, y, largeur, { pas = 30 } = {}) {
  const colonne = largeur / 2
  paires.forEach(([libelle, valeur], index) => {
    const cx = x + (index % 2) * colonne
    const cy = y + Math.floor(index / 2) * pas
    champ(doc, libelle, valeur, cx, cy, colonne - 12)
  })
  return y + Math.ceil(paires.length / 2) * pas
}

/** Le bloc de montants du proforma, aligné à droite. */
function comptes(doc, snapshot, y) {
  const { totals } = snapshot
  const devise = totals.currency
  const largeur = 240
  const x = PAGE_L - MARGE - largeur

  const ligne = (libelle, valeur, { gras = false, taille = 9.5 } = {}) => {
    doc
      .font(gras ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(taille)
      .fillColor(gras ? ENCRE : GRIS)
      .text(libelle, x + 14, y, { width: largeur - 130, lineBreak: false })
    doc
      .font(gras ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(taille)
      .fillColor(ENCRE)
      .text(valeur, x + largeur - 124, y, { width: 110, align: 'right', lineBreak: false })
    y += gras ? 22 : 17
  }

  const hauteur = totals.discount > 0 ? 92 : 72
  carte(doc, x, y - 12, largeur, hauteur)
  y += 2

  ligne('Montant de la prestation', formatMoney(totals.total, devise))
  if (totals.discount > 0) {
    const motif = REDUCTION_LABELS[snapshot.discount?.reason] ?? null
    ligne(motif ? `Réduction (${motif})` : 'Réduction', `- ${formatMoney(totals.discount, devise)}`)
  }
  doc
    .moveTo(x + 14, y + 1)
    .lineTo(x + largeur - 14, y + 1)
    .lineWidth(0.5)
    .strokeColor(OR_CLAIR)
    .stroke()
  y += 9
  ligne('Montant à payer', formatMoney(totals.payable, devise), { gras: true, taille: 11 })

  return y + 14
}

/**
 * Le détail des versements : date, qui l'a enregistré, mode de paiement,
 * montant payé. C'est tout ce que le reçu affiche côté argent.
 */
function tableauVersements(doc, snapshot, y) {
  const paiements = snapshot.payments ?? []
  if (!paiements.length) return y

  y = intitule(doc, 'Versements enregistrés', MARGE, y, UTILE)

  const colonnes = [
    { titre: 'Date', largeur: UTILE * 0.27 },
    { titre: 'Enregistré par', largeur: UTILE * 0.26 },
    { titre: 'Mode de paiement', largeur: UTILE * 0.25 },
    { titre: 'Montant payé', largeur: UTILE * 0.22, align: 'right' },
  ]

  doc.roundedRect(MARGE, y, UTILE, 26, 5).fill(BRUN)
  let x = MARGE + 12
  colonnes.forEach((colonne) => {
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(CREME)
      .text(colonne.titre.toUpperCase(), x, y + 9, {
        width: colonne.largeur - 24,
        align: colonne.align,
        characterSpacing: 0.8,
        lineBreak: false,
      })
    x += colonne.largeur
  })
  y += 32

  paiements.forEach((versement, index) => {
    if (index % 2 === 0) doc.roundedRect(MARGE, y - 4, UTILE, 26, 4).fill(IVOIRE)
    const valeurs = [
      formatDateTime(versement.createdAt),
      versement.recordedBy || '—',
      methodLabel(versement.method),
      formatMoney(versement.amount, snapshot.totals.currency),
    ]
    x = MARGE + 12
    colonnes.forEach((colonne, i) => {
      doc
        .font(i === 3 ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(8.8)
        .fillColor(ENCRE)
        .text(valeurs[i], x, y + 4, {
          width: colonne.largeur - 24,
          align: colonne.align,
          lineBreak: false,
          ellipsis: true,
        })
      x += colonne.largeur
    })
    y += 26
  })

  return y + 6
}

function pied(doc, snapshot, mention) {
  const y = PAGE_H - 78
  doc
    .moveTo(MARGE, y)
    .lineTo(PAGE_L - MARGE, y)
    .lineWidth(0.8)
    .strokeColor(OR_CLAIR)
    .stroke()

  doc
    .font('Times-Italic')
    .fontSize(12.5)
    .fillColor(BRUN_CLAIR)
    .text(mention, MARGE, y + 12, { width: UTILE, align: 'center', lineBreak: false })

  doc
    .font('Helvetica')
    .fontSize(7)
    .fillColor(OR)
    .text((snapshot.salon.name || 'Beauté Halal').toUpperCase(), MARGE, y + 34, {
      width: UTILE,
      align: 'center',
      characterSpacing: 2.4,
      lineBreak: false,
    })
}

/* ──────────────────────────── Documents ─────────────────────────────── */

/**
 * Construit le PDF et le renvoie en mémoire. Le document tient sur une page :
 * l'assembler en mémoire évite de gérer un fichier temporaire, et la réponse
 * part d'un seul bloc.
 *
 * `margin: 0` : toutes les positions sont données à la main. Une marge basse
 * non nulle ferait passer le pied de page « hors zone » et PDFKit ouvrirait
 * une seconde page pour l'y écrire.
 */
export function renderDocument(snapshot, { numero }) {
  const recu = snapshot.kind === 'receipt'

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true })
    const morceaux = []
    doc.on('data', (morceau) => morceaux.push(morceau))
    doc.on('end', () => resolve(Buffer.concat(morceaux)))
    doc.on('error', reject)

    // Fond crème, puis filet intérieur discret.
    doc.rect(0, 0, PAGE_L, PAGE_H).fill(CREME)
    bandeau(doc, snapshot, recu ? 'Reçu' : 'Proforma', numero)
    doc
      .roundedRect(16, 16, PAGE_L - 32, PAGE_H - 32, 8)
      .lineWidth(0.5)
      .strokeColor(OR_CLAIR)
      .stroke()

    let y = 158

    /* ── Cliente et rendez-vous, côte à côte ── */
    const moitie = (UTILE - 14) / 2
    const hauteurCartes = 118
    const xDroite = MARGE + moitie + 14

    carte(doc, MARGE, y, moitie, hauteurCartes)
    let cy = intitule(doc, 'Cliente', MARGE + 14, y + 12, moitie - 28)
    doc
      .font('Times-Bold')
      .fontSize(16)
      .fillColor(BRUN)
      .text(`${snapshot.customer.firstName} ${snapshot.customer.lastName}`, MARGE + 14, cy, {
        width: moitie - 28,
        lineBreak: false,
        ellipsis: true,
      })
    champ(doc, 'Téléphone', snapshot.customer.phone, MARGE + 14, cy + 26, moitie - 28)
    champ(doc, 'E-mail', snapshot.customer.email, MARGE + 14, cy + 26 + 32, moitie - 28, { taille: 8.5 })

    carte(doc, xDroite, y, moitie, hauteurCartes)
    cy = intitule(doc, 'Rendez-vous', xDroite + 14, y + 12, moitie - 28)
    doc
      .font('Times-Bold')
      .fontSize(16)
      .fillColor(BRUN)
      .text(
        `${formatDate(snapshot.appointment.date)}  ·  ${snapshot.appointment.time || '—'}`,
        xDroite + 14,
        cy,
        { width: moitie - 28, lineBreak: false },
      )
    champ(doc, 'Référence', snapshot.appointment.reference, xDroite + 14, cy + 26, moitie - 28)
    champ(
      doc,
      'Durée',
      formatDuration(snapshot.appointment.durationMinutes),
      xDroite + 14,
      cy + 26 + 32,
      moitie - 28,
    )

    y += hauteurCartes + 28

    /* ── Prestation ── */
    y = intitule(doc, 'Prestation', MARGE, y, UTILE)
    doc
      .font('Times-Bold')
      .fontSize(18)
      .fillColor(BRUN)
      .text(snapshot.appointment.serviceName || '—', MARGE, y, {
        width: UTILE - 170,
        lineBreak: false,
        ellipsis: true,
      })
    doc
      .font('Times-Italic')
      .fontSize(11)
      .fillColor(GRIS)
      .text(snapshot.appointment.hairstyle || '', MARGE, y + 24, {
        width: UTILE - 170,
        lineBreak: false,
        ellipsis: true,
      })
    // Tarif de la prestation, à droite.
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor(GRIS)
      .text('TARIF', PAGE_L - MARGE - 160, y + 1, {
        width: 160,
        align: 'right',
        characterSpacing: 1.6,
        lineBreak: false,
      })
    doc
      .font('Times-Bold')
      .fontSize(18)
      .fillColor(BRUN)
      .text(formatMoney(snapshot.totals.total, snapshot.totals.currency), PAGE_L - MARGE - 160, y + 12, {
        width: 160,
        align: 'right',
        lineBreak: false,
      })
    y += 62

    /*
     * Deux personnes, deux lignes, jamais la même.
     *   – l'agent a réalisé la coiffure ;
     *   – l'utilisateur de validation a enregistré l'opération au dashboard.
     * Les confondre fausserait aussi bien le suivi du salon que la paie.
     */
    y = intitule(doc, 'Prise en charge', MARGE, y, UTILE)
    y = grille(
      doc,
      [
        ['Salon / bureau', snapshot.office ? `${snapshot.office.number} — ${snapshot.office.name}` : '—'],
        ['Agent / coiffeuse', snapshot.agent?.name || 'Non attribué'],
        ['Validation enregistrée par', snapshot.handledBy?.name || '—'],
        ['Date de validation', snapshot.handledBy?.at ? formatDateTime(snapshot.handledBy.at) : '—'],
        ...(recu && snapshot.completedBy
          ? [
              ['Prestation clôturée par', snapshot.completedBy.name],
              ['Clôturée le', formatDateTime(snapshot.completedBy.at)],
            ]
          : []),
      ],
      MARGE,
      y,
      UTILE,
      { pas: 36 },
    )
    y += 22

    /* ── Argent ── */
    if (recu) {
      y = tableauVersements(doc, snapshot, y)
    } else {
      y = comptes(doc, snapshot, y + 6)
    }

    if (!recu && snapshot.discount?.amount > 0 && snapshot.discount.note) {
      doc
        .font('Helvetica-Oblique')
        .fontSize(7.5)
        .fillColor(GRIS)
        .text(`Motif de la réduction : ${snapshot.discount.note}`, MARGE, y, { width: UTILE })
    }

    pied(
      doc,
      snapshot,
      recu
        ? 'Merci de votre confiance — document à conserver.'
        : 'Estimation avant prestation — ne vaut pas reçu de paiement.',
    )

    doc.end()
  })
}

export default renderDocument
