/**
 * Supprime puis recrée la base — utile en développement uniquement.
 *
 *   npm run db:reset && npm run db:setup
 */
import readline from 'node:readline/promises'

import mysql from 'mysql2/promise'

import { config } from '../src/config/env.js'

async function main() {
  if (config.isProduction && process.env.FORCE_RESET !== 'true') {
    console.error('⛔ Réinitialisation refusée en production.')
    process.exit(1)
  }

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(
      `⚠️  Supprimer définitivement la base « ${config.db.database} » ? (oui/non) `,
    )
    rl.close()
    if (!['oui', 'o', 'yes', 'y'].includes(answer.trim().toLowerCase())) {
      console.log('Annulé.')
      process.exit(0)
    }
  }

  const connection = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
  })

  await connection.query(`DROP DATABASE IF EXISTS \`${config.db.database}\``)
  await connection.query(
    `CREATE DATABASE \`${config.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  )
  await connection.end()

  console.log(`✓ Base « ${config.db.database} » réinitialisée. Lancez « npm run db:setup ».`)
}

main().catch((error) => {
  console.error('❌', error.message)
  process.exit(1)
})
