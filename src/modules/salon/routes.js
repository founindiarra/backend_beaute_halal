import { Router } from 'express'
import { z } from 'zod'

import { getOpeningHours, getSettings, serializeSalon, updateSettings } from './model.js'
import { sendData } from '../../lib/http.js'
import { validate } from '../../middleware/validate.js'
import { CLES_REGLAGES } from '../messaging/notifications.js'

/** Clés modifiables depuis l'API admin. */
const EDITABLE_KEYS = [
  'name',
  'specialty',
  'tagline',
  'short_description',
  'phone_display',
  'phone_href',
  'whatsapp_number',
  'whatsapp_default_message',
  'email',
  'address_line1',
  'address_line2',
  'address_city',
  'address_country',
  'address_note',
  'map_embed_url',
  'social_instagram',
  'social_facebook',
  'social_tiktok',
  'currency',
  'booking_window_days',
  /* Capacité et messagerie — réglés depuis « Paramètres du salon ». */
  'capacity_include_pending',
  'birthday_enabled',
  'birthday_channel',
  'birthday_template',
  'sms_sender_name',
  /*
   * Modèles des messages du parcours — confirmation, refus, annulation,
   * rappel, remerciement. Chacun a trois clés : _enabled, _channel,
   * _template. La liste est construite à partir des événements eux-mêmes,
   * pour qu'un événement ajouté plus tard devienne modifiable sans qu'on
   * pense à revenir ici.
   */
  ...CLES_REGLAGES,
]

const settingsSchema = z
  .object(Object.fromEntries(EDITABLE_KEYS.map((key) => [key, z.string().max(1000).optional()])))
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: 'Aucun champ à mettre à jour.' })

// ── Public ──
export const publicRouter = Router()

publicRouter.get('/salon', async (_request, response) => {
  const [settings, hours] = await Promise.all([getSettings(), getOpeningHours()])
  return sendData(response, serializeSalon(settings, hours))
})

// ── Admin ──
export const adminRouter = Router()

adminRouter.get('/salon', async (_request, response) => {
  const settings = await getSettings()
  return sendData(response, settings)
})

adminRouter.put('/salon', validate({ body: settingsSchema }), async (request, response) => {
  const settings = await updateSettings(request.body)
  return sendData(response, settings)
})
