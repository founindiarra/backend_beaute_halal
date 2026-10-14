import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const envFile = resolve(ROOT_DIR, '.env')
if (existsSync(envFile)) {
  dotenv.config({ path: envFile, quiet: true })
} else {
  console.warn('⚠️  Aucun fichier .env trouvé — copiez .env.example en .env.')
  dotenv.config({ path: resolve(ROOT_DIR, '.env.example'), quiet: true })
}

const str = (key, fallback = '') => (process.env[key] ?? fallback).toString().trim()
const num = (key, fallback) => {
  const value = Number(process.env[key])
  return Number.isFinite(value) ? value : fallback
}
const bool = (key, fallback = false) => {
  const value = str(key).toLowerCase()
  if (!value) return fallback
  return ['1', 'true', 'yes', 'oui', 'on'].includes(value)
}

export const config = {
  env: str('NODE_ENV', 'development'),
  isProduction: str('NODE_ENV', 'development') === 'production',
  port: num('PORT', 4000),
  apiUrl: str('API_URL', `http://localhost:${num('PORT', 4000)}`).replace(/\/+$/, ''),

  db: {
    host: str('DB_HOST', '127.0.0.1'),
    port: num('DB_PORT', 3306),
    user: str('DB_USER', 'root'),
    password: str('DB_PASSWORD', ''),
    database: str('DB_NAME', 'beaute_halal'),
  },

  corsOrigins: str('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  jwt: {
    secret: str('JWT_SECRET', 'secret-de-developpement-a-remplacer'),
    expiresIn: str('JWT_EXPIRES_IN', '12h'),
  },

  admin: {
    name: str('ADMIN_NAME', 'Administrateur'),
    email: str('ADMIN_EMAIL', 'admin@beaute-halal.local').toLowerCase(),
    password: str('ADMIN_PASSWORD', 'ChangeMoi2026!'),
  },

  mail: {
    enabled: bool('MAIL_ENABLED', false),
    host: str('MAIL_HOST'),
    port: num('MAIL_PORT', 587),
    secure: bool('MAIL_SECURE', false),
    user: str('MAIL_USER'),
    password: str('MAIL_PASSWORD'),
    from: str('MAIL_FROM', 'Beauté Halal <contact@beaute-halal.example>'),
    adminRecipient: str('MAIL_ADMIN_RECIPIENT', 'contact@beaute-halal.example'),
  },

  /*
   * Passerelle SMS.
   *
   * Tout ce qui est propre au fournisseur vit ici — y compris le NOM de ses
   * champs. Le salon passe par KYA SMS ; les valeurs par défaut ci-dessous
   * sont les plus répandues, à ajuster d'après sa documentation. La page
   * « Messagerie » du dashboard a un bouton d'essai qui renvoie la réponse
   * brute du fournisseur : c'est le moyen le plus court de trouver les bons
   * noms sans toucher au code.
   */
  sms: {
    enabled: bool('SMS_ENABLED', false),
    url: str('SMS_API_URL'),
    method: str('SMS_API_METHOD', 'POST').toUpperCase(),
    token: str('SMS_API_TOKEN'),
    sender: str('SMS_SENDER_ID'),

    /** 'bearer' · 'header' · 'body' — comment le jeton est transmis. */
    authMode: str('SMS_AUTH_MODE', 'bearer').toLowerCase(),
    authHeader: str('SMS_AUTH_HEADER', 'X-API-KEY'),

    /** 'json' ou 'form' — format du corps de la requête. */
    contentType: str('SMS_CONTENT_TYPE', 'json').toLowerCase(),

    /** Noms des champs attendus par le fournisseur. */
    fieldTo: str('SMS_FIELD_TO', 'to'),
    fieldMessage: str('SMS_FIELD_MESSAGE', 'message'),
    fieldSender: str('SMS_FIELD_SENDER', 'sender'),
    fieldToken: str('SMS_FIELD_TOKEN', 'token'),

    /** « cle=valeur,cle=valeur » pour tout ce que le fournisseur réclame en plus. */
    extraFields: str('SMS_EXTRA_FIELDS')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),

    /** Certains exigent le numéro au format international (225…). */
    internationalFormat: bool('SMS_INTERNATIONAL_FORMAT', true),

    timeoutMs: num('SMS_TIMEOUT_MS', 15000),
  },

  upload: {
    dir: resolve(ROOT_DIR, str('UPLOAD_DIR', 'uploads')),
    publicPath: '/uploads',
    maxBytes: num('MAX_UPLOAD_MB', 5) * 1024 * 1024,
  },
}

/** Avertissements de sécurité au démarrage (jamais bloquants en développement). */
export function checkConfig() {
  const warnings = []
  if (config.isProduction) {
    if (config.jwt.secret.includes('changez') || config.jwt.secret.length < 32)
      warnings.push('JWT_SECRET est faible ou laissé par défaut.')
    if (!config.db.password) warnings.push('La base de données est utilisée sans mot de passe.')
    if (config.admin.password === 'ChangeMoi2026!')
      warnings.push('Le mot de passe administrateur par défaut n’a pas été changé.')
  }
  return warnings
}

export default config
