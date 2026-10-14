# Backend Beauté Halal

API REST du site public **Beauté Halal** — salon spécialisé dans les locks.

Node.js · Express 5 · MySQL / MariaDB (phpMyAdmin) · JWT · Zod

---

## 1. Ce que fait cette API

| Besoin du site | Pris en charge |
| --- | --- |
| Informations du salon, horaires, réseaux | ✅ |
| Prestations et catégories | ✅ |
| Galerie filtrable | ✅ |
| Équipe | ✅ |
| Avis clientes | ✅ |
| Calendrier et créneaux disponibles en temps réel | ✅ |
| Prise de rendez-vous avec référence | ✅ |
| Formulaire de contact | ✅ |
| Authentification et CRUD complet pour le futur tableau de bord | ✅ |
| Upload d'images | ✅ |
| E-mails de confirmation | ✅ (désactivés tant que le SMTP n'est pas renseigné) |

---

## 2. Installation

### Prérequis

- **Node.js 20.11 ou plus récent** (`node -v` pour vérifier)
- **MySQL ou MariaDB démarré** — avec XAMPP, WAMP ou Laragon, il suffit de lancer
  le module MySQL depuis le panneau de contrôle.

### Étapes

```bash
cd C:\Users\foune\backend_beaute_halal

npm install

# Copier la configuration (Windows / PowerShell)
copy .env.example .env

# Créer la base et les tables, puis insérer le contenu de démarrage
npm run db:migrate
npm run db:seed

# Démarrer l'API
npm run dev
```

L'API répond alors sur **http://localhost:4000**.
Vérification rapide : ouvrez http://localhost:4000/api/health dans le navigateur.

### Configuration du `.env`

Les valeurs par défaut correspondent à une installation **XAMPP standard**
(utilisateur `root`, mot de passe vide). Si votre phpMyAdmin utilise d'autres
identifiants, adaptez ces lignes :

```
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=beaute_halal
```

Vous n'avez **pas besoin de créer la base à la main dans phpMyAdmin** :
`npm run db:migrate` la crée si elle n'existe pas, avec l'encodage `utf8mb4`
(indispensable pour les accents et les apostrophes françaises).

Une fois la migration passée, la base `beaute_halal` et ses 13 tables sont
visibles dans phpMyAdmin comme n'importe quelle autre base.

---

## 3. Commandes

| Commande | Effet |
| --- | --- |
| `npm run dev` | Démarre l'API avec rechargement automatique |
| `npm start` | Démarre l'API (production) |
| `npm run db:migrate` | Crée la base et applique les migrations manquantes |
| `npm run db:seed` | Insère le contenu de démarrage et le compte admin |
| `npm run db:seed -- --force` | Réinsère le contenu (les rendez-vous sont conservés) |
| `npm run db:setup` | `db:migrate` puis `db:seed` |
| `npm run db:reset` | ⚠️ Supprime et recrée la base (développement uniquement) |
| `npm run test:api` | Teste les 94 points de contrôle de l'API (serveur démarré requis) |

---

## 4. Compte administrateur

Créé par `npm run db:seed` à partir du `.env` :

```
E-mail        : admin@beaute-halal.local
Mot de passe  : ChangeMoi2026!
```

> ⚠️ **Changez ce mot de passe.** Modifiez `ADMIN_PASSWORD` dans `.env` *avant*
> le premier seed, ou utilisez `POST /api/admin/auth/change-password` ensuite.

Connexion :

```bash
curl -X POST http://localhost:4000/api/admin/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@beaute-halal.local\",\"password\":\"ChangeMoi2026!\"}"
```

La réponse contient un jeton JWT à envoyer ensuite dans l'en-tête
`Authorization: Bearer <jeton>`.

---

## 5. Structure du projet

```
backend_beaute_halal/
├─ .env.example              Modèle de configuration
├─ package.json
├─ API.md                    Référence complète des endpoints
├─ requests.http             Requêtes prêtes à l'emploi (VS Code REST Client)
├─ database/
│  ├─ migrations/
│  │  └─ 001_initial_schema.sql
│  ├─ migrate.js             Création de la base + migrations
│  ├─ seed.js                Contenu de démarrage + compte admin
│  ├─ seed-data.js           ★ LES DONNÉES FICTIVES À REMPLACER
│  └─ reset.js
├─ uploads/                  Images téléversées (servies sur /uploads)
├─ tests/
│  └─ api.test.js            94 tests de bout en bout
└─ src/
   ├─ server.js              Démarrage, vérification de la base, arrêt propre
   ├─ app.js                 Application Express (CORS, helmet, routes)
   ├─ config/
   │  ├─ env.js              Lecture et validation du .env
   │  └─ database.js         Pool MySQL + helpers query/transaction
   ├─ lib/
   │  ├─ ApiError.js         Erreurs métier typées
   │  ├─ http.js             Réponses JSON homogènes + pagination
   │  ├─ mailer.js           Envoi d'e-mails et gabarits
   │  ├─ reference.js        Génération des références « BH-XXXXXX »
   │  ├─ slug.js             Slugs uniques
   │  └─ url.js              URL absolues des images
   ├─ middleware/
   │  ├─ auth.js             JWT + contrôle de rôle
   │  ├─ error.js            Gestionnaire d'erreurs unique
   │  ├─ rateLimit.js        Limites anti-spam
   │  ├─ upload.js           Réception des images (multer)
   │  └─ validate.js         Validation Zod
   ├─ routes/index.js        Assemblage public / admin
   └─ modules/
      ├─ salon/              Informations du salon
      ├─ services/           Prestations et catégories
      ├─ gallery/            Réalisations
      ├─ team/               Équipe
      ├─ testimonials/       Avis
      ├─ availability/       Calendrier, créneaux, fermetures
      ├─ appointments/       Rendez-vous
      ├─ contact/            Messages
      ├─ auth/               Connexion et comptes
      └─ uploads/            Dépôt d'images
```

Chaque module expose un `publicRouter` (site) et/ou un `adminRouter`
(tableau de bord). Ajouter une fonctionnalité = ajouter un module et le
déclarer dans `src/routes/index.js`.

---

## 6. Base de données

13 tables, toutes en `utf8mb4_unicode_ci` :

| Table | Rôle |
| --- | --- |
| `users` | Comptes du salon (admin / staff) |
| `salon_settings` | Coordonnées, réseaux, devise — en clé / valeur |
| `opening_hours` | Horaires par jour de la semaine |
| `time_slots` | Créneaux proposés à la réservation |
| `closures` | Fermetures exceptionnelles |
| `service_categories`, `services` | Catalogue des prestations |
| `gallery_categories`, `gallery_items` | Galerie |
| `team_members` | Équipe |
| `testimonials` | Avis clientes |
| `appointments` | Rendez-vous |
| `contact_messages` | Messages du formulaire |

### La protection anti-double-réservation

`appointments` possède une colonne générée `slot_lock` :

```sql
slot_lock VARCHAR(32) AS (
  IF(status = 'cancelled', NULL, CONCAT(appointment_date, ' ', appointment_time))
) STORED,
UNIQUE KEY uq_appointments_slot (slot_lock)
```

Deux clientes qui valident exactement le même créneau à la même seconde ne
peuvent pas passer toutes les deux : **c'est la base de données elle-même qui
refuse la seconde**, pas seulement une vérification applicative. L'API renvoie
alors un `409` avec le code `SLOT_BOOKED`. Une annulation remet `slot_lock` à
`NULL` et libère donc le créneau.

---

## 7. Remplacer les données fictives

Tout le contenu de démarrage vient de `database/seed-data.js` :
prestations, tarifs, photos, équipe, avis, horaires, coordonnées.

Trois façons de le remplacer :

1. **Depuis phpMyAdmin** — modifier directement les lignes des tables.
2. **Depuis l'API admin** — `POST`/`PATCH` sur `/api/admin/...` (voir `API.md`).
3. **En modifiant `seed-data.js`** puis `npm run db:seed -- --force`.

Les coordonnées sont volontairement des placeholders (`+225 00 00 00 00`,
`contact@beaute-halal.example`, « Adresse à compléter »). Le numéro WhatsApp
est vide : renseignez `whatsapp_number` dans `salon_settings` au format
international sans `+` ni espaces, par exemple `2250000000000`.

---

## 8. E-mails

Désactivés par défaut : chaque envoi est simplement écrit dans la console
(`✉️ [e-mail désactivé] → …`). Pour les activer, renseignez le SMTP dans `.env` :

```
MAIL_ENABLED=true
MAIL_HOST=smtp.votre-fournisseur.com
MAIL_PORT=587
MAIL_USER=...
MAIL_PASSWORD=...
MAIL_FROM=Beauté Halal <contact@votredomaine.com>
MAIL_ADMIN_RECIPIENT=contact@votredomaine.com
```

Trois e-mails sont prévus : confirmation à la cliente, notification au salon,
et information lors d'un changement de statut. **Un échec d'envoi ne fait jamais
échouer une réservation** — le rendez-vous est enregistré d'abord.

---

## 9. Sécurité en place

- Mots de passe hachés avec bcrypt (coût 12), jamais renvoyés par l'API
- JWT signé, expiration 12 h, vérification du compte à chaque requête
- **Toutes** les requêtes SQL sont préparées (aucune concaténation de valeur)
- Validation Zod systématique sur `body`, `query` et `params`
- Limites anti-spam : 10 réservations/h, 8 messages/h, 10 connexions/15 min par IP
- En-têtes de sécurité via Helmet, CORS limité aux origines déclarées
- Upload restreint aux images (JPEG, PNG, WebP, AVIF), 5 Mo maximum
- Champ piège (honeypot) sur le formulaire de contact
- Message de connexion identique que l'e-mail existe ou non

> En production : remplacez `JWT_SECRET` par une longue chaîne aléatoire,
> mettez un mot de passe sur l'utilisateur MySQL, passez `NODE_ENV=production`
> et servez l'API derrière HTTPS.

---

## 10. Brancher le site Vue

Le front (`C:\Users\foune\beaute_halal`) lit aujourd'hui ses données depuis
`src/data/*.js`. Pour le connecter :

1. Ajouter dans le front un fichier `.env.local` :
   ```
   VITE_API_URL=http://localhost:4000/api
   ```
2. Créer `src/services/api.js` qui appelle `fetch(`${import.meta.env.VITE_API_URL}/services`)`.
3. Remplacer les imports `@/data/services` par des appels à ce module.

Les réponses de l'API suivent volontairement la forme déjà utilisée par les
composants (`durationMinutes`, `price`, `imageUrl`, `category.slug`…), ce qui
limite les modifications au strict nécessaire.

CORS est déjà ouvert pour `http://localhost:5173` et `http://localhost:4173`
(voir `CORS_ORIGINS` dans `.env`).

---

## 11. En cas de problème

| Message | Cause et solution |
| --- | --- |
| `Connexion à la base impossible` | MySQL n'est pas démarré → lancez-le dans XAMPP |
| `ER_ACCESS_DENIED_ERROR` | `DB_USER` / `DB_PASSWORD` incorrects dans `.env` |
| `Les tables n'existent pas encore` | Lancez `npm run db:migrate` |
| `EADDRINUSE :4000` | Le port est déjà pris → changez `PORT` dans `.env` |
| Erreur CORS dans le navigateur | Ajoutez l'origine du front à `CORS_ORIGINS` |
| Accents mal affichés | La base doit être en `utf8mb4` — c'est le cas si elle a été créée par `db:migrate` |
