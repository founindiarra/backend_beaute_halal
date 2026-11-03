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
    /**
     * Numéro de l'administratrice, SEUL destinataire possible des messages d'essai (SMS et WhatsApp).
     * Vide = aucun essai possible. Le navigateur ne choisit jamais le destinataire d'un essai.
     */
    testPhone: str('ADMIN_TEST_PHONE'),
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

  /**
   * WhatsApp Business Cloud API (Meta).
   * Les messages à l'initiative du salon DOIVENT utiliser un modèle approuvé
   * par Meta : on y met le nom du modèle, pas son texte.
   */
  whatsapp: {
    enabled: bool('WHATSAPP_ENABLED', false),
    /**
     * Fournisseur d'envoi : « qr » (service Baileys, texte libre) ou « meta » (API officielle, modèles approuvés).
     * Un seul à la fois, jamais de repli automatique de l'un vers l'autre.
     */
    // Les notifications partent du numéro WhatsApp CONNECTÉ (service QR) dès que ce service est configuré ;
    // l'API Meta n'est utilisée que si elle est demandée explicitement ET que le service QR n'est pas configuré.
    provider: str('WHATSAPP_PROVIDER', 'qr').toLowerCase() === 'meta' && !(str('WHATSAPP_QR_SERVICE_URL') && str('WHATSAPP_QR_SERVICE_SECRET')) ? 'meta' : 'qr',
    /** Discussions WhatsApp du dashboard : relecture des messages du service et temps réel. */
    chat: {
      enabled: bool('WHATSAPP_CHAT_ENABLED', true),
      syncSeconds: Math.min(Math.max(num('WHATSAPP_CHAT_SYNC_SECONDS', 4), 2), 60),
    },
    /** Service WhatsApp QR (Baileys) : URL de base et secret partagé (HMAC). Uniquement dans le .env du serveur. */
    qr: {
      url: str('WHATSAPP_QR_SERVICE_URL').replace(/\/+$/, ''),
      secret: str('WHATSAPP_QR_SERVICE_SECRET'),
      timeoutMs: num('WHATSAPP_QR_TIMEOUT_MS', 10000),
    },
    phoneNumberId: str('WHATSAPP_PHONE_NUMBER_ID'),
    token: str('WHATSAPP_ACCESS_TOKEN'),
    apiVersion: str('WHATSAPP_API_VERSION', 'v21.0'),
    graphUrl: str('WHATSAPP_GRAPH_URL', 'https://graph.facebook.com'),
    language: str('WHATSAPP_LANGUAGE', 'fr'),
    timeoutMs: num('WHATSAPP_TIMEOUT_MS', 15000),
    /** Nom du modèle approuvé, par événement. Vide = événement non envoyé par WhatsApp. */
    templates: {
      confirmed: str('WHATSAPP_TEMPLATE_CONFIRMED'),
      rejected: str('WHATSAPP_TEMPLATE_REJECTED'),
      cancelled: str('WHATSAPP_TEMPLATE_CANCELLED'),
      reminder: str('WHATSAPP_TEMPLATE_REMINDER'),
      thanks: str('WHATSAPP_TEMPLATE_THANKS'),
      request_received: str('WHATSAPP_TEMPLATE_REQUEST_RECEIVED'),
      request_contacted: str('WHATSAPP_TEMPLATE_REQUEST_CONTACTED'),
      request_confirmed: str('WHATSAPP_TEMPLATE_REQUEST_CONFIRMED'),
      request_rejected: str('WHATSAPP_TEMPLATE_REQUEST_REJECTED'),
      request_cancelled: str('WHATSAPP_TEMPLATE_REQUEST_CANCELLED'),
      request_paid: str('WHATSAPP_TEMPLATE_REQUEST_PAID'),
      payment_confirmed: str('WHATSAPP_TEMPLATE_PAYMENT_CONFIRMED'),
    },
  },

  /**
   * Paiement de la consultation (nouvelles clientes) via Jèko — https://developer.jeko.africa
   * Sans clés, le paiement est simplement désactivé : les demandes continuent de partir sans lui.
   * `mock` (jamais en production) valide le paiement tout de suite, pour tester le parcours sans débiter personne.
   */
  jeko: {
    apiKey: str('JEKO_API_KEY'),
    apiKeyId: str('JEKO_API_KEY_ID'),
    storeId: str('JEKO_STORE_ID'),
    webhookSecret: str('JEKO_WEBHOOK_SECRET'),
    baseUrl: str('JEKO_BASE_URL', 'https://api.jeko.africa'),
    mock: bool('JEKO_MOCK', false),
    timeoutMs: num('JEKO_TIMEOUT_MS', 15000),
  },
  /** Adresse publique du site v3 (retour de paiement). Par défaut : la première origine CORS. */
  siteUrl: str('SITE_URL'),
  /** Montant de la consultation, en FCFA, si le réglage « consultation_fee » du salon est absent. */
  consultationFeeDefault: num('CONSULTATION_FEE', 5000),

  upload: {
    dir: resolve(ROOT_DIR, str('UPLOAD_DIR', 'uploads')),
    publicPath: '/uploads',
    maxBytes: num('MAX_UPLOAD_MB', 5) * 1024 * 1024,
    maxVideoBytes: num('MAX_UPLOAD_VIDEO_MB', 40) * 1024 * 1024,
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
