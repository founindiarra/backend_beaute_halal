import { Router } from 'express'

import { config } from '../config/env.js'
import { sendData } from '../lib/http.js'
import { requireAuth } from '../middleware/auth.js'
import authRoutes from '../modules/auth/routes.js'
import * as accounting from '../modules/accounting/routes.js'
import * as appointments from '../modules/appointments/routes.js'
import * as availability from '../modules/availability/routes.js'
import * as contact from '../modules/contact/routes.js'
import * as customers from '../modules/customers/routes.js'
import * as documents from '../modules/documents/routes.js'
import * as gallery from '../modules/gallery/routes.js'
import * as messaging from '../modules/messaging/routes.js'
import * as offices from '../modules/offices/routes.js'
import * as operations from '../modules/operations/routes.js'
import * as salon from '../modules/salon/routes.js'
import * as services from '../modules/services/routes.js'
import * as team from '../modules/team/routes.js'
import * as testimonials from '../modules/testimonials/routes.js'
import * as uploads from '../modules/uploads/routes.js'

/*
 * Le module « team » est remonté — mais côté ADMIN uniquement.
 *
 * Il porte désormais les agents / coiffeuses : le dashboard en a besoin pour
 * les affecter aux bureaux et aux rendez-vous, et le calcul de capacité s'en
 * sert pour savoir combien de prestations tiennent dans une journée.
 *
 * La route PUBLIQUE `/team` reste volontairement débranchée : le site public
 * n'a plus de page Équipe, et la rouvrir publierait les coordonnées des
 * coiffeuses sans que personne ne l'ait demandé. La surface publique de
 * l'API est donc strictement inchangée.
 */
const router = Router()

// ── Santé de l'API ──
router.get('/health', (_request, response) =>
  sendData(response, {
    status: 'ok',
    service: 'Beauté Halal API',
    environment: config.env,
    time: new Date().toISOString(),
  }),
)

// ── Routes publiques (aucune authentification) ──
router.use(
  salon.publicRouter,
  services.publicRouter,
  gallery.publicRouter,
  testimonials.publicRouter,
  availability.publicRouter,
  appointments.publicRouter,
  /*
   * Reconnaissance d'une cliente par son numéro, pour la première étape de
   * la réservation. Elle ne renvoie que ce que la cliente a elle-même saisi,
   * et elle est limitée en fréquence — voir le module.
   */
  customers.publicRouter,
  contact.publicRouter,
)

// ── Authentification admin (login public, le reste protégé dans le module) ──
router.use('/admin/auth', authRoutes)

// ── Routes admin (toutes protégées par JWT) ──
const admin = Router()
admin.use(requireAuth)
admin.use(
  salon.adminRouter,
  services.adminRouter,
  gallery.adminRouter,
  testimonials.adminRouter,
  availability.adminRouter,
  team.adminRouter,
  offices.adminRouter,
  customers.adminRouter,
  accounting.adminRouter,
  messaging.adminRouter,
  /*
   * « operations » et « documents » exposent eux aussi des chemins sous
   * /appointments/:id — /arrival, /payments, /documents/receipt… Ils ne se
   * masquent pas entre eux, un « :id » ne franchissant jamais une barre
   * oblique, mais on les monte avant le module « appointments » pour que
   * l'ordre de lecture suive celui du parcours.
   */
  operations.adminRouter,
  documents.adminRouter,
  appointments.adminRouter,
  contact.adminRouter,
  uploads.adminRouter,
)
router.use('/admin', admin)

export default router
