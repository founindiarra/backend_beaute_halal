import { randomInt } from 'node:crypto'

/** Alphabet sans caractères ambigus (ni 0/O ni 1/I) — lisible au téléphone. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Génère une référence de réservation du type « BH-8F42C1 ». */
export function generateReference(prefix = 'BH') {
  let code = ''
  for (let i = 0; i < 6; i += 1) code += ALPHABET[randomInt(ALPHABET.length)]
  return `${prefix}-${code}`
}

export default generateReference
