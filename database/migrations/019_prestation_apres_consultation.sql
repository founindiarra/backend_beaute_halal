-- Prestation souhaitée APRÈS une consultation capillaire (la cliente a répondu « Consultation, puis prestation ») :
-- le jour (et l'heure facultative) auquel elle souhaite la prestation, toujours un autre jour que la consultation.
-- Le besoin, le type, la méthode, le volume et la longueur sont déjà dans les colonnes existantes.
-- Colonnes facultatives : NULL pour toutes les demandes existantes. À appliquer AVANT de déployer le backend.
ALTER TABLE booking_requests
  ADD COLUMN service_date DATE NULL AFTER consultation_time,
  ADD COLUMN service_time TIME NULL AFTER service_date;
