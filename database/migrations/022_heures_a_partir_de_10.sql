-- Les heures proposées pour les rendez-vous commencent à 10:00 : le créneau de 09:00 est désactivé (pas supprimé).
-- L'équipe peut le réactiver, ou ajouter / retirer d'autres heures, depuis le dashboard (menu « Heures de rendez-vous »).
UPDATE time_slots SET is_active = 0 WHERE start_time = '09:00:00';
