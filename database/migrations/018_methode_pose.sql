-- Méthode de pose choisie par la cliente pour une INSTALLATION de locks (étape « Méthode » du site) :
-- interlocking, braid, twist ou broderie. Colonne facultative (NULL = ancienne demande, resserrage/réparation,
-- ou « le salon me conseille ») : aucune donnée n'est réécrite.
-- À appliquer AVANT de déployer le backend qui l'utilise.
ALTER TABLE booking_requests
  ADD COLUMN methode VARCHAR(20) NULL AFTER lock_type;
