-- ─────────────────────────────────────────────────────────────────────────────
-- Suivi complet d'un rendez-vous : présence, bureau, agent, paiement, reçu.
--
-- Migration entièrement additive. Aucune colonne n'est retirée, aucune valeur
-- existante n'est réécrite, aucun rendez-vous déjà enregistré n'est modifié :
-- toutes les colonnes ajoutées sont NULL ou valent 0 par défaut, et les six
-- statuts actuels gardent leur libellé et leur ordre.
--
-- Retour en arrière, si besoin (dans cet ordre) :
--   ALTER TABLE testimonials DROP FOREIGN KEY fk_testimonials_appointment,
--     DROP COLUMN appointment_id;
--   DROP TABLE appointment_documents, appointment_events, appointment_payments;
--   ALTER TABLE appointments DROP FOREIGN KEY fk_appointments_office;
--   ALTER TABLE appointments DROP COLUMN office_id, … (toutes celles ci-dessous);
--   DROP TABLE offices;
--   ALTER TABLE team_members DROP COLUMN phone, DROP COLUMN email,
--     DROP COLUMN works_from, DROP COLUMN works_to;
--   ALTER TABLE appointments MODIFY status
--     ENUM('pending','confirmed','rejected','cancelled','completed','no_show')
--     NOT NULL DEFAULT 'pending';
--   (ce dernier retour échoue s'il existe déjà des rendez-vous « arrived »
--    ou « in_progress » : passez-les d'abord à « confirmed ».)
-- ─────────────────────────────────────────────────────────────────────────────


-- ══════════════════════════════════════════════════════════════════════════
-- 1. Deux étapes intermédiaires entre « confirmé » et « terminé »
-- ══════════════════════════════════════════════════════════════════════════
--
--   confirmed    la décision est prise, la cliente est attendue
--   arrived      la cliente est là, sa présence a été enregistrée
--   in_progress  la prestation a commencé
--   completed    la prestation est finie
--
-- Les six valeurs existantes sont reprises telles quelles, au même rang :
-- aucune ligne n'a besoin d'être réécrite.

ALTER TABLE appointments
  MODIFY status ENUM(
      'pending','confirmed','rejected','cancelled',
      'arrived','in_progress','completed','no_show'
    ) NOT NULL DEFAULT 'pending';


-- ══════════════════════════════════════════════════════════════════════════
-- 2. Agents / coiffeuses
-- ══════════════════════════════════════════════════════════════════════════
--
-- La table `team_members` existe depuis le schéma initial et `appointments`
-- y renvoie déjà par `staff_id` : c'est elle qui porte les agents, il ne lui
-- manquait que de quoi les joindre et de quoi dire quand ils travaillent.
--
-- `works_from` / `works_to` à NULL signifie « suit les horaires du salon ».
-- C'est le cas de tous les agents déjà enregistrés, et c'est le comportement
-- qu'ils avaient avant cette migration.

ALTER TABLE team_members
  ADD COLUMN phone      VARCHAR(40)  NULL AFTER role,
  ADD COLUMN email      VARCHAR(160) NULL AFTER phone,
  ADD COLUMN works_from TIME         NULL AFTER email,
  ADD COLUMN works_to   TIME         NULL AFTER works_from;


-- ══════════════════════════════════════════════════════════════════════════
-- 3. Bureaux / salons
-- ══════════════════════════════════════════════════════════════════════════
--
-- Le numéro est unique : deux bureaux ne peuvent pas le partager, la base
-- le garantit elle-même. Il reste une chaîne et non un entier, pour que
-- « B12 » ou « RDC-3 » soient acceptés aussi bien que « 1 ».
--
-- `agent_id` est l'agent habituellement affecté à ce bureau. Il est
-- seulement proposé au moment du traitement d'un rendez-vous : rien
-- n'empêche d'en choisir un autre ce jour-là.

CREATE TABLE IF NOT EXISTS offices (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  number      VARCHAR(20)  NOT NULL,
  name        VARCHAR(120) NOT NULL,
  agent_id    INT UNSIGNED NULL DEFAULT NULL,
  phone       VARCHAR(40)  NULL DEFAULT NULL,
  email       VARCHAR(160) NULL DEFAULT NULL,
  address     VARCHAR(255) NULL DEFAULT NULL,
  description TEXT NULL,
  image_url   VARCHAR(500) NULL DEFAULT NULL,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  position    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_offices_number (number),
  KEY idx_offices_agent (agent_id),
  CONSTRAINT fk_offices_agent FOREIGN KEY (agent_id)
    REFERENCES team_members (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ══════════════════════════════════════════════════════════════════════════
-- 4. Traitement du rendez-vous
-- ══════════════════════════════════════════════════════════════════════════
--
-- Chaque étape enregistre l'instant ET son auteur. L'auteur est gardé deux
-- fois : `*_by` renvoie au compte, `*_by_name` conserve le nom écrit en
-- toutes lettres. C'est volontaire — un reçu déjà remis doit rester lisible
-- même si le compte qui l'a établi est supprimé plus tard.
--
-- ⚠️ `*_by` (utilisateur du dashboard qui a enregistré l'opération) et
-- `staff_id` (agent qui a réalisé la coiffure) sont deux choses distinctes.
-- Le reçu les présente séparément et ne doit jamais les confondre.

ALTER TABLE appointments
  ADD COLUMN office_id        INT UNSIGNED NULL DEFAULT NULL AFTER staff_id,
  ADD COLUMN arrived_at       DATETIME NULL DEFAULT NULL,
  ADD COLUMN arrived_by       INT UNSIGNED NULL DEFAULT NULL,
  ADD COLUMN arrived_by_name  VARCHAR(120) NULL DEFAULT NULL,
  ADD COLUMN started_at       DATETIME NULL DEFAULT NULL,
  ADD COLUMN started_by       INT UNSIGNED NULL DEFAULT NULL,
  ADD COLUMN started_by_name  VARCHAR(120) NULL DEFAULT NULL,
  ADD COLUMN completed_at     DATETIME NULL DEFAULT NULL,
  ADD COLUMN completed_by     INT UNSIGNED NULL DEFAULT NULL,
  ADD COLUMN completed_by_name VARCHAR(120) NULL DEFAULT NULL,
  ADD COLUMN discount_amount  DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN discount_reason  VARCHAR(32) NULL DEFAULT NULL,
  ADD COLUMN discount_note    VARCHAR(255) NULL DEFAULT NULL,
  ADD COLUMN discount_by      INT UNSIGNED NULL DEFAULT NULL,
  ADD COLUMN discount_by_name VARCHAR(120) NULL DEFAULT NULL,
  ADD COLUMN discount_at      DATETIME NULL DEFAULT NULL,
  ADD COLUMN thanked_at       DATETIME NULL DEFAULT NULL;

ALTER TABLE appointments
  ADD KEY idx_appointments_office (office_id),
  ADD CONSTRAINT fk_appointments_office FOREIGN KEY (office_id)
    REFERENCES offices (id) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE appointments
  ADD CONSTRAINT fk_appointments_arrived_by FOREIGN KEY (arrived_by)
    REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT fk_appointments_started_by FOREIGN KEY (started_by)
    REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT fk_appointments_completed_by FOREIGN KEY (completed_by)
    REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT fk_appointments_discount_by FOREIGN KEY (discount_by)
    REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE;


-- ══════════════════════════════════════════════════════════════════════════
-- 5. Paiements
-- ══════════════════════════════════════════════════════════════════════════
--
-- Une ligne par versement : c'est ce qui permet le paiement partiel. Le
-- montant restant n'est jamais stocké, il se déduit toujours de la somme
-- des versements — une valeur calculée ne peut pas se désynchroniser.
--
-- Le mode reste 'cash' : le salon n'encaisse qu'en espèces. La colonne
-- existe pour que l'ajout d'un autre mode, un jour, ne demande pas de
-- migration.

CREATE TABLE IF NOT EXISTS appointment_payments (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  appointment_id   INT UNSIGNED NOT NULL,
  amount           DECIMAL(10,2) NOT NULL,
  method           VARCHAR(20) NOT NULL DEFAULT 'cash',
  note             VARCHAR(255) NULL DEFAULT NULL,
  recorded_by      INT UNSIGNED NULL DEFAULT NULL,
  recorded_by_name VARCHAR(120) NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_payments_appointment (appointment_id, created_at),
  CONSTRAINT fk_payments_appointment FOREIGN KEY (appointment_id)
    REFERENCES appointments (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_payments_user FOREIGN KEY (recorded_by)
    REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT ck_payments_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ══════════════════════════════════════════════════════════════════════════
-- 6. Journal des opérations
-- ══════════════════════════════════════════════════════════════════════════
--
-- Trace en écriture seule de ce qui a été fait sur un rendez-vous, et par
-- qui. Rien n'y est jamais modifié ni supprimé — sauf avec le rendez-vous
-- lui-même. C'est ce journal que lit l'onglet « Historique » de la fiche.

CREATE TABLE IF NOT EXISTS appointment_events (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  appointment_id INT UNSIGNED NOT NULL,
  kind           VARCHAR(32) NOT NULL,
  label          VARCHAR(255) NOT NULL,
  actor_id       INT UNSIGNED NULL DEFAULT NULL,
  actor_name     VARCHAR(120) NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_events_appointment (appointment_id, created_at),
  CONSTRAINT fk_events_appointment FOREIGN KEY (appointment_id)
    REFERENCES appointments (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_events_user FOREIGN KEY (actor_id)
    REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ══════════════════════════════════════════════════════════════════════════
-- 7. Proformas et reçus
-- ══════════════════════════════════════════════════════════════════════════
--
-- Le PDF n'est pas stocké : il est réimprimé à la demande. Ce qui est
-- stocké, c'est son NUMÉRO et l'état exact des montants au moment de son
-- établissement (`snapshot`). Un reçu remis à une cliente ne doit pas
-- changer parce qu'une réduction a été saisie après coup — il est donc
-- toujours réimprimé depuis son instantané, jamais depuis la fiche vivante.
--
-- `snapshot` est du JSON rangé dans un LONGTEXT plutôt que dans une colonne
-- JSON : le type JSON n'existe pas sur toutes les versions de MariaDB
-- encore en service, et l'API n'a besoin d'aucune requête à l'intérieur.

CREATE TABLE IF NOT EXISTS appointment_documents (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  appointment_id INT UNSIGNED NOT NULL,
  kind           ENUM('proforma','receipt') NOT NULL,
  number         VARCHAR(32) NOT NULL,
  snapshot       LONGTEXT NULL,
  issued_by      INT UNSIGNED NULL DEFAULT NULL,
  issued_by_name VARCHAR(120) NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_documents_number (number),
  KEY idx_documents_appointment (appointment_id, kind, created_at),
  CONSTRAINT fk_documents_appointment FOREIGN KEY (appointment_id)
    REFERENCES appointments (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_documents_user FOREIGN KEY (issued_by)
    REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ══════════════════════════════════════════════════════════════════════════
-- 8. Rattacher un avis à la prestation qui l'a inspiré
-- ══════════════════════════════════════════════════════════════════════════
--
-- La colonne est NULLable et tous les avis déjà publiés le restent : un avis
-- sans rendez-vous rattaché est parfaitement valide, il s'affiche exactement
-- comme avant sur le site public. ON DELETE SET NULL — supprimer un
-- rendez-vous ne doit jamais effacer l'avis d'une cliente.

ALTER TABLE testimonials
  ADD COLUMN appointment_id INT UNSIGNED NULL DEFAULT NULL AFTER id,
  ADD KEY idx_testimonials_appointment (appointment_id),
  ADD CONSTRAINT fk_testimonials_appointment FOREIGN KEY (appointment_id)
    REFERENCES appointments (id) ON DELETE SET NULL ON UPDATE CASCADE;


-- ══════════════════════════════════════════════════════════════════════════
-- 9. Réglages du calcul de capacité
-- ══════════════════════════════════════════════════════════════════════════
--
-- `capacity_include_pending` = 1 : une demande encore en attente occupe déjà
-- un agent dans le calcul. C'est le réglage prudent — il évite de promettre
-- un créneau que le salon s'apprête peut-être à confirmer pour une autre.
-- Le passer à 0 depuis les paramètres du salon rend les dates plus ouvertes.
--
-- INSERT IGNORE : si la clé existe déjà, la valeur en place est conservée.

INSERT IGNORE INTO salon_settings (setting_key, setting_value)
VALUES ('capacity_include_pending', '1');
