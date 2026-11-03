/**
 * Messages à la cliente (e-mail, SMS, WhatsApp) alignés sur le parcours actuel :
 * consultation capillaire (frais réglés en ligne), prestation souhaitée ensuite, installation avec acompte,
 * numéro WhatsApp principal du salon. Tests purs : rien n'est envoyé. Lancer : node tests/messages-parcours.test.js
 */
import { appointmentStatusToCustomer, appointmentThanksToCustomer } from '../src/lib/mailer.js'
import { EVENEMENTS } from '../src/modules/messaging/notifications.js'
import { construireRecapPaiement, dureeBreve, jourComplet } from '../src/modules/messaging/recap-paiement.js'
import { closePool } from '../src/config/database.js'

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => { if (ok) { passed += 1; console.log(`  ✓ ${label}`) } else { failed += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) } }

const base = { first_name: 'Awa', reference: 'BH-TEST01', email: 'awa@example.com', currency: 'FCFA', source: 'site-v3', appointment_date: '2026-11-03', appointment_time: '10:00:00', cancel_reason: null }
const contexte = { whatsapp: '+225 05 66 15 74 32', reglesTitre: 'Bon à savoir', regles: ['Salon réservé aux femmes.', 'Locks uniquement.'] }

console.log('\n── E-mail : consultation confirmée ──')
const consult = appointmentStatusToCustomer({ ...base, status: 'confirmed', service_name: 'Consultation capillaire', duration_minutes: 30, price: 5000 }, { ...contexte, consultation: true, paye: 5000, serviceDate: '2026-11-10', serviceTime: '14:00' })
check('objet : consultation confirmée', /consultation capillaire du 03\/11\/2026 à 10:00 est confirmée/.test(consult.subject), consult.subject)
check('plus de « Prix indicatif » ni de durée de 180 minutes', !/Prix indicatif|180 minutes/.test(consult.text))
check('frais de consultation réglés en ligne', /Frais de consultation : .*5.000.*FCFA \(réglés en ligne\)/.test(consult.text), consult.text)
check('prestation souhaitée ensuite, un autre jour', /Prestation souhaitée ensuite : le 10\/11\/2026 à 14:00/.test(consult.text))
check('numéro WhatsApp et « bon à savoir »', consult.text.includes('+225 05 66 15 74 32') && consult.text.includes('- Salon réservé aux femmes.') && consult.text.includes('- Locks uniquement.'))
check('plus de « répondez à ce message »', !/répondez à ce message/.test(consult.text))

console.log('\n── E-mail : consultation détectée sans contexte (anciens appels) ──')
const sansCtx = appointmentStatusToCustomer({ ...base, status: 'confirmed', service_name: 'Consultation capillaire', duration_minutes: 30, price: 5000 })
check('toujours une consultation, sans « Prix indicatif »', /consultation capillaire/.test(sansCtx.subject) && !/Prix indicatif/.test(sansCtx.text))

console.log('\n── E-mail : installation confirmée ──')
const instal = appointmentStatusToCustomer({ ...base, status: 'confirmed', service_name: 'Installation de locks — Micro-locks', duration_minutes: 480, price: 60000 }, { ...contexte, paye: 5000 })
check('prix convenu (pas indicatif)', /Prix convenu : .*60.000.*FCFA/.test(instal.text) && !/Prix indicatif/.test(instal.text))
check('durée lisible en heures', /Durée prévue : 8 h/.test(instal.text))
check('acompte déjà réglé', /Acompte déjà réglé en ligne : .*5.000.*FCFA/.test(instal.text))

console.log('\n── E-mail : refus, annulation, remerciement ──')
const refus = appointmentStatusToCustomer({ ...base, status: 'rejected', service_name: 'Consultation capillaire', duration_minutes: 30, price: 0 }, contexte)
check('refus : invite à écrire sur WhatsApp', refus.text.includes('WhatsApp au +225 05 66 15 74 32') && !/répondez à ce message/.test(refus.text))
const annule = appointmentStatusToCustomer({ ...base, status: 'cancelled', service_name: 'Installation de locks — Small locks', duration_minutes: 180, price: 1 }, contexte)
check('annulation : numéro WhatsApp pour en fixer un autre', annule.text.includes('+225 05 66 15 74 32'))
const merci = appointmentThanksToCustomer({ ...base, status: 'completed', service_name: 'Consultation capillaire' }, { ...contexte, serviceDate: null })
check('remerciement de consultation : invite à réserver l’installation', /consultation capillaire/.test(merci.text) && /installation/.test(merci.text) && merci.text.includes('+225 05 66 15 74 32'))
const merciInstal = appointmentThanksToCustomer({ ...base, status: 'completed', service_name: 'Installation de locks — Micro-locks', staff_name: 'Mariam' }, contexte)
check('remerciement d’installation : WhatsApp au lieu de « répondre à ce message »', merciInstal.text.includes('WhatsApp au +225') && !/répondre à ce message/.test(merciInstal.text))

console.log('\n── Modèles SMS / WhatsApp par défaut ──')
for (const e of ['rejected', 'cancelled', 'request_rejected', 'request_cancelled']) {
  const t = EVENEMENTS[e].defaut.template
  check(`${e} : « Écrivez-nous sur WhatsApp au {whatsapp} », plus d’« Appelez-nous »`, t.includes('{whatsapp}') && !/Appelez-nous/.test(t), t)
}
check('rendez-vous confirmé après paiement : mention {suite} (prestation souhaitée)', EVENEMENTS.payment_confirmed.defaut.template.includes('{suite}'))
check('aucun modèle par défaut ne parle de téléphone pour la consultation', !Object.values(EVENEMENTS).some((e) => /par telephone|par téléphone/i.test(e.defaut.template)))

