import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { extname, join } from 'node:path'

import multer from 'multer'

import { config } from '../config/env.js'
import { ApiError } from '../lib/ApiError.js'
import { slugify } from '../lib/slug.js'

const ALLOWED = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
}

if (!existsSync(config.upload.dir)) mkdirSync(config.upload.dir, { recursive: true })

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => callback(null, config.upload.dir),
  filename: (_request, file, callback) => {
    const base = slugify(file.originalname.replace(extname(file.originalname), '')) || 'image'
    const extension = ALLOWED[file.mimetype] || '.jpg'
    callback(null, `${Date.now()}-${randomBytes(4).toString('hex')}-${base}${extension}`)
  },
})

export const uploadImage = multer({
  storage,
  limits: { fileSize: config.upload.maxBytes, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (ALLOWED[file.mimetype]) return callback(null, true)
    return callback(ApiError.badRequest('Format accepté : JPEG, PNG, WebP ou AVIF.'))
  },
}).single('image')

/** Chemin public d'un fichier déposé, ex. « /uploads/1737-ab12-locks.jpg ». */
export function publicUploadPath(filename) {
  return `${config.upload.publicPath}/${filename}`
}

export function uploadAbsolutePath(filename) {
  return join(config.upload.dir, filename)
}
