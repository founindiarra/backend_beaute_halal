/**
 * Jeu de données de démarrage — reprend exactement le contenu affiché
 * aujourd'hui par le site. ⚠️ DONNÉES FICTIVES, à remplacer par les
 * informations réelles du salon (depuis phpMyAdmin ou l'API admin).
 */

const u = (id, w = 1200) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=80`

export const images = {
  hero: u('1625536658395-2bd89a631e37', 1600),
  locks1: u('1551493923-9a1b98921caa'),
  locks2: u('1535146981003-d37e3e2428c3'),
  locks3: u('1635627091599-aedcf8241102'),
  locks4: u('1662991859083-86e0b45208b0'),
  locks5: u('1625536658679-42d76fd167c0'),
  locks6: u('1653263169788-9332cdbf07f5'),
  locks7: u('1616166183781-0fdd2ef83374'),
  locks8: u('1625536658536-a94c4349850b'),
  locks9: u('1625536658660-dc9860965ca5'),
  locks10: u('1630488971092-ebf24950529f'),
  locks11: u('1606459249576-f00b2e5e0917'),
  locks12: u('1624561272659-224ea122b2e9'),
  gesture1: u('1672788694268-ecc234591d31'),
  gesture2: u('1663851071150-b6617bbee927'),
  gesture3: u('1647462742006-adc8b77b52d2'),
  gesture4: u('1629397662621-0d4b8e82801f'),
  gesture5: u('1575287537815-ef82dd922198'),
  portrait1: u('1531123897727-8f129e1688ce', 800),
  portrait2: u('1593351799227-75df2026356b', 800),
  portrait3: u('1619694770795-e21c58464159', 800),
  portrait4: u('1629145810320-aec9e63dd798', 800),
}

// ── Informations du salon (placeholders clairement remplaçables) ──
export const salonSettings = {
  name: 'Beauté Halal',
  specialty: 'Spécialiste des locks',
  tagline: 'L’art des locks, avec soin et élégance',
  short_description:
    'Un salon dédié aux locks : création, entretien, réparation, coiffure, coloration et soins, dans un cadre calme et chaleureux.',
  phone_display: '+225 00 00 00 00',
  phone_href: 'tel:+22500000000',
  whatsapp_number: '',
  whatsapp_default_message:
    'Bonjour Beauté Halal, je souhaite obtenir des informations sur vos prestations.',
  email: 'contact@beaute-halal.example',
  address_line1: '00, rue à compléter',
  address_line2: 'Quartier à compléter',
  address_city: 'Ville à compléter',
  address_country: 'Pays à compléter',
  address_note: 'Adresse indicative — à remplacer par l’adresse exacte du salon.',
  map_embed_url: 'https://maps.google.com/maps?q=Abidjan&z=12&output=embed',
  social_instagram: '',
  social_facebook: '',
  social_tiktok: '',
  currency: 'FCFA',
  booking_window_days: '60',
}

// ── Horaires (0 = dimanche … 6 = samedi) ──
export const openingHours = [
  { weekday: 0, is_closed: 1, opens_at: null, closes_at: null },
  { weekday: 1, is_closed: 1, opens_at: null, closes_at: null },
  { weekday: 2, is_closed: 0, opens_at: '09:00:00', closes_at: '18:00:00' },
  { weekday: 3, is_closed: 0, opens_at: '09:00:00', closes_at: '18:00:00' },
  { weekday: 4, is_closed: 0, opens_at: '09:00:00', closes_at: '18:00:00' },
  { weekday: 5, is_closed: 0, opens_at: '09:00:00', closes_at: '18:00:00' },
  { weekday: 6, is_closed: 0, opens_at: '09:00:00', closes_at: '19:00:00' },
]

export const timeSlots = ['09:00:00', '10:00:00', '11:30:00', '14:00:00', '15:30:00', '17:00:00']

// ── Catégories de prestations ──
export const serviceCategories = [
  {
    slug: 'creation',
    name: 'Création',
    description: 'Le point de départ de vos locks, pensé selon votre texture et votre projet.',
  },
  {
    slug: 'entretien',
    name: 'Entretien',
    description: 'Des racines nettes et des longueurs saines, à un rythme adapté à vos cheveux.',
  },
  {
    slug: 'reparation',
    name: 'Réparation',
    description: 'Renforcer, reconstruire, rattraper : redonner de la tenue à des locks fragilisées.',
  },
  {
    slug: 'coiffure',
    name: 'Coiffure',
    description: 'Des mises en forme élégantes, du quotidien aux grandes occasions.',
  },
  {
    slug: 'coloration',
    name: 'Coloration',
    description: 'Des nuances travaillées avec précaution pour préserver la fibre.',
  },
  {
    slug: 'soins',
    name: 'Soins',
    description: 'Nettoyage, hydratation et soin du cuir chevelu, la base de belles locks.',
  },
]

// ── Prestations ──
export const services = [
  {
    slug: 'creation-de-locks',
    category: 'creation',
    name: 'Création de locks',
    description:
      'Création complète de vos locks, méthode choisie ensemble après un diagnostic du cheveu et de votre style de vie.',
    duration_minutes: 300,
    price: 60000,
    image_url: images.locks1,
    is_featured: 1,
  },
  {
    slug: 'starter-locks',
    category: 'creation',
    name: 'Starter locks',
    description:
      'Départ de locks sur cheveux courts, avec section régulière et conseils d’entretien des premières semaines.',
    duration_minutes: 210,
    price: 45000,
    image_url: images.locks7,
    is_featured: 0,
  },
  {
    slug: 'retwist',
    category: 'entretien',
    name: 'Retwist',
    description:
      'Reprise des racines, tension maîtrisée et finition nette pour des locks bien alignées.',
    duration_minutes: 120,
    price: 20000,
    image_url: images.gesture1,
    is_featured: 1,
  },
  {
    slug: 'entretien-classique',
    category: 'entretien',
    name: 'Entretien classique',
    description:
      'Lavage, retwist et séchage : la routine complète pour garder des locks propres et souples.',
    duration_minutes: 150,
    price: 27000,
    image_url: images.gesture2,
    is_featured: 0,
  },
  {
    slug: 'entretien-coiffure',
    category: 'entretien',
    name: 'Entretien + coiffure',
    description:
      'L’entretien complet suivi d’une mise en forme au choix, pour repartir prête pour l’occasion.',
    duration_minutes: 195,
    price: 38000,
    image_url: images.locks4,
    is_featured: 0,
  },
  {
    slug: 'reparation-de-locks',
    category: 'reparation',
    name: 'Réparation de locks',
    description:
      'Réparation des locks cassées ou amincies, lock par lock, pour retrouver une longueur homogène.',
    duration_minutes: 180,
    price: 35000,
    image_url: images.gesture3,
    is_featured: 1,
  },
  {
    slug: 'renforcement',
    category: 'reparation',
    name: 'Renforcement',
    description:
      'Consolidation des racines fragilisées et des zones de tension, avec un protocole de soin adapté.',
    duration_minutes: 120,
    price: 25000,
    image_url: images.gesture4,
    is_featured: 0,
  },
  {
    slug: 'reconstruction',
    category: 'reparation',
    name: 'Reconstruction',
    description:
      'Reprise en profondeur d’un ensemble abîmé : sections revues, longueurs rattrapées, équilibre retrouvé.',
    duration_minutes: 270,
    price: 55000,
    image_url: images.locks8,
    is_featured: 0,
  },
  {
    slug: 'coiffures-sur-locks',
    category: 'coiffure',
    name: 'Coiffures sur locks',
    description:
      'Chignons, tresses, attaches hautes ou basses : une coiffure élégante pensée pour tenir toute la journée.',
    duration_minutes: 90,
    price: 18000,
    image_url: images.locks2,
    is_featured: 1,
  },
  {
    slug: 'styles-specifiques',
    category: 'coiffure',
    name: 'Styles spécifiques',
    description:
      'Coiffures de cérémonie et créations sur mesure, préparées ensemble avant le rendez-vous.',
    duration_minutes: 150,
    price: 32000,
    image_url: images.locks3,
    is_featured: 0,
  },
  {
    slug: 'coloration',
    category: 'coloration',
    name: 'Coloration',
    description:
      'Coloration sur locks avec test préalable, pour une nuance homogène et un cheveu respecté.',
    duration_minutes: 180,
    price: 42000,
    image_url: images.locks5,
    is_featured: 1,
  },
  {
    slug: 'decoloration',
    category: 'coloration',
    name: 'Décoloration',
    description:
      'Éclaircissement progressif et contrôlé, accompagné d’un soin reconstructeur systématique.',
    duration_minutes: 210,
    price: 50000,
    image_url: images.locks9,
    is_featured: 0,
  },
  {
    slug: 'patine',
    category: 'coloration',
    name: 'Patine',
    description: 'Correction et raffinement de la nuance pour un résultat plus doux et lumineux.',
    duration_minutes: 60,
    price: 15000,
    image_url: images.locks10,
    is_featured: 0,
  },
  {
    slug: 'soin-profond',
    category: 'soins',
    name: 'Soin profond',
    description:
      'Bain de soin nourrissant en profondeur, idéal après une coloration ou en période sèche.',
    duration_minutes: 75,
    price: 16000,
    image_url: images.gesture5,
    is_featured: 1,
  },
  {
    slug: 'hydratation',
    category: 'soins',
    name: 'Hydratation',
    description:
      'Rituel d’hydratation pour redonner souplesse et brillance à des locks qui manquent d’eau.',
    duration_minutes: 60,
    price: 12000,
    image_url: images.locks6,
    is_featured: 0,
  },
  {
    slug: 'nettoyage',
    category: 'soins',
    name: 'Nettoyage',
    description: 'Nettoyage en profondeur qui élimine les résidus accumulés et allège les locks.',
    duration_minutes: 75,
    price: 14000,
    image_url: images.locks11,
    is_featured: 0,
  },
  {
    slug: 'soin-du-cuir-chevelu',
    category: 'soins',
    name: 'Soin du cuir chevelu',
    description:
      'Apaisement et rééquilibrage du cuir chevelu, avec massage et conseils personnalisés.',
    duration_minutes: 60,
    price: 13000,
    image_url: images.locks12,
    is_featured: 0,
  },
]

// ── Galerie ──
export const galleryCategories = [
  { slug: 'creation', name: 'Création' },
  { slug: 'entretien', name: 'Entretien' },
  { slug: 'coiffure', name: 'Coiffure' },
  { slug: 'coloration', name: 'Coloration' },
  { slug: 'avant-apres', name: 'Avant / Après' },
]

export const galleryItems = [
  { title: 'Création de locks moyennes', category: 'creation', description: 'Sections régulières et départ net sur cheveux naturels.', image_url: images.locks1, is_featured: 1 },
  { title: 'Retwist finition brillante', category: 'entretien', description: 'Racines reprises et longueurs lissées, tension maîtrisée.', image_url: images.gesture1, is_featured: 1 },
  { title: 'Chignon haut sur locks', category: 'coiffure', description: 'Une attache haute élégante, tenue toute la journée.', image_url: images.locks2, is_featured: 1 },
  { title: 'Nuance caramel', category: 'coloration', description: 'Coloration chaude appliquée sur longueurs et pointes.', image_url: images.locks5, is_featured: 1 },
  { title: 'Reconstruction complète', category: 'avant-apres', description: 'Locks amincies renforcées puis réalignées.', image_url: images.locks8, is_featured: 1 },
  { title: 'Starter locks cheveux courts', category: 'creation', description: 'Départ court, sections fines et régulières.', image_url: images.locks7, is_featured: 1 },
  { title: 'Entretien classique', category: 'entretien', description: 'Lavage, retwist et séchage naturel.', image_url: images.gesture2, is_featured: 0 },
  { title: 'Coiffure de cérémonie', category: 'coiffure', description: 'Mise en forme travaillée pour une grande occasion.', image_url: images.locks3, is_featured: 0 },
  { title: 'Éclaircissement progressif', category: 'coloration', description: 'Décoloration douce accompagnée d’un soin reconstructeur.', image_url: images.locks9, is_featured: 0 },
  { title: 'Avant / Après entretien', category: 'avant-apres', description: 'Racines reprises après plusieurs semaines sans entretien.', image_url: images.gesture3, is_featured: 0 },
  { title: 'Locks longues soignées', category: 'entretien', description: 'Longueurs hydratées et pointes refermées.', image_url: images.locks4, is_featured: 0 },
  { title: 'Attache basse tressée', category: 'coiffure', description: 'Un style sobre, parfait au quotidien.', image_url: images.locks6, is_featured: 0 },
  { title: 'Patine douce', category: 'coloration', description: 'Correction de nuance pour un rendu plus lumineux.', image_url: images.locks10, is_featured: 0 },
  { title: 'Départ de locks fines', category: 'creation', description: 'Sections fines pour un rendu léger et mobile.', image_url: images.locks11, is_featured: 0 },
  { title: 'Renforcement des racines', category: 'avant-apres', description: 'Zones de tension consolidées puis soignées.', image_url: images.gesture4, is_featured: 0 },
]

// ── Équipe ──
export const teamMembers = [
  {
    slug: 'aminata',
    name: 'Aminata',
    role: 'Fondatrice & loctician',
    specialty: 'Création et reconstruction de locks',
    bio: 'Elle a fondé le salon autour d’une idée simple : des locks bien faites tiennent dans le temps. Elle accompagne chaque cliente depuis le premier départ jusqu’à l’entretien régulier.',
    image_url: images.portrait1,
  },
  {
    slug: 'fatou',
    name: 'Fatou',
    role: 'Loctician senior',
    specialty: 'Retwist et entretien',
    bio: 'Précise et patiente, elle est reconnue pour la régularité de ses racines et la propreté de ses finitions, même sur les chevelures les plus denses.',
    image_url: images.portrait2,
  },
  {
    slug: 'mariam',
    name: 'Mariam',
    role: 'Coloriste',
    specialty: 'Coloration, décoloration et patine',
    bio: 'Elle travaille la couleur avec prudence : test préalable, protocole de soin systématique et nuances choisies avec vous avant toute application.',
    image_url: images.portrait3,
  },
  {
    slug: 'salimata',
    name: 'Salimata',
    role: 'Spécialiste soins',
    specialty: 'Soins du cheveu et du cuir chevelu',
    bio: 'Elle établit un diagnostic avant chaque prestation et construit des routines simples à tenir à la maison, entre deux rendez-vous.',
    image_url: images.portrait4,
  },
]

// ── Avis ──
export const testimonials = [
  { first_name: 'Awa', rating: 5, reviewed_on: '2026-07-12', service_name: 'Création de locks', comment: 'On m’a expliqué chaque étape avant de commencer. Six mois plus tard, mes locks sont régulières et je n’ai eu aucune casse.' },
  { first_name: 'Nadia', rating: 5, reviewed_on: '2026-06-28', service_name: 'Retwist', comment: 'La finition est nette et la tension est douce. C’est le premier salon où je ne repars pas avec des racines douloureuses.' },
  { first_name: 'Kadiatou', rating: 4, reviewed_on: '2026-06-05', service_name: 'Coloration', comment: 'Le test de couleur avant le rendez-vous m’a rassurée. Le résultat est exactement la nuance que nous avions choisie ensemble.' },
  { first_name: 'Sarah', rating: 5, reviewed_on: '2026-05-19', service_name: 'Réparation de locks', comment: 'Trois de mes locks étaient cassées, je pensais devoir tout recommencer. Elles ont été reprises une par une, on ne voit plus rien.' },
  { first_name: 'Mariam', rating: 5, reviewed_on: '2026-04-30', service_name: 'Entretien + coiffure', comment: 'Le salon est calme et l’accueil est vraiment chaleureux. J’y viens désormais toutes les six semaines.' },
  { first_name: 'Léa', rating: 4, reviewed_on: '2026-04-11', service_name: 'Soin profond', comment: 'Mes longueurs étaient très sèches. Après le soin et les conseils donnés, elles sont nettement plus souples.' },
]