console.log('\n── Récapitulatif complet après le paiement des 5 000 FCFA ──')
const catalogue = {
  whatsapp: { display: '+225 05 66 15 74 32' },
  lockTypes: [{ id: 'micro', name: 'Micro-Locks', size: '0,4 cm' }],
  volumes: [{ id: 'M', label: 'Volume moyen' }],
  formules: [],
  site: {
    methodes: { micro: { noteTemps: 'La durée dépend du volume.', methodes: [{ id: 'interlocking', label: 'Micro interlocking', duree: 'une journée entière ou une journée et demie' }] } },
    politique: { sections: [{ titre: 'Fixation du prix', texte: 'Devis à distance : envoyez une photo ou une vidéo.' }, { titre: 'Annulations et retards', texte: 'Avance non remboursable moins de 48 h avant.' }, { titre: 'Horaires', texte: 'Ouvert de 09 h à 19 h 30, fermé le vendredi.' }] },
  },
}
const ligne = { reference: 'BH-AB12CD', first_name: 'Awa', besoin: 'creation', lock_type: 'micro', methode: 'interlocking', volume: 'M', longueur: 'Épaule', customer_kind: 'nouvelle', consultation_mode: 'sur_place', consultation_date: '2026-11-03', consultation_time: '10:00:00', service_date: '2026-11-10', service_time: '14:00:00', inspiration_title: 'Micro-locks sur cheveux crépus', payment_amount: 5000, payment_status: 'paid', estimate_total: null }
check('jour complet en français', jourComplet('2026-11-03') === 'mardi 3 novembre 2026', jourComplet('2026-11-03'))
const r1 = construireRecapPaiement({ ligne, catalogue, confirme: true, creneau: { date: '2026-11-03', time: '10:00' } })
const lignesTexte = r1.email
check('consultation confirmée : jour, heure, durée 30 min, paiement', /confirmé pour le mardi 3 novembre 2026 à 10:00/.test(lignesTexte) && /30 minutes/.test(lignesTexte) && /Montant reçu : 5 000 FCFA/.test(lignesTexte))
check('nouvelle cliente : l’avance couvre la consultation', /couvre vos frais de consultation|frais de votre consultation/.test(lignesTexte))
check('coiffure : type, méthode, volume, longueur, modèle choisi', /Micro-Locks \(0,4 cm\)/.test(lignesTexte) && /Micro interlocking/.test(lignesTexte) && /Volume moyen/.test(lignesTexte) && /Longueur : Épaule/.test(lignesTexte) && /« Micro-locks sur cheveux crépus »/.test(lignesTexte))
check('durée de la pose et prestation souhaitée ensuite', /une journée entière/.test(lignesTexte) && /Prestation souhaitée le : mardi 10 novembre 2026 à 14:00/.test(lignesTexte))
check('règles du salon (annulation, retard, horaires) et WhatsApp', /Annulations et retards : Avance non remboursable/.test(lignesTexte) && /Horaires : Ouvert/.test(lignesTexte) && /WhatsApp au \+225 05 66 15 74 32/.test(lignesTexte))
check('WhatsApp : mêmes informations, gras', /\*Votre coiffure\*/.test(r1.whatsapp) && /Micro interlocking/.test(r1.whatsapp) && /_Montant reçu_ : 5 000 FCFA/.test(r1.whatsapp))
const r2 = construireRecapPaiement({ ligne: { ...ligne, consultation_mode: 'ignoree', consultation_date: null, service_date: null, customer_kind: 'ancienne', desired_date: '2026-11-12', desired_time: '09:00:00' }, catalogue, confirme: false })
check('installation sans consultation, ancienne cliente : avance déduite', /déduite du prix de votre prestation/.test(r2.email) && /Installation de locks/.test(r2.email) && /le salon vous confirme le jour/.test(r2.email) && /jeudi 12 novembre 2026/.test(r2.email) && /Heure : 09:00/.test(r2.email), r2.email.slice(0, 300))

check('SMS : date courte, heure, coiffure, durée brève, paiement et référence', /RDV CONFIRME mar 3 nov a 10:00/.test(r1.sms) && /Micro-Locks/.test(r1.sms) && /Duree ~1 a 1,5 jour|Duree ~30 min/.test(r1.sms) && /Paye 5 000 F/.test(r1.sms) && /BH-AB12CD/.test(r1.sms), r1.sms)
check('SMS : 155 caractères au maximum, espaces compris, sans accent', r1.sms.length <= 155 && !/[^\x20-\x7e]/.test(r1.sms), String(r1.sms.length))
check('SMS : même avec un modèle très long, jamais plus de 155 caractères', construireRecapPaiement({ ligne: { ...ligne, inspiration_title: 'Un modèle au nom vraiment très très long pour tester la limite' }, catalogue, confirme: true, creneau: { date: '2026-11-03', time: '10:00' } }).sms.length <= 155)
check('durée brève pour le SMS', dureeBreve('en moyenne une journée entière ou une journée et demie, voire 2 à 3 jours') === '1 a 1,5 jour' && dureeBreve('4 h à 5 h en moyenne') === '4 a 5 h' && dureeBreve('environ 5 h en moyenne') === '~5 h')
check('e-mail et WhatsApp structurés : accueil, sections, conclusion, statut du rendez-vous', /^Bonjour Awa,/.test(r1.email) && /VOTRE RENDEZ-VOUS/.test(r1.email) && /Statut : confirmé/.test(r1.email) && /À très bientôt/.test(r1.email) && /📅 \*Votre rendez-vous\*/.test(r1.whatsapp))
await closePool()
console.log(`\n${passed} réussi(s), ${failed} échec(s)`)
process.exit(failed ? 1 : 0)
