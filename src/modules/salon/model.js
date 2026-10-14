import { query, execute } from '../../config/database.js'
import { toBool, toShortTime } from '../../lib/url.js'

export const WEEKDAY_LABELS = [
  'Dimanche',
  'Lundi',
  'Mardi',
  'Mercredi',
  'Jeudi',
  'Vendredi',
  'Samedi',
]

/** Table clé/valeur → objet JS. */
export async function getSettings() {
  const rows = await query('SELECT setting_key, setting_value FROM salon_settings')
  return Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]))
}

export async function updateSettings(patch) {
  for (const [key, value] of Object.entries(patch)) {
    await execute(
      `INSERT INTO salon_settings (setting_key, setting_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [key, value === null || value === undefined ? null : String(value)],
    )
  }
  return getSettings()
}

export async function getOpeningHours() {
  return query(
    'SELECT weekday, is_closed, opens_at, closes_at FROM opening_hours ORDER BY weekday',
  )
}

/** L'affichage suit la semaine française : lundi d'abord, dimanche en dernier. */
export function serializeHours(rows) {
  const ordered = [...rows].sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7))
  return ordered.map((row) => {
    const closed = toBool(row.is_closed)
    return {
      weekday: row.weekday,
      day: WEEKDAY_LABELS[row.weekday],
      isClosed: closed,
      opensAt: toShortTime(row.opens_at),
      closesAt: toShortTime(row.closes_at),
      value: closed ? 'Fermé' : `${toShortTime(row.opens_at)} – ${toShortTime(row.closes_at)}`,
    }
  })
}

/** Objet « salon » consommé par le site public. */
export function serializeSalon(settings, hours) {
  const socials = [
    { id: 'instagram', label: 'Instagram', url: settings.social_instagram || '' },
    { id: 'facebook', label: 'Facebook', url: settings.social_facebook || '' },
    { id: 'tiktok', label: 'TikTok', url: settings.social_tiktok || '' },
  ].filter((social) => social.url)

  return {
    name: settings.name || 'Beauté Halal',
    specialty: settings.specialty || '',
    tagline: settings.tagline || '',
    shortDescription: settings.short_description || '',
    phone: {
      display: settings.phone_display || '',
      href: settings.phone_href || '',
    },
    whatsapp: {
      number: settings.whatsapp_number || '',
      defaultMessage: settings.whatsapp_default_message || '',
      available: Boolean(settings.whatsapp_number),
    },
    email: settings.email || '',
    address: {
      line1: settings.address_line1 || '',
      line2: settings.address_line2 || '',
      city: settings.address_city || '',
      country: settings.address_country || '',
      note: settings.address_note || '',
      mapEmbedUrl: settings.map_embed_url || '',
    },
    socials,
    hours: serializeHours(hours),
    currency: settings.currency || 'FCFA',
    bookingWindowDays: Number(settings.booking_window_days) || 60,
  }
}
