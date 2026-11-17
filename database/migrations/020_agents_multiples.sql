-- Plusieurs agents / coiffeuses sur une même prestation.
-- `appointments.staff_id` reste l'agent PRINCIPAL (le premier de la liste) : tout ce qui le lit continue de fonctionner.
-- Cette table porte la liste complète. Si elle n'existe pas encore, le backend retombe sur `staff_id` seul (rien ne casse).
-- À appliquer AVANT ou APRÈS le déploiement du backend : aucun ordre imposé.
CREATE TABLE IF NOT EXISTS appointment_agents (
  appointment_id INT UNSIGNED NOT NULL,
  staff_id       INT UNSIGNED NOT NULL,
  position       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (appointment_id, staff_id),
  KEY idx_appointment_agents_staff (staff_id),
  CONSTRAINT fk_appointment_agents_appointment FOREIGN KEY (appointment_id) REFERENCES appointments (id) ON DELETE CASCADE,
  CONSTRAINT fk_appointment_agents_staff FOREIGN KEY (staff_id) REFERENCES team_members (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
