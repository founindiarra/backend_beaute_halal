/**
 * Récapitulatif envoyé à la cliente dès que ses 5 000 FCFA sont payés : e-mail ET WhatsApp, avec le même contenu.
 * Fonction PURE (aucun accès base, aucun envoi) : elle reçoit la demande (ligne `booking_requests`), le catalogue,
 * le rendez-vous éventuel et renvoie les textes. L'envoi est fait par `envoyerRecapPaiement` (notifications.js).
 */
import { libelleMethode } from '../booking-requests/methodes.js'

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

const iso = (v) => (!v ? null : v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10))
const hhmm = (v) => (v ? String(v).slice(0, 5) : null)

/** « mardi 3 novembre 2026 » (sans toLocaleDateString : indépendant des données de langue du serveur). */
export function jourComplet(valeur) {
  const texte = iso(valeur)
  const [a, m, j] = String(texte ?? '').split('-').map(Number)
  if (!a || !m || !j) return ''
  return `${JOURS[new Date(Date.UTC(a, m - 1, j)).getUTCDay()]} ${j} ${MOIS[m - 1]} ${a}`
}

export function montant(valeur, devise = 'FCFA') {
  if (valeur === null || valeur === undefined || valeur === '' || Number.isNaN(Number(valeur))) return ''
  return `${String(Math.round(Number(valeur))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ${devise}`
}

const CONSULTATION_MIN = 30

/**
 * @param {object} p
 * @param {object} p.ligne       ligne booking_requests (snake_case)
 * @param {object} p.catalogue   catalogue des tarifs (types, volumes, formules, site, whatsapp)
 * @param {object|null} p.rendezVous  rendez-vous créé (facultatif)
 * @param {boolean} p.confirme   le rendez-vous a-t-il été confirmé automatiquement ?
 * @param {object|null} p.creneau  { date, time } du rendez-vous confirmé
 * @returns {{ subject: string, email: string, whatsapp: string, sections: object[] }}
 */
