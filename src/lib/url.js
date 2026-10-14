import { config } from '../config/env.js'

/**
 * Renvoie une URL exploitable par le front.
 * Les images téléversées sont stockées en base sous « /uploads/xxx.jpg » :
 * on les préfixe par l'URL de l'API. Les URL externes sont laissées telles quelles.
 */
export function absoluteUrl(value) {
  if (!value) return null
  if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value
  return `${config.apiUrl}${value.startsWith('/') ? '' : '/'}${value}`
}

/** MySQL renvoie 0/1 pour les TINYINT(1). */
export const toBool = (value) => Boolean(Number(value))

/** Retire les secondes : « 09:00:00 » → « 09:00 ». */
export const toShortTime = (value) => (value ? String(value).slice(0, 5) : null)
