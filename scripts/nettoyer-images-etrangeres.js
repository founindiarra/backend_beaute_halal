/**
 * Nettoie la page « Prestations » du dashboard (table `services` UNIQUEMENT) : retire les références d'images
 * d'illustration hébergées chez Unsplash, Pexels ou Pixabay (jeu de démarrage). Règle : scripts/lib/images-etrangeres.js.
 *
 *   node scripts/nettoyer-images-etrangeres.js           → SIMULATION : liste ce qui serait retiré et ce qui est protégé
 *   node scripts/nettoyer-images-etrangeres.js --apply   → applique (à lancer vous-même, après sauvegarde)
 *
 * Garanties :
 *  - seule la colonne `image_url` de `services` est lue pour être nettoyée ; la galerie, l'équipe, les agences, les
 *    paramètres du site et le catalogue (images des pages, Hero…) ne sont JAMAIS modifiés ;
 *  - une image n'est retirée que si elle est étrangère (Unsplash/Pexels/Pixabay) ET introuvable ailleurs sur le site
 *    (paramètres du salon, catalogue, galerie, équipe, agences) : sinon elle est protégée ;
 *  - toute image du domaine Beauté Halal, téléversée (/uploads/…) ou locale est protégée, quel que soit son format ;
 *  - aucune prestation n'est supprimée ni modifiée à part `image_url` mise à NULL ; aucun rendez-vous n'est touché.
 * Écrit dans la base du `.env` du dossier courant : vérifiez le nom affiché avant --apply.
 */
import { config } from '../src/config/env.js'
import { closePool, execute, query } from '../src/config/database.js'
import { hoteDe, trierPrestations } from './lib/images-etrangeres.js'

const appliquer = process.argv.includes('--apply')
console.log(`Base visée : ${config.db.database} (${config.env})`)
console.log(appliquer ? 'MODE ÉCRITURE (--apply)' : 'MODE SIMULATION (aucune écriture)')
const court = (v) => String(v).slice(0, 100)

try {
  // Tout ce qui, ailleurs sur le site, peut référencer une image (lecture seule).
  const parties = []
  const lire = async (sql) => {
    try { return await query(sql) } catch { return [] }
  }
  for (const r of await lire('SELECT setting_value FROM salon_settings')) parties.push(r.setting_value)
  for (const r of await lire('SELECT data FROM pricing_catalogue')) parties.push(r.data)
  for (const t of ['gallery_items', 'team_members', 'offices']) {
    for (const r of await lire(`SELECT image_url FROM ${t} WHERE image_url IS NOT NULL`)) parties.push(r.image_url)
  }
  const corpus = parties.filter(Boolean).map(String).join('\n')

  const lignes = await query(`SELECT id, slug, name, image_url FROM services WHERE image_url IS NOT NULL AND image_url <> ''`)
  const { aRetirer, protegees, utiliseesAilleurs } = trierPrestations(lignes, corpus)

  console.log(`\n══ prestations : ${lignes.length} photo(s) — ${protegees.length} protégée(s), ${aRetirer.length} à retirer`)
  for (const r of aRetirer) console.log(`  ✗ ${appliquer ? 'retirée' : 'à retirer'} #${r.id} « ${r.name} » [${hoteDe(r.image_url)}] ${court(r.image_url)}`)
  for (const r of utiliseesAilleurs) console.log(`  ✓ protégée (utilisée ailleurs sur le site) #${r.id} « ${r.name} » ${court(r.image_url)}`)
  for (const r of protegees.filter((p) => !utiliseesAilleurs.includes(p))) console.log(`  ✓ protégée #${r.id} « ${r.name} » ${court(r.image_url)}`)

  if (appliquer) for (const r of aRetirer) await execute('UPDATE services SET image_url = NULL WHERE id = ?', [r.id])
  console.log(`\n${appliquer ? 'Retirées' : 'À retirer'} : ${aRetirer.length} · protégées : ${protegees.length}`)
  if (!appliquer) console.log('Rien n’a été écrit. Relisez la liste, puis ajoutez --apply pour appliquer.')
} finally {
  await closePool()
}
