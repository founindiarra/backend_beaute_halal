-- ════════════════════════════════════════════════════════════
--  Beauté Halal — schéma initial
--  MySQL 5.7+ / MariaDB 10.4+  ·  utf8mb4
-- ════════════════════════════════════════════════════════════

-- ── Comptes du salon (accès au futur tableau de bord) ──
CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(160) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('admin','staff') NOT NULL DEFAULT 'staff',
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Informations du salon (clé / valeur, modifiables par l'admin) ──
CREATE TABLE IF NOT EXISTS salon_settings (
  setting_key   VARCHAR(64) NOT NULL,
  setting_value TEXT NULL,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Horaires d'ouverture (0 = dimanche … 6 = samedi) ──
CREATE TABLE IF NOT EXISTS opening_hours (
  id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  weekday   TINYINT UNSIGNED NOT NULL,
  is_closed TINYINT(1) NOT NULL DEFAULT 0,
  opens_at  TIME NULL DEFAULT NULL,
  closes_at TIME NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_opening_hours_weekday (weekday)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Créneaux proposés à la réservation ──
CREATE TABLE IF NOT EXISTS time_slots (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  start_time TIME NOT NULL,
  position   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_time_slots_start (start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Fermetures exceptionnelles (congés, jours fériés) ──
CREATE TABLE IF NOT EXISTS closures (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  closure_date DATE NOT NULL,
  reason       VARCHAR(160) NULL DEFAULT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_closures_date (closure_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Catégories de prestations ──
CREATE TABLE IF NOT EXISTS service_categories (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug        VARCHAR(120) NOT NULL,
  name        VARCHAR(120) NOT NULL,
  description TEXT NULL,
  position    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_categories_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Prestations ──
CREATE TABLE IF NOT EXISTS services (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_id      INT UNSIGNED NOT NULL,
  slug             VARCHAR(140) NOT NULL,
  name             VARCHAR(140) NOT NULL,
  description      TEXT NULL,
  duration_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 60,
  price            DECIMAL(10,2) NOT NULL DEFAULT 0,
  currency         VARCHAR(8) NOT NULL DEFAULT 'FCFA',
  image_url        VARCHAR(500) NULL,
  is_featured      TINYINT(1) NOT NULL DEFAULT 0,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  position         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_services_slug (slug),
  KEY idx_services_category (category_id),
  KEY idx_services_active (is_active, is_featured),
  CONSTRAINT fk_services_category FOREIGN KEY (category_id)
    REFERENCES service_categories (id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Catégories de la galerie ──
CREATE TABLE IF NOT EXISTS gallery_categories (
  id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug      VARCHAR(120) NOT NULL,
  name      VARCHAR(120) NOT NULL,
  position  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gallery_categories_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Réalisations ──
CREATE TABLE IF NOT EXISTS gallery_items (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_id INT UNSIGNED NOT NULL,
  title       VARCHAR(160) NOT NULL,
  description TEXT NULL,
  image_url   VARCHAR(500) NOT NULL,
  is_featured TINYINT(1) NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  position    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_gallery_category (category_id),
  KEY idx_gallery_active (is_active, is_featured),
  CONSTRAINT fk_gallery_category FOREIGN KEY (category_id)
    REFERENCES gallery_categories (id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Équipe ──
CREATE TABLE IF NOT EXISTS team_members (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug       VARCHAR(120) NOT NULL,
  name       VARCHAR(120) NOT NULL,
  role       VARCHAR(140) NOT NULL,
  specialty  VARCHAR(180) NULL,
  bio        TEXT NULL,
  image_url  VARCHAR(500) NULL,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  position   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_team_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Avis clientes ──
CREATE TABLE IF NOT EXISTS testimonials (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  first_name   VARCHAR(80) NOT NULL,
  rating       TINYINT UNSIGNED NOT NULL DEFAULT 5,
  comment      TEXT NOT NULL,
  service_name VARCHAR(140) NULL,
  reviewed_on  DATE NULL,
  is_published TINYINT(1) NOT NULL DEFAULT 1,
  position     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_testimonials_published (is_published),
  CONSTRAINT ck_testimonials_rating CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Rendez-vous ──
-- La colonne générée « slot_lock » vaut NULL pour un rendez-vous annulé et
-- « date heure » sinon : l'index unique garantit donc, au niveau de la base,
-- qu'un même créneau ne peut jamais être réservé deux fois.
CREATE TABLE IF NOT EXISTS appointments (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference        VARCHAR(16) NOT NULL,
  service_id       INT UNSIGNED NOT NULL,
  staff_id         INT UNSIGNED NULL DEFAULT NULL,
  service_name     VARCHAR(140) NOT NULL,
  appointment_date DATE NOT NULL,
  appointment_time TIME NOT NULL,
  duration_minutes SMALLINT UNSIGNED NOT NULL,
  price            DECIMAL(10,2) NOT NULL DEFAULT 0,
  currency         VARCHAR(8) NOT NULL DEFAULT 'FCFA',
  first_name       VARCHAR(80) NOT NULL,
  last_name        VARCHAR(80) NOT NULL,
  phone            VARCHAR(40) NOT NULL,
  email            VARCHAR(160) NOT NULL,
  note             TEXT NULL,
  status           ENUM('pending','confirmed','cancelled','completed','no_show')
                     NOT NULL DEFAULT 'pending',
  source           VARCHAR(20) NOT NULL DEFAULT 'website',
  cancel_reason    VARCHAR(255) NULL DEFAULT NULL,
  confirmed_at     DATETIME NULL DEFAULT NULL,
  cancelled_at     DATETIME NULL DEFAULT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  slot_lock        VARCHAR(32) AS (
                     IF(status = 'cancelled', NULL,
                        CONCAT(appointment_date, ' ', appointment_time))
                   ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_appointments_reference (reference),
  UNIQUE KEY uq_appointments_slot (slot_lock),
  KEY idx_appointments_date (appointment_date, status),
  KEY idx_appointments_email (email),
  CONSTRAINT fk_appointments_service FOREIGN KEY (service_id)
    REFERENCES services (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_appointments_staff FOREIGN KEY (staff_id)
    REFERENCES team_members (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Messages du formulaire de contact ──
CREATE TABLE IF NOT EXISTS contact_messages (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(120) NOT NULL,
  email      VARCHAR(160) NOT NULL,
  phone      VARCHAR(40) NULL,
  message    TEXT NOT NULL,
  status     ENUM('new','read','archived') NOT NULL DEFAULT 'new',
  ip_address VARCHAR(45) NULL,
  read_at    DATETIME NULL DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_contact_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
