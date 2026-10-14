/**
 * Le numéro de téléphone comme matricule de la cliente.
 *
 * Deux rendez-vous portant le même numéro sont la même personne, quelle que
 * soit la façon dont ce numéro a été tapé. C'est le seul rapprochement sur
 * lequel on peut compter : les noms se ressemblent, s'abrègent et
 * s'orthographient de dix façons, les numéros non.
 *
 * ⚠️ Cette règle existe en DEUX exemplaires : ici, et sous la forme de la
 * fonction SQL `bh_phone_key()` créée par la migration 005. Les deux doivent
 * donner exactement le même résultat — la migration s'en sert pour reprendre
 * l'existant, l'API pour tout ce qui vient après. Si l'une change, l'autre
 * change aussi, sans quoi une même cliente finirait avec deux fiches.
 */

/**
 * « +225 07 00 00 00 01 » → « 0700000001 »
 *
 * L'indicatif ivoirien n'est retiré que s'il reste au moins huit chiffres
 * derrière : les anciens numéros à huit chiffres traînent encore dans de
 * vieilles fiches, et les amputer d'un chiffre créerait des doublons.
 */
export function normaliserTelephone(saisie) {
  const chiffres = String(saisie ?? '').replace(/[^0-9]/g, '')
  if (!chiffres) return ''

  if (chiffres.startsWith('00225') && chiffres.length - 5 >= 8) return chiffres.slice(5)
  if (chiffres.startsWith('225') && chiffres.length - 3 >= 8) return chiffres.slice(3)
  return chiffres
}

/** Un numéro exploitable fait au moins huit chiffres une fois normalisé. */
export function telephoneValide(saisie) {
  return normaliserTelephone(saisie).length >= 8
}

/**
 * Forme internationale, pour les passerelles SMS qui l'exigent.
 * Sans indicatif reconnaissable, on renvoie le numéro tel quel plutôt que
 * d'en inventer un : mieux vaut un envoi refusé qu'un message parti au
 * mauvais pays.
 */
export function formatInternational(saisie, indicatif = '225') {
  const local = normaliserTelephone(saisie)
  if (!local) return ''
  if (local.length >= 11) return local
  return `${indicatif}${local}`
}

export default normaliserTelephone
