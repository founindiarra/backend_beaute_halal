-- ─────────────────────────────────────────────────────────────────────────────
-- Les rendez-vous deviennent des DEMANDES soumises au salon.
--
-- Deux changements, tous deux permissifs : aucune donnée n'est supprimée,
-- aucune colonne n'est retirée, aucun rendez-vous existant n'est modifié.
--
-- 1. L'index unique « uq_appointments_slot » interdisait deux rendez-vous non
--    annulés à la même date et à la même heure. C'était la bonne règle tant
--    qu'une réservation valait confirmation. Désormais plusieurs clientes
--    peuvent demander le même créneau : c'est le salon qui tranche ensuite.
--    La colonne calculée « slot_lock » est conservée telle quelle — elle ne
--    coûte rien et reste utile si vous vouliez un jour revenir en arrière.
--
-- 2. Le statut « rejected » manquait : refuser une demande n'est pas l'annuler.
--    Une annulation vient de la cliente ou d'un imprévu du salon ; un refus est
--    une décision prise sur une demande encore en attente. Les distinguer
--    permet d'écrire deux messages différents et de compter les deux séparément.
--    Les valeurs existantes de l'ENUM sont toutes conservées, dans le même
--    ordre : aucune ligne n'a besoin d'être réécrite.
--
-- Retour en arrière, si besoin :
--   ALTER TABLE appointments
--     MODIFY status ENUM('pending','confirmed','cancelled','completed','no_show')
--       NOT NULL DEFAULT 'pending';
--   ALTER TABLE appointments ADD UNIQUE KEY uq_appointments_slot (slot_lock);
--   (le retour de l'index échouera s'il existe déjà des doublons de créneau)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE appointments
  DROP INDEX uq_appointments_slot;

ALTER TABLE appointments
  MODIFY status ENUM('pending','confirmed','rejected','cancelled','completed','no_show')
    NOT NULL DEFAULT 'pending';