export function construireRecapPaiement({ ligne, catalogue = {}, rendezVous = null, confirme = false, creneau = null }) {
  const salon = 'Beauté Halal'
  const type = (catalogue.lockTypes ?? []).find((t) => t.id === ligne.lock_type) ?? null
  const volume = (catalogue.volumes ?? []).find((v) => v.id === ligne.volume) ?? null
  const formule = (catalogue.formules ?? []).find((f) => f.id === ligne.formule) ?? null
  const methodes = catalogue.site?.methodes?.[ligne.lock_type]?.methodes ?? []
  const methodeId = ligne.methode || null
  const methodeLibelle = methodeId ? libelleMethode(ligne.lock_type, methodeId) : null
  const methodeDuree = methodes.find((m) => m.id === methodeId)?.duree ?? null
  const noteTemps = catalogue.site?.methodes?.[ligne.lock_type]?.noteTemps ?? null
  const whatsapp = String(catalogue.whatsapp?.display ?? '').trim()

  const consultation = ['sur_place', 'telephone', 'whatsapp'].includes(ligne.consultation_mode)
  const avecPrestation = consultation && Boolean(ligne.service_date)
  const paye = Number(ligne.payment_amount ?? 0) || 0
  const nouvelle = ligne.customer_kind !== 'ancienne'
  const joursConsultation = jourComplet(ligne.consultation_date ?? ligne.desired_date)
  const jourChoisi = jourComplet(creneau?.date ?? (consultation ? ligne.consultation_date : ligne.desired_date) ?? ligne.desired_date)
  const heureChoisie = hhmm(creneau?.time) ?? hhmm(consultation ? ligne.consultation_time : ligne.desired_time)

  const sections = []

  // 1. État du rendez-vous
  const etat = []
  if (confirme && jourChoisi) etat.push(`Votre rendez-vous est CONFIRMÉ : ${jourChoisi}${heureChoisie ? ` à ${heureChoisie}` : ''}.`)
  else if (jourChoisi) etat.push(`Votre demande est bien enregistrée pour ${jourChoisi}${heureChoisie ? ` à ${heureChoisie}` : ''}. Le salon vous confirme le jour et l’heure très vite.`)
  else etat.push('Votre demande est bien enregistrée. Le salon vous contacte pour fixer le jour et l’heure.')
  etat.push(`Référence : ${ligne.reference}`)
  sections.push({ titre: 'Votre rendez-vous', lignes: etat })

  // 2. Le paiement et son usage
  if (paye) {
    sections.push({
      titre: 'Votre paiement',
      lignes: [
        `Montant reçu : ${montant(paye)}`,
        consultation
          ? 'Il correspond aux frais de votre consultation capillaire.'
          : nouvelle
            ? 'Cette avance couvre vos frais de consultation (nouvelle cliente).'
            : 'Cette avance est déduite du prix de votre prestation (ancienne cliente).',
      ],
    })
  }

  // 3. Consultation
  if (consultation) {
    const l = ['Prestation : Consultation capillaire', `Durée estimée : ${CONSULTATION_MIN} minutes`]
    if (joursConsultation) l.push(`Jour : ${joursConsultation}${hhmm(ligne.consultation_time) ? ` à ${hhmm(ligne.consultation_time)}` : ''}`)
    l.push('Analyse technique de vos cheveux et de votre cuir chevelu, conseils personnalisés et tarif précis.')
    sections.push({ titre: 'Votre consultation', lignes: l })
  }

  // 4. La coiffure
  const coiffure = []
  if (!consultation || avecPrestation) {
    if (ligne.besoin === 'creation') coiffure.push('Prestation : Installation de locks')
    else coiffure.push(`Prestation : ${formule?.label ?? 'Resserrage'}`)
    if (type) coiffure.push(`Type de locks : ${type.name}${type.size ? ` (${type.size})` : ''}`)
    if (ligne.besoin === 'creation') coiffure.push(`Méthode de pose : ${methodeLibelle ?? 'à conseiller par le salon'}`)
    if (volume) coiffure.push(`Volume : ${volume.label}`)
    if (ligne.longueur) coiffure.push(`Longueur : ${ligne.longueur}`)
  }
  if (ligne.inspiration_title) coiffure.push(`Coiffure / modèle choisi : « ${ligne.inspiration_title} »`)
  if (avecPrestation) {
    coiffure.push(`Prestation souhaitée le : ${jourComplet(ligne.service_date)}${hhmm(ligne.service_time) ? ` à ${hhmm(ligne.service_time)}` : ' (heure à confirmer avec le salon)'}`)
  }
  if (coiffure.length) sections.push({ titre: 'Votre coiffure', lignes: coiffure })

  // 5. Durée et prix
  const prix = []
  if (!consultation || avecPrestation) {
    if (methodeDuree) prix.push(`Durée de la pose : ${methodeDuree}`)
    else if (noteTemps) prix.push(`Durée : ${noteTemps}`)
  }
  if (ligne.estimate_total !== null && ligne.estimate_total !== undefined && Number(ligne.estimate_total) > 0) {
    prix.push(`Tarif indicatif : ${Number(ligne.estimate_partial) ? 'à partir de ' : ''}${montant(ligne.estimate_total)}`)
  }
  prix.push(consultation || ligne.besoin === 'creation'
    ? 'Le tarif précis est fixé par le salon (en consultation, ou à distance sur photo / vidéo).'
    : 'Le tarif final est confirmé par le salon.')
  sections.push({ titre: 'Durée et tarif', lignes: prix })

  // 6. Politique : annulations, retards, horaires (réglée dans le dashboard)
  const politique = catalogue.site?.politique?.sections ?? []
  const garde = politique.filter((s) => /annulation|retard|horaire/i.test(s.titre ?? ''))
  if (garde.length) sections.push({ titre: 'À savoir', lignes: garde.map((s) => `${s.titre} : ${s.texte}`) })
  const devis = politique.find((s) => /prix/i.test(s.titre ?? ''))

  // 7. Contact
  const contact = []
  if (whatsapp) contact.push(`Une question, une photo ou une vidéo à nous envoyer pour votre devis ? Écrivez-nous sur WhatsApp au ${whatsapp}.`)
  if (devis && whatsapp && !consultation) contact.push(`${devis.texte}`)
  if (contact.length) sections.push({ titre: 'Nous contacter', lignes: contact })

  const subject = confirme
    ? `Rendez-vous confirmé et paiement reçu — ${salon} (${ligne.reference})`
    : `Paiement reçu — votre demande ${ligne.reference} — ${salon}`
  const intro = `Bonjour ${ligne.first_name}, merci pour votre confiance ! ${paye ? `Votre paiement de ${montant(paye)} est bien reçu.` : 'Votre demande est bien reçue.'}`

  const email = [intro, '', ...sections.flatMap((s) => [s.titre.toUpperCase(), ...s.lignes.map((l) => `- ${l}`), '']), 'À très bientôt,', salon].join('\n')
  const wa = [`*${salon}*`, intro, '', ...sections.flatMap((s) => [`*${s.titre}*`, ...s.lignes.map((l) => `• ${l}`), '']), 'À très bientôt ! 🤍'].join('\n')
  return { subject, email, whatsapp: wa, sections }
}
