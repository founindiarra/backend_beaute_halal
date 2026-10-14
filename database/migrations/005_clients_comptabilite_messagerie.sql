-- ─────────────────────────────────────────────────────────────────────────────
-- Clientes, comptabilité et messagerie.
--
-- Migration additive : aucune colonne retirée, aucune ligne existante
-- réécrite — hormis deux reprises explicites, signalées en fin de fichier,
-- qui ne font que recopier dans les nouvelles tables ce qui est déjà en base.
--
-- Retour en arrière (dans cet ordre) :
--   DROP TABLE message_logs, ledger_entries, expense_categories, cash_accounts;
--   ALTER TABLE appointments DROP FOREIGN KEY fk_appointments_customer,
--     DROP COLUMN customer_id;
--   DROP TABLE customers;
--   DELETE FROM salon_settings WHERE setting_key LIKE 'sms_%'
--     OR setting_key IN ('birthday_enabled','birthday_template');
-- ─────────────────────────────────────────────────────────────────────────────


-- ══════════════════════════════════════════════════════════════════════════
-- 1. Les clientes
-- ══════════════════════════════════════════════════════════════════════════
--
-- Le NUMÉRO DE TÉLÉPHONE fait office de matricule. Deux rendez-vous pris à
-- dix jours d'écart avec le même numéro sont la même personne ; pris avec
-- deux numéros différents, ce sont deux personnes — même si le nom saisi se
-- ressemble. Rapprocher sur les noms finirait par fusionner deux clientes
-- homonymes, ce qui est bien pire que d'en compter une de trop.
--
-- `phone_key` est le numéro réduit à ses chiffres, indicatif pays retiré :
-- c'est lui qui porte l'unicité, pour que « 07 00 00 00 01 »,
-- « +225 07 00 00 00 01 » et « 00225 0700000001 » désignent bien la même
-- cliente. `phone` garde la forme telle qu'elle a été saisie, c'est celle
-- qu'on réaffiche.
--
-- L'indicatif n'est retiré QUE s'il reste un numéro d'au moins huit chiffres
-- derrière. Couper aveuglément aux dix derniers chiffres mutilerait les
-- anciens numéros à huit chiffres, encore présents dans de vieilles fiches :
-- « 225 07000001 » deviendrait « 5 07000001 », et la cliente serait comptée
-- deux fois. La même règle, au caractère près, est appliquée côté API par
-- `normaliserTelephone()` — les deux doivent rester d'accord.

