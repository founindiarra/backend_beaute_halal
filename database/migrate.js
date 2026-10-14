/**
 * Applique les migrations SQL présentes dans database/migrations/,
 * dans l'ordre alphabétique, une seule fois chacune.
 *
 *   npm run db:migrate
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import mysql from 'mysql2/promise'

import { config } from '../src/config/env.js'

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations')

async function main() {
  // 1. Connexion sans base pour pouvoir la créer si elle n'existe pas encore.
  const root = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
  })

  await root.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  )
  console.log(`✓ Base « ${config.db.database} » prête.`)
  await root.end()

  // 2. Connexion sur la base cible.
  const db = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true,
  })

  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       VARCHAR(191) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  const [applied] = await db.query('SELECT name FROM schema_migrations')
  const done = new Set(applied.map((row) => row.name))

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()

  let count = 0
  for (const file of files) {
    if (done.has(file)) {
      console.log(`· ${file} — déjà appliquée`)
      continue
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    try {
      await db.query(sql)
      await db.query('INSERT INTO schema_migrations (name) VALUES (?)', [file])
      console.log(`✓ ${file} — appliquée`)
      count += 1
    } catch (error) {
      console.error(`✗ ${file} — échec : ${error.message}`)
      await db.end()
      process.exit(1)
    }
  }

  await db.end()
  console.log(count ? `\n${count} migration(s) appliquée(s).` : '\nBase déjà à jour.')
}

main().catch((error) => {
  console.error('\n❌ Migration impossible :', error.message)
  if (['ECONNREFUSED', 'ETIMEDOUT'].includes(error.code)) {
    console.error('   Le serveur MySQL est-il démarré ? (XAMPP → bouton Start de MySQL)')
  }
  if (error.code === 'ER_ACCESS_DENIED_ERROR') {
    console.error('   Vérifiez DB_USER et DB_PASSWORD dans votre fichier .env.')
  }
  process.exit(1)
})
