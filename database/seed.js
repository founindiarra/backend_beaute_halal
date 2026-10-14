/**
 * Remplit la base avec le contenu de démarrage et crée le compte administrateur.
 *
 *   npm run db:seed            (ne fait rien si des données existent déjà)
 *   npm run db:seed -- --force (vide les tables de contenu puis réinsère)
 *
 * Les rendez-vous et les messages de contact ne sont JAMAIS supprimés.
 */
import bcrypt from 'bcryptjs'

import { config } from '../src/config/env.js'
import { pool, query, queryOne, execute, closePool } from '../src/config/database.js'
import {
  galleryCategories,
  galleryItems,
  openingHours,
  salonSettings,
  serviceCategories,
  services,
  teamMembers,
  testimonials,
  timeSlots,
} from './seed-data.js'

const force = process.argv.includes('--force')

async function seedAdmin() {
  const existing = await queryOne('SELECT id FROM users WHERE email = ? LIMIT 1', [
    config.admin.email,
  ])
  if (existing) {
    console.log(`· Compte admin « ${config.admin.email} » déjà présent.`)
    return
  }
  const hash = await bcrypt.hash(config.admin.password, 12)
  await execute(
    'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
    [config.admin.name, config.admin.email, hash, 'admin'],
  )
  console.log(`✓ Compte admin créé : ${config.admin.email}`)
  if (config.admin.password === 'ChangeMoi2026!') {
    console.log('  ⚠️  Mot de passe par défaut — changez-le dans .env puis relancez le seed.')
  }
}

async function seedSettings() {
  for (const [key, value] of Object.entries(salonSettings)) {
    await execute(
      `INSERT INTO salon_settings (setting_key, setting_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = IF(? = 1, VALUES(setting_value), setting_value)`,
      [key, value, force ? 1 : 0],
    )
  }
  console.log(`✓ ${Object.keys(salonSettings).length} paramètres du salon.`)
}

async function seedSchedule() {
  for (const day of openingHours) {
    await execute(
      `INSERT INTO opening_hours (weekday, is_closed, opens_at, closes_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE is_closed = VALUES(is_closed),
                               opens_at  = VALUES(opens_at),
                               closes_at = VALUES(closes_at)`,
      [day.weekday, day.is_closed, day.opens_at, day.closes_at],
    )
  }
  for (const [index, start] of timeSlots.entries()) {
    await execute(
      `INSERT INTO time_slots (start_time, position, is_active) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE position = VALUES(position)`,
      [start, index],
    )
  }
  console.log(`✓ ${openingHours.length} jours d'ouverture et ${timeSlots.length} créneaux.`)
}

async function seedContent() {
  const [{ total }] = await query('SELECT COUNT(*) AS total FROM services')

  if (total > 0 && !force) {
    console.log('· Contenu déjà présent — utilisez « npm run db:seed -- --force » pour réinsérer.')
    return
  }

  if (force) {
    console.log('· Réinitialisation du contenu (les rendez-vous sont conservés)…')
    const linked = await queryOne('SELECT COUNT(*) AS total FROM appointments')
    if (linked.total > 0) {
      console.log(
        `  ⚠️  ${linked.total} rendez-vous référencent des prestations : elles ne seront pas supprimées, seulement mises à jour.`,
      )
    }
    await execute('DELETE FROM gallery_items')
    await execute('DELETE FROM gallery_categories')
    await execute('DELETE FROM testimonials')
    if (linked.total === 0) {
      await execute('DELETE FROM services')
      await execute('DELETE FROM service_categories')
      await execute('DELETE FROM team_members')
    }
  }

  // Catégories de prestations
  const categoryIds = {}
  for (const [index, category] of serviceCategories.entries()) {
    await execute(
      `INSERT INTO service_categories (slug, name, description, position) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name),
                               description = VALUES(description),
                               position = VALUES(position)`,
      [category.slug, category.name, category.description, index],
    )
    const row = await queryOne('SELECT id FROM service_categories WHERE slug = ?', [category.slug])
    categoryIds[category.slug] = row.id
  }

  // Prestations
  for (const [index, service] of services.entries()) {
    await execute(
      `INSERT INTO services
         (category_id, slug, name, description, duration_minutes, price, currency,
          image_url, is_featured, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE category_id = VALUES(category_id),
                               name = VALUES(name),
                               description = VALUES(description),
                               duration_minutes = VALUES(duration_minutes),
                               price = VALUES(price),
                               image_url = VALUES(image_url),
                               is_featured = VALUES(is_featured),
                               position = VALUES(position)`,
      [
        categoryIds[service.category],
        service.slug,
        service.name,
        service.description,
        service.duration_minutes,
        service.price,
        salonSettings.currency,
        service.image_url,
        service.is_featured,
        index,
      ],
    )
  }
  console.log(`✓ ${serviceCategories.length} catégories et ${services.length} prestations.`)

  // Galerie
  const galleryIds = {}
  for (const [index, category] of galleryCategories.entries()) {
    await execute(
      `INSERT INTO gallery_categories (slug, name, position) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), position = VALUES(position)`,
      [category.slug, category.name, index],
    )
    const row = await queryOne('SELECT id FROM gallery_categories WHERE slug = ?', [category.slug])
    galleryIds[category.slug] = row.id
  }

  for (const [index, item] of galleryItems.entries()) {
    await execute(
      `INSERT INTO gallery_items
         (category_id, title, description, image_url, is_featured, position)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        galleryIds[item.category],
        item.title,
        item.description,
        item.image_url,
        item.is_featured,
        index,
      ],
    )
  }
  console.log(`✓ ${galleryCategories.length} catégories et ${galleryItems.length} réalisations.`)

  // Équipe
  for (const [index, member] of teamMembers.entries()) {
    await execute(
      `INSERT INTO team_members (slug, name, role, specialty, bio, image_url, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name),
                               role = VALUES(role),
                               specialty = VALUES(specialty),
                               bio = VALUES(bio),
                               image_url = VALUES(image_url),
                               position = VALUES(position)`,
      [
        member.slug,
        member.name,
        member.role,
        member.specialty,
        member.bio,
        member.image_url,
        index,
      ],
    )
  }
  console.log(`✓ ${teamMembers.length} membres de l'équipe.`)

  // Avis
  for (const [index, review] of testimonials.entries()) {
    await execute(
      `INSERT INTO testimonials
         (first_name, rating, comment, service_name, reviewed_on, is_published, position)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [
        review.first_name,
        review.rating,
        review.comment,
        review.service_name,
        review.reviewed_on,
        index,
      ],
    )
  }
  console.log(`✓ ${testimonials.length} avis clientes.`)
}

async function main() {
  console.log(`Base : ${config.db.database} sur ${config.db.host}:${config.db.port}\n`)
  await seedAdmin()
  await seedSettings()
  await seedSchedule()
  await seedContent()
  console.log('\n✅ Base prête.')
}

main()
  .catch((error) => {
    console.error('\n❌ Seed impossible :', error.message)
    if (error.code === 'ER_NO_SUCH_TABLE') {
      console.error('   Lancez d’abord « npm run db:migrate ».')
    }
    process.exitCode = 1
  })
  .finally(async () => {
    await closePool().catch(() => {})
    void pool
  })
