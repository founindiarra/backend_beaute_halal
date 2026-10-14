/**
 * Qui a le droit de faire quoi.
 *
 * Deux rôles, et un seul endroit où la frontière est écrite — celui-ci.
 * Le backend s'en sert pour refuser, le dashboard pour masquer ; mais c'est
 * bien le refus du serveur qui protège. Masquer un bouton n'a jamais empêché
 * personne d'appeler la route directement.
 *
 *   admin  L'administratrice du salon. Tout, sans exception.
 *   staff  Les personnes qui tiennent l'accueil et le salon. Elles reçoivent
 *          les clientes, traitent les rendez-vous, encaissent, éditent les
 *          reçus — mais ne touchent ni aux comptes du dashboard ni à la
 *          comptabilité.
 *
 * ── Pour déplacer la frontière ──
 * Une seule ligne à changer : retirer un droit de la liste `staff` le réserve
 * à l'administratrice ; l'y ajouter l'ouvre à tout le monde. Rien d'autre
 * n'est à toucher — ni les routes, ni le menu, ni les écrans, qui lisent
 * tous cette table.
 */

/** Les domaines du dashboard, et ce que chacun recouvre. */
export const PERMISSIONS = {
  appointments: 'Rendez-vous : décider des demandes, accueillir, encaisser, clôturer',
  customers: 'Fiches clientes et historique de leurs visites',
  messaging: 'Envoi de SMS et d’e-mails aux clientes',
  catalog: 'Prestations, catégories, coiffures et avis clientes',
  schedule: 'Horaires, créneaux et fermetures exceptionnelles',
  team: 'Agents, coiffeuses et bureaux',
  messages: 'Messages reçus par le formulaire de contact',
  salon: 'Paramètres du salon',
  accounting: 'Comptabilité : caisse, dépenses, banque',
  users: 'Comptes d’accès au dashboard',
}

/**
 * Ce que le staff peut faire.
 *
 * Deux domaines en sont volontairement absents : `accounting` et `users`.
 * Ce sont les deux que la direction s'est réservés — l'argent de
 * l'entreprise et les clés de la maison.
 */
const STAFF = ['appointments', 'customers', 'messaging', 'catalog', 'schedule', 'team', 'messages', 'salon']

const TOUT = Object.keys(PERMISSIONS)

/** Droits d'un rôle. Un rôle inconnu ne reçoit rien : on refuse par défaut. */
export function permissionsFor(role) {
  if (role === 'admin') return [...TOUT]
  if (role === 'staff') return [...STAFF]
  return []
}

export function can(role, permission) {
  return permissionsFor(role).includes(permission)
}

/** Libellés affichés dans la page « Utilisateurs ». */
export const ROLE_LABELS = {
  admin: 'Administratrice',
  staff: 'Équipe',
}

export default permissionsFor
