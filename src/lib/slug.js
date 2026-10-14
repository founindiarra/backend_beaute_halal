/** « Création de locks » → « creation-de-locks » */
export function slugify(value = '') {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
}

/**
 * Rend un slug unique en suffixant -2, -3… si nécessaire.
 * `exists` est une fonction async (slug) => boolean
 */
export async function uniqueSlug(base, exists) {
  const root = slugify(base) || 'element'
  let candidate = root
  let counter = 2
  // eslint-disable-next-line no-await-in-loop
  while (await exists(candidate)) {
    candidate = `${root}-${counter}`
    counter += 1
  }
  return candidate
}
