/**
 * Lance TOUS les tests d'un coup : `npm test`.
 *  – démarre une API de test (port 4230) avec Jèko et WhatsApp coupés, quel que soit le `.env` ;
 *  – y exécute api, v3, coiffures, demandes, permissions ;
 *  – puis whatsapp et paiement, qui démarrent chacun leur propre API (fausse API Meta / Jèko simulé).
 * Utilise la base du `.env` : une base de TEST uniquement (les tests créent puis suppriment des données).
 */
import { spawnSync } from 'node:child_process'

import { config } from '../src/config/env.js'
import { startApi, JEKO_OFF } from './lib/start-api.js'

if (config.isProduction) {
  console.error('Refus : les tests écrivent en base, ils ne tournent jamais avec NODE_ENV=production.')
  process.exit(1)
}

const api = await startApi(4230, { ...JEKO_OFF, WHATSAPP_ENABLED: 'false' })
const resultats = []
const lancer = (nom, fichier, env = {}) => {
  console.log(`\n████ ${nom} ████`)
  const r = spawnSync(process.execPath, [`tests/${fichier}`], { stdio: 'inherit', env: { ...process.env, ...env } })
  resultats.push({ nom, ok: r.status === 0 })
}

for (const [nom, fichier] of [['api', 'api.test.js'], ['v3', 'v3.test.js'], ['coiffures', 'coiffures.test.js'], ['demandes', 'demandes-rdv.test.js'], ['permissions', 'permissions.test.js'], ['créneaux et places', 'creneaux-capacite.test.js'], ['niveaux de réparation', 'reparation-niveaux.test.js'], ['textes et règles du site', 'textes-site.test.js'], ['nouveautés (avis, agents, rapport, listes)', 'nouveautes.test.js'], ['places par jour, e-mail facultatif, consultation', 'quotas.test.js']]) {
  lancer(nom, fichier, { TEST_API_URL: api.base })
}
api.stop()
lancer('catalogue (mise à jour des libellés)', 'catalogue-upgrade.test.js')
lancer('messages à la cliente (parcours actuel)', 'messages-parcours.test.js')
lancer('nettoyage des images étrangères', 'images-etrangeres.test.js')
lancer('whatsapp (Meta, historique)', 'whatsapp.test.js')
lancer('whatsapp-qr', 'whatsapp-qr.test.js')
lancer('discussions whatsapp', 'whatsapp-chat.test.js')
lancer('paiement', 'paiement.test.js')
lancer('confirmation automatique après paiement', 'confirmation-auto.test.js')
lancer('paiements Jèko (dashboard)', 'jeko-admin.test.js')

console.log('\n════════ Récapitulatif ════════')
for (const r of resultats) console.log(`  ${r.ok ? '✓' : '✗'} ${r.nom}`)
const echecs = resultats.filter((r) => !r.ok).length
console.log(echecs ? `\n  ${echecs} suite(s) en échec` : '\n  Toutes les suites passent')
process.exit(echecs ? 1 : 0)
