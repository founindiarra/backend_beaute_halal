import rateLimit from 'express-rate-limit'

import { config } from '../config/env.js'

const message = (text) => ({
  success: false,
  error: { code: 'TOO_MANY_REQUESTS', message: text },
})

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // En développement les limites sont très larges pour ne pas gêner les tests.
  skip: () => !config.isProduction && process.env.FORCE_RATE_LIMIT !== 'true',
}

/** Limite générale de l'API. */
export const generalLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 600,
  message: message('Trop de requêtes. Réessayez dans quelques minutes.'),
})

/** Création de rendez-vous : protège contre le spam de réservations. */
export const bookingLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: message('Trop de demandes de rendez-vous. Réessayez dans une heure.'),
})

/** Formulaire de contact. */
export const contactLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 8,
  message: message('Trop de messages envoyés. Réessayez dans une heure.'),
})

/** Connexion admin : freine les tentatives de force brute. */
export const loginLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: message('Trop de tentatives de connexion. Réessayez dans 15 minutes.'),
})

/**
 * Reconnaissance d'une cliente par son numéro, sur le site public.
 *
 * Cette route répond « connue » ou « inconnue » sur un numéro de téléphone.
 * Sans limite, on pourrait balayer les numéros d'un opérateur pour dresser
 * la liste des clientes du salon — une information qui ne regarde personne.
 * Vingt essais par quart d'heure suffisent largement à une cliente qui se
 * trompe de chiffre, et rendent le balayage inutilisable.
 */
export const lookupLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: message('Trop de recherches. Réessayez dans quelques minutes.'),
})
