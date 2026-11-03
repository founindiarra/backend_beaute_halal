/**
 * Règle de tri des images du dashboard : une image n'est « étrangère » que si elle vient d'une banque d'images
 * externe connue (Unsplash, Pexels, Pixabay). TOUT le reste est protégé : photos hébergées sur le site du salon
 * (beaute-halal.aeemci-ce.ci), photos téléversées (« /uploads/… »), chemins locaux, quel que soit le format
 * (.webp, .jpg, .png, .svg, .gif…). En cas de doute, l'image est conservée.
 */
const BANQUES = ['unsplash.com', 'pexels.com', 'pixabay.com']

/** Nom d'hôte d'une URL absolue (http/https/« // »), ou null pour un chemin local ou une valeur illisible. */
export function hoteDe(valeur) {
  const texte = String(valeur ?? '').trim()
  if (!/^(https?:)?\/\//i.test(texte)) return null
  try {
    return new URL(texte.startsWith('//') ? `https:${texte}` : texte).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** true uniquement pour une image hébergée chez Unsplash, Pexels ou Pixabay (ou l'un de leurs sous-domaines). */
export function estImageEtrangere(valeur) {
  const hote = hoteDe(valeur)
  if (!hote) return false
  return BANQUES.some((b) => hote === b || hote.endsWith(`.${b}`))
}

/**
 * Vrai si `valeur` apparaît dans le texte `corpus` (JSON du catalogue, paramètres du site, autres tables d'images).
 * Les « / » échappés d'un JSON (\\/) sont normalisés avant la comparaison.
 */
export function estReferencee(valeur, corpus) {
  const v = String(valeur ?? '').trim()
  if (!v) return false
  return String(corpus ?? '').replace(/\\\//g, '/').includes(v)
}

/** Sépare une liste de lignes { image_url, … } en { aRetirer, protegees }. */
export function trierImages(lignes) {
  const aRetirer = []
  const protegees = []
  for (const ligne of lignes) (estImageEtrangere(ligne.image_url) ? aRetirer : protegees).push(ligne)
  return { aRetirer, protegees }
}

/**
 * Pour la page Prestations (table `services`) : une image n'est à retirer que si elle est étrangère ET qu'elle n'est
 * utilisée nulle part ailleurs sur le site (`corpus` = tout le texte des autres sources d'images).
 * Renvoie { aRetirer, protegees, utiliseesAilleurs } ; `utiliseesAilleurs` est inclus dans `protegees`.
 */
export function trierPrestations(lignes, corpus) {
  const aRetirer = []
  const protegees = []
  const utiliseesAilleurs = []
  for (const ligne of lignes) {
    if (!estImageEtrangere(ligne.image_url)) protegees.push(ligne)
    else if (estReferencee(ligne.image_url, corpus)) {
      protegees.push(ligne)
      utiliseesAilleurs.push(ligne)
    } else aRetirer.push(ligne)
  }
  return { aRetirer, protegees, utiliseesAilleurs }
}
