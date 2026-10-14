import { createApp } from './app.js'
import { checkConfig, config } from './config/env.js'
import { assertDatabaseConnection, closePool } from './config/database.js'

async function start() {
  try {
    await assertDatabaseConnection()
    console.log(`✓ Base « ${config.db.database} » connectée (${config.db.host}:${config.db.port}).`)
  } catch (error) {
    console.error('\n❌ Connexion à la base impossible :', error.message)
    console.error('   • Le serveur MySQL est-il démarré ? (XAMPP → Start sur MySQL)')
    console.error('   • Les identifiants du fichier .env sont-ils corrects ?')
    console.error('   • La base existe-t-elle ? Sinon : npm run db:migrate\n')
    process.exit(1)
  }

  checkConfig().forEach((warning) => console.warn(`⚠️  ${warning}`))

  const app = createApp()
  const server = app.listen(config.port, () => {
    console.log(`\n🌿 API Beauté Halal — ${config.env}`)
    console.log(`   ${config.apiUrl}`)
    console.log(`   Santé : ${config.apiUrl}/api/health`)
    console.log(`   Origines autorisées : ${config.corsOrigins.join(', ')}\n`)
  })

  const shutdown = async (signal) => {
    console.log(`\n${signal} reçu — arrêt en cours…`)
    server.close(async () => {
      await closePool().catch(() => {})
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 8000).unref()
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

start()
