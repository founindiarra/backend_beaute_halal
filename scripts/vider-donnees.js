/**
 * Vide les DONNÉES D'ACTIVITÉ de la base pour repartir à zéro, en gardant la configuration du salon.
 *
 *   node scripts/vider-donnees.js                              → SIMULATION : affiche ce qui serait vidé (aucune écriture)
 *   node scripts/vider-donnees.js --apply --confirmer=NOM_BASE → vide pour de bon
 *
 * VIDÉ (les compteurs repartent à 1) :
 *   rendez-vous · demandes du site · clientes · versements, reçus et proformas · événements · agents affectés
 *   comptabilité (écritures) · paiements Jèko (tentatives, notifications) · journaux de messages (e-mail, SMS, WhatsApp)
 *   discussions WhatsApp (conversations et messages ; le curseur de reprise du service est conservé) · messages du formulaire de contact
 *
 * CONSERVÉ (rien n'est touché) :
 *   comptes administrateur et droits · prestations et catégories · équipe/agents · bureaux · horaires et créneaux
 *   fermetures · paramètres du salon (dont le tarif de consultation) · catalogue « Tarifs du site » et textes du site
 *   galerie · comptes de caisse et catégories de dépenses · historique des migrations
 *
 * Options :
 *   --avis         vide aussi les avis clientes (conservés par défaut : ce sont des contenus du site)
 *   --fermetures   vide aussi les fermetures exceptionnelles
 *
 * Sécurités :
 *  - la simulation est le comportement par défaut ;
 *  - l'écriture exige --apply ET --confirmer=<nom exact de la base> (affiché par la simulation) ;
 *  - en production (NODE_ENV=production) il faut en plus --production ;
 *  - tout se fait dans UNE transaction : en cas d'erreur, rien n'est vidé.
 *
 * AVANT de lancer avec --apply : FAITES UNE SAUVEGARDE, par exemple
 *   mysqldump -u UTILISATEUR -p NOM_BASE > sauvegarde-avant-vidage.sql
 * Le vidage est IRRÉVERSIBLE. La session WhatsApp (QR) ne vit pas en base : elle n'est pas affectée.
 */
import mysql from 'mysql2/promise'

import { config } from '../src/config/env.js'

const arg = (nom) => process.argv.find((a) => a === nom || a.startsWith(`${nom}=`))
const appliquer = Boolean(arg('--apply'))
const nomConfirme = arg('--confirmer')?.split('=')[1] ?? ''
const base = config.db.database

// Ordre : les tables « enfants » avant leurs parents (les contraintes sont aussi suspendues pendant l'opération).
const ACTIVITE = [
  'payment_events', 'payment_attempts',
  'appointment_agents', 'appointment_documents', 'appointment_events', 'appointment_payments',
  'ledger_entries',
  'booking_requests', 'appointments',
  // `whatsapp_sync_state` n'est PAS vidée : c'est le curseur technique de reprise du service WhatsApp (une ligne unique
  // attendue par le serveur). La supprimer ou la remettre à zéro ferait réimporter d'anciens messages.
  'whatsapp_messages', 'whatsapp_conversations',
  'message_logs', 'contact_messages',
  'customers',
]
const tables = [...ACTIVITE]
if (arg('--avis')) tables.push('testimonials')
if (arg('--fermetures')) tables.push('closures')

console.log(`Base visée : ${base} (${config.env})`)
console.log(appliquer ? 'MODE ÉCRITURE (--apply)' : 'MODE SIMULATION (aucune écriture)')

if (config.isProduction && !arg('--production')) {
  console.error('⛔ NODE_ENV=production : ajoutez --production si vous êtes sûr de vouloir vider la base de PRODUCTION.')
  process.exit(1)
}
if (appliquer && nomConfirme !== base) {
  console.error(`⛔ Confirmation manquante ou incorrecte. Relancez avec :  --apply --confirmer=${base}`)
  process.exit(1)
}

const connexion = await mysql.createConnection({
  host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password, database: base,
})

try {
  const [existantes] = await connexion.query('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()')
  const presentes = new Set(existantes.map((r) => r.t.toLowerCase()))
  const cibles = tables.filter((t) => presentes.has(t))
  const absentes = tables.filter((t) => !presentes.has(t))

  console.log('\nÀ vider :')
  let total = 0
  for (const t of cibles) {
    const [[{ n }]] = await connexion.query(`SELECT COUNT(*) AS n FROM \`${t}\``)
    total += Number(n)
    console.log(`  ${t.padEnd(26)} ${String(n).padStart(7)} ligne(s)`)
  }
  if (absentes.length) console.log(`\n(tables absentes de cette base, ignorées : ${absentes.join(', ')})`)
  console.log(`\nTotal : ${total} ligne(s) dans ${cibles.length} table(s).`)

  if (!appliquer) {
    console.log(`\nSimulation terminée. Pour vider : sauvegardez la base, puis\n  node scripts/vider-donnees.js --apply --confirmer=${base}`)
  } else {
    await connexion.query('SET FOREIGN_KEY_CHECKS = 0')
    await connexion.beginTransaction()
    try {
      for (const t of cibles) await connexion.query(`DELETE FROM \`${t}\``)
      await connexion.commit()
    } catch (erreur) {
      await connexion.rollback()
      throw erreur
    } finally {
      await connexion.query('SET FOREIGN_KEY_CHECKS = 1')
    }
    // Les compteurs repartent à 1 (hors transaction : ALTER est implicitement validé).
    for (const t of cibles) await connexion.query(`ALTER TABLE \`${t}\` AUTO_INCREMENT = 1`)
    console.log(`\n✓ Base « ${base} » vidée : ${total} ligne(s) supprimée(s). La configuration du salon est intacte.`)
  }
} catch (erreur) {
  console.error('❌', erreur.message)
  process.exitCode = 1
} finally {
  await connexion.end()
}