CREATE TABLE IF NOT EXISTS customers (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  phone         VARCHAR(40)  NOT NULL,
  phone_key     VARCHAR(20)  NOT NULL,
  first_name    VARCHAR(80)  NOT NULL,
  last_name     VARCHAR(80)  NOT NULL,
  email         VARCHAR(160) NULL DEFAULT NULL,
  birth_date    DATE NULL DEFAULT NULL,
  note          TEXT NULL,
  /* Une cliente peut refuser les messages. Par défaut on considère qu'elle
     accepte : elle a laissé son numéro pour être rappelée. */
  sms_opt_in    TINYINT(1) NOT NULL DEFAULT 1,
  email_opt_in  TINYINT(1) NOT NULL DEFAULT 1,
  first_seen_at DATETIME NULL DEFAULT NULL,
  last_seen_at  DATETIME NULL DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customers_phone_key (phone_key),
  KEY idx_customers_name (last_name, first_name),
  KEY idx_customers_birth (birth_date),
  KEY idx_customers_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Le rendez-vous garde ses propres coordonnées (elles peuvent différer d'une
-- fois sur l'autre) et gagne un lien vers la fiche. ON DELETE SET NULL :
-- supprimer une fiche cliente ne doit jamais effacer un rendez-vous ni un
-- reçu déjà remis.
ALTER TABLE appointments
  ADD COLUMN customer_id INT UNSIGNED NULL DEFAULT NULL AFTER id,
  ADD KEY idx_appointments_customer (customer_id),
  ADD CONSTRAINT fk_appointments_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE SET NULL ON UPDATE CASCADE;


-- ══════════════════════════════════════════════════════════════════════════
-- 2. Comptabilité — les comptes
-- ══════════════════════════════════════════════════════════════════════════
--
-- Un seul type de table pour la caisse et les banques : ce sont deux endroits
-- où de l'argent se trouve, et un transfert de l'un vers l'autre n'est qu'une
-- écriture de sortie suivie d'une écriture d'entrée. Les distinguer par des
-- tables séparées aurait fait deux fois le même code.
--
-- La caisse (`kind = 'cash'`) est créée par cette migration et ne devrait pas
-- être supprimée : c'est par elle que tous les encaissements passent.

CREATE TABLE IF NOT EXISTS cash_accounts (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind           ENUM('cash','bank') NOT NULL DEFAULT 'bank',
  name           VARCHAR(120) NOT NULL,
  bank_name      VARCHAR(120) NULL DEFAULT NULL,
  account_number VARCHAR(60)  NULL DEFAULT NULL,
  note           VARCHAR(255) NULL DEFAULT NULL,
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  position       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  /* Un même numéro ne peut pas exister deux fois dans la même banque. */
  UNIQUE KEY uq_accounts_bank_number (bank_name, account_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS expense_categories (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(120) NOT NULL,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  position   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_expense_categories_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ══════════════════════════════════════════════════════════════════════════
-- 3. Comptabilité — le grand livre
-- ══════════════════════════════════════════════════════════════════════════
--
-- UNE SEULE table pour tout ce qui bouge : encaissements, dépenses,
-- transferts. Le solde d'un compte n'est jamais stocké — il se calcule en
-- additionnant ses écritures. Un solde stocké finit toujours par diverger de
-- ses composantes, et on ne sait alors plus laquelle croire.
--
-- `amount` est TOUJOURS positif ; c'est `direction` qui dit le sens. Des
-- montants signés se prêtent trop facilement à un signe oublié dans une
-- somme.
--
-- Les deux moitiés d'un transfert partagent le même `transfer_ref` : c'est ce
-- qui permet de les afficher comme une seule opération et de les annuler
-- ensemble.
--
-- `payment_id` est unique quand il est renseigné : un versement encaissé ne
-- peut entrer qu'une fois en caisse, la base s'en porte garante.

CREATE TABLE IF NOT EXISTS ledger_entries (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id       INT UNSIGNED NOT NULL,
  kind             ENUM('payment','expense','transfer','adjustment') NOT NULL,
  direction        ENUM('in','out') NOT NULL,
  amount           DECIMAL(12,2) NOT NULL,
  currency         VARCHAR(8) NOT NULL DEFAULT 'FCFA',
  label            VARCHAR(255) NOT NULL,
  occurred_on      DATE NOT NULL,
  category_id      INT UNSIGNED NULL DEFAULT NULL,
  appointment_id   INT UNSIGNED NULL DEFAULT NULL,
  payment_id       INT UNSIGNED NULL DEFAULT NULL,
  transfer_ref     VARCHAR(32) NULL DEFAULT NULL,
  recorded_by      INT UNSIGNED NULL DEFAULT NULL,
  recorded_by_name VARCHAR(120) NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ledger_payment (payment_id),
  KEY idx_ledger_account (account_id, occurred_on),
  KEY idx_ledger_kind (kind, occurred_on),
  KEY idx_ledger_transfer (transfer_ref),
  CONSTRAINT fk_ledger_account FOREIGN KEY (account_id)
    REFERENCES cash_accounts (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_ledger_category FOREIGN KEY (category_id)
    REFERENCES expense_categories (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_ledger_appointment FOREIGN KEY (appointment_id)
    REFERENCES appointments (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_ledger_payment FOREIGN KEY (payment_id)
    REFERENCES appointment_payments (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_ledger_user FOREIGN KEY (recorded_by)
    REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT ck_ledger_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ══════════════════════════════════════════════════════════════════════════
-- 4. Journal des envois
-- ══════════════════════════════════════════════════════════════════════════
--
-- SMS et e-mails dans la même table : ce qui intéresse le salon, c'est
-- « qu'a-t-on envoyé à qui, et quand », pas le moyen de transport.
--
-- Le message est conservé en entier. Quand une cliente dit « je n'ai rien
-- reçu », c'est la seule façon de savoir ce qui est parti — et une réponse
-- d'API gardée telle quelle (`provider_response`) explique les échecs bien
-- mieux qu'un code.

CREATE TABLE IF NOT EXISTS message_logs (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  channel           ENUM('sms','email') NOT NULL,
  kind              VARCHAR(32) NOT NULL DEFAULT 'manual',
  customer_id       INT UNSIGNED NULL DEFAULT NULL,
  appointment_id    INT UNSIGNED NULL DEFAULT NULL,
  recipient         VARCHAR(160) NOT NULL,
  subject           VARCHAR(255) NULL DEFAULT NULL,
  body              TEXT NOT NULL,
  status            ENUM('queued','sent','failed','skipped') NOT NULL DEFAULT 'queued',
  provider_reference VARCHAR(160) NULL DEFAULT NULL,
  provider_response TEXT NULL,
  error             VARCHAR(255) NULL DEFAULT NULL,
  campaign_ref      VARCHAR(32) NULL DEFAULT NULL,
  sent_by           INT UNSIGNED NULL DEFAULT NULL,
  sent_by_name      VARCHAR(120) NOT NULL DEFAULT 'Système',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at           DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_messages_customer (customer_id, created_at),
  KEY idx_messages_status (status, created_at),
  KEY idx_messages_kind (kind, created_at),
  KEY idx_messages_campaign (campaign_ref),
  CONSTRAINT fk_messages_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_messages_appointment FOREIGN KEY (appointment_id)
    REFERENCES appointments (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_messages_user FOREIGN KEY (sent_by)
    REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ══════════════════════════════════════════════════════════════════════════
-- 5. Réglages
-- ══════════════════════════════════════════════════════════════════════════
--
-- INSERT IGNORE : une clé déjà présente garde sa valeur. Ces réglages
-- s'éditent ensuite depuis « Paramètres du salon ».

INSERT IGNORE INTO salon_settings (setting_key, setting_value) VALUES
  ('birthday_enabled',  '0'),
  ('birthday_channel',  'sms'),
  ('birthday_template',
   'Bonjour {prenom}, toute l''équipe de Beauté Halal vous souhaite un très joyeux anniversaire. À très bientôt au salon.'),
  ('sms_sender_name',   'BeauteHalal');


-- ══════════════════════════════════════════════════════════════════════════
-- 6. Reprise de l'existant
-- ══════════════════════════════════════════════════════════════════════════
--
-- Deux recopies, et rien d'autre. Elles ne modifient aucune donnée : elles
-- remplissent les tables neuves à partir de ce qui est déjà en base, pour que
-- la comptabilité et la liste des clientes ne démarrent pas vides.

-- ── 6·0. La règle du matricule, écrite une fois ──
--
-- Fonction SQL plutôt qu'expression recopiée : la reprise ci-dessous et le
-- rattachement l'utilisent tous deux, et une règle recopiée deux fois finit
-- toujours par diverger. DETERMINISTIC : même entrée, même sortie, ce qui
-- permet de l'employer dans une jointure indexée.

DROP FUNCTION IF EXISTS bh_phone_key;

CREATE FUNCTION bh_phone_key(saisie VARCHAR(40))
RETURNS VARCHAR(20) DETERMINISTIC
RETURN (
  SELECT CASE
    /* 00225 xxxxxxxx — forme internationale longue */
    WHEN LEFT(d, 5) = '00225' AND CHAR_LENGTH(d) - 5 >= 8 THEN SUBSTRING(d, 6)
    /* 225 xxxxxxxx — forme internationale courte */
    WHEN LEFT(d, 3) = '225'   AND CHAR_LENGTH(d) - 3 >= 8 THEN SUBSTRING(d, 4)
    ELSE d
  END
  FROM (SELECT REGEXP_REPLACE(COALESCE(saisie, ''), '[^0-9]', '') AS d) AS chiffres
);

-- ── 6a. La caisse ──
INSERT INTO cash_accounts (kind, name, note, position)
SELECT 'cash', 'Caisse du salon', 'Compte créé automatiquement : tous les encaissements y entrent.', 0
WHERE NOT EXISTS (SELECT 1 FROM cash_accounts WHERE kind = 'cash');

-- ── 6b. Quelques catégories de dépenses pour démarrer ──
INSERT IGNORE INTO expense_categories (name, position) VALUES
  ('Produits et mèches', 0),
  ('Salaires', 1),
  ('Loyer et charges', 2),
  ('Transport', 3),
  ('Autre', 9);

-- ── 6c. Les clientes déjà venues ──
--
-- Une fiche par numéro distinct, avec le nom du rendez-vous le plus récent —
-- c'est l'orthographe la plus fiable dont on dispose. Les numéros sont
-- réduits à leurs chiffres, puis aux dix derniers : c'est ce qui identifie un
-- abonné en Côte d'Ivoire, indicatif mis à part.
INSERT INTO customers (phone, phone_key, first_name, last_name, email, first_seen_at, last_seen_at)
SELECT
  SUBSTRING_INDEX(GROUP_CONCAT(a.phone ORDER BY a.created_at DESC SEPARATOR '\n'), '\n', 1),
  cle.phone_key,
  SUBSTRING_INDEX(GROUP_CONCAT(a.first_name ORDER BY a.created_at DESC SEPARATOR '\n'), '\n', 1),
  SUBSTRING_INDEX(GROUP_CONCAT(a.last_name  ORDER BY a.created_at DESC SEPARATOR '\n'), '\n', 1),
  SUBSTRING_INDEX(GROUP_CONCAT(a.email      ORDER BY a.created_at DESC SEPARATOR '\n'), '\n', 1),
  MIN(a.created_at),
  MAX(a.created_at)
FROM appointments a
JOIN (
  SELECT id, bh_phone_key(phone) AS phone_key FROM appointments
) AS cle ON cle.id = a.id
WHERE CHAR_LENGTH(cle.phone_key) >= 8
GROUP BY cle.phone_key;

-- Rattachement des rendez-vous à la fiche correspondante.
UPDATE appointments a
JOIN customers c ON c.phone_key = bh_phone_key(a.phone)
SET a.customer_id = c.id
WHERE a.customer_id IS NULL;

-- ── 6d. Les encaissements déjà enregistrés entrent en caisse ──
--
-- Chaque versement de `appointment_payments` devient une écriture d'entrée.
-- L'index unique sur `payment_id` garantit qu'un versement ne peut pas y
-- entrer deux fois, même si cette migration était rejouée.
INSERT INTO ledger_entries
  (account_id, kind, direction, amount, currency, label, occurred_on,
   appointment_id, payment_id, recorded_by, recorded_by_name, created_at)
SELECT
  (SELECT id FROM cash_accounts WHERE kind = 'cash' ORDER BY id LIMIT 1),
  'payment', 'in', p.amount, a.currency,
  CONCAT('Encaissement ', a.reference, ' — ', a.first_name, ' ', a.last_name),
  DATE(p.created_at),
  p.appointment_id, p.id, p.recorded_by, p.recorded_by_name, p.created_at
FROM appointment_payments p
JOIN appointments a ON a.id = p.appointment_id
WHERE NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.payment_id = p.id);
