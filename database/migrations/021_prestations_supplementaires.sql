-- Prestations supplémentaires d'un rendez-vous (ex. shampoing), ajoutées au moment de l'encaissement, chacune avec son prix.
-- `appointments.price` reste le TOTAL à payer (prix de base + suppléments) : caisse, listes et réductions continuent de fonctionner.
-- Le prix de base = price - SUM(extras.price). Si cette table n'existe pas encore, le backend ignore simplement les suppléments.
-- À appliquer AVANT d'utiliser la fonction « Ajouter une prestation » (le déploiement du backend peut se faire avant ou après).
CREATE TABLE IF NOT EXISTS appointment_extras (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  appointment_id   INT UNSIGNED NOT NULL,
  label            VARCHAR(160) NOT NULL,
  price            DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_by       INT UNSIGNED NULL,
  created_by_name  VARCHAR(160) NOT NULL DEFAULT 'Système',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_appointment_extras_appointment (appointment_id),
  CONSTRAINT fk_appointment_extras_appointment FOREIGN KEY (appointment_id) REFERENCES appointments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
