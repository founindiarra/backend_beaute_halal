-- ─────────────────────────────────────────────────────────────────────────────
-- Relier une réalisation de la galerie (« Nos coiffures ») à une prestation.
--
-- Objectif : depuis une coiffure, la cliente peut réserver directement la
-- prestation qui permet de la réaliser, sans avoir à la retrouver elle-même
-- dans le catalogue.
--
-- La colonne est NULLable : une réalisation sans prestation associée reste
-- parfaitement valide, et le site renvoie alors la cliente au choix normal.
-- ON DELETE SET NULL : supprimer une prestation ne supprime jamais une photo,
-- elle perd seulement son raccourci de réservation.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE gallery_items
  ADD COLUMN service_id INT UNSIGNED NULL AFTER category_id,
  ADD KEY idx_gallery_service (service_id),
  ADD CONSTRAINT fk_gallery_service FOREIGN KEY (service_id)
    REFERENCES services (id) ON DELETE SET NULL ON UPDATE CASCADE;
