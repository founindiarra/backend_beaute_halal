# Référence de l'API — Beauté Halal

Base : `http://localhost:4000/api`

## Forme des réponses

Succès :

```json
{ "success": true, "data": { ... } }
{ "success": true, "data": [ ... ], "meta": { "total": 17 } }
```

Erreur :

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Certains champs sont invalides.",
    "details": [{ "field": "email", "message": "Adresse e-mail invalide." }]
  }
}
```

| Code HTTP | Signification |
| --- | --- |
| 400 | Requête mal formée |
| 401 | Jeton absent, invalide ou expiré |
| 403 | Rôle insuffisant / compte désactivé |
| 404 | Ressource introuvable |
| 409 | Conflit (créneau déjà pris, doublon) |
| 422 | Données invalides |
| 429 | Trop de requêtes |
| 503 | Base de données inaccessible |

---

# Endpoints publics

Aucune authentification.

### `GET /health`

État de l'API.

### `GET /salon`

```json
{
  "name": "Beauté Halal",
  "specialty": "Spécialiste des locks",
  "tagline": "L’art des locks, avec soin et élégance",
  "shortDescription": "…",
  "phone": { "display": "+225 00 00 00 00", "href": "tel:+22500000000" },
  "whatsapp": { "number": "", "defaultMessage": "…", "available": false },
  "email": "contact@beaute-halal.example",
  "address": { "line1": "…", "line2": "…", "city": "…", "country": "…", "note": "…", "mapEmbedUrl": "…" },
  "socials": [],
  "hours": [{ "weekday": 1, "day": "Lundi", "isClosed": true, "opensAt": null, "closesAt": null, "value": "Fermé" }],
  "currency": "FCFA",
  "bookingWindowDays": 60
}
```

Les horaires sont triés du lundi au dimanche.

### `GET /service-categories`

Les 6 catégories actives, triées par position.

### `GET /services`

Paramètres : `?category=<slug>` · `?featured=true`

```json
{
  "id": 3,
  "slug": "retwist",
  "name": "Retwist",
  "description": "…",
  "durationMinutes": 120,
  "price": 20000,
  "currency": "FCFA",
  "imageUrl": "https://…",
  "isFeatured": true,
  "category": { "id": 2, "slug": "entretien", "name": "Entretien" }
}
```

### `GET /services/:slug`

Une prestation active. `404` sinon.

### `GET /gallery/categories`

Les catégories, précédées d'une entrée `{ "slug": "all", "name": "Toutes" }`.

### `GET /gallery`

Paramètres : `?category=<slug>` (ou `all`) · `?featured=true`

### `GET /team`

Membres actifs, triés par position.

### `GET /testimonials`

`meta.averageRating` contient la note moyenne.

### `GET /availability/days`

Paramètres : `?from=AAAA-MM-JJ` · `?to=AAAA-MM-JJ` (120 jours maximum)

```json
{
  "from": "2026-09-15",
  "to": "2026-11-14",
  "windowDays": 60,
  "days": [
    { "date": "2026-09-15", "weekday": 2, "bookable": true, "availableSlots": 5, "totalSlots": 6, "reason": null },
    { "date": "2026-09-21", "weekday": 1, "bookable": false, "availableSlots": 0, "totalSlots": 6, "reason": "closed" }
  ]
}
```

Motifs possibles : `closed`, `closed_exceptionally`, `past`, `out_of_window`, `full`.

### `GET /availability/slots?date=AAAA-MM-JJ`

```json
{
  "date": "2026-09-16",
  "bookable": true,
  "slots": [
    { "time": "09:00", "available": true,  "reason": null },
    { "time": "10:00", "available": false, "reason": "booked" }
  ]
}
```

Motifs : `booked`, `too_soon`, `before_opening`, `after_closing`, `closed`, `closed_exceptionally`, `past`, `out_of_window`.

Un créneau du jour même n'est réservable qu'une heure à l'avance minimum.

### `GET /availability/opening-hours`

Les horaires seuls.

### `POST /appointments`

Limité à 10 requêtes par heure et par IP.

```json
{
  "serviceSlug": "retwist",
  "date": "2026-09-16",
  "time": "10:00",
  "firstName": "Awa",
  "lastName": "Traoré",
  "phone": "+225 00 00 00 00",
  "email": "awa@exemple.com",
  "note": "Longueur mi-dos",
  "staffId": null
}
```

`serviceId` est accepté à la place de `serviceSlug`.
La durée et le prix sont **toujours repris de la prestation en base** : ils ne
peuvent pas être imposés par le client.

Réponse `201` :

```json
{
  "reference": "BH-8F42C1",
  "status": "pending",
  "serviceName": "Retwist",
  "date": "2026-09-16",
  "time": "10:00",
  "durationMinutes": 120,
  "price": 20000,
  "currency": "FCFA",
  "firstName": "Awa"
}
```

Erreurs : `409` si le créneau est pris, fermé ou passé (`error.code` commence
par `SLOT_`) ; `422` si la prestation n'existe pas ou si un champ est invalide.

### `GET /appointments/:reference`

Consultation par référence. Ne renvoie ni téléphone ni e-mail.

### `POST /contact`

Limité à 8 requêtes par heure et par IP.

```json
{
  "name": "Awa Traoré",
  "email": "awa@exemple.com",
  "phone": "+225 00 00 00 00",
  "message": "Bonjour, je souhaite un renseignement."
}
```

Le champ facultatif `website` est un piège à robots : s'il est rempli, la
requête est rejetée.

---

# Endpoints admin

Tous sous `/api/admin`, tous protégés par
`Authorization: Bearer <jeton>` — sauf `POST /admin/auth/login`.

## Authentification

| Méthode | Route | Rôle |
| --- | --- | --- |
| POST | `/admin/auth/login` | public (10 tentatives / 15 min) |
| GET | `/admin/auth/me` | connecté |
| POST | `/admin/auth/change-password` | connecté |
| GET | `/admin/auth/users` | admin |
| POST | `/admin/auth/users` | admin |
| PATCH | `/admin/auth/users/:id` | admin |
| DELETE | `/admin/auth/users/:id` | admin |

Le dernier compte administrateur ne peut pas être supprimé, et un compte ne
peut ni se supprimer ni se désactiver lui-même.

## Tableau de bord

| Méthode | Route | Description |
| --- | --- | --- |
| GET | `/admin/stats` | Compteurs : rendez-vous par statut, du jour, à venir, messages non lus |

## Rendez-vous

| Méthode | Route | Description |
| --- | --- | --- |
| GET | `/admin/appointments` | `?status=` `?from=` `?to=` `?search=` `?page=` `?limit=` |
| GET | `/admin/appointments/:id` | Détail complet (avec coordonnées) |
| PATCH | `/admin/appointments/:id/status` | `{ status, cancelReason?, notify? }` |
| PATCH | `/admin/appointments/:id` | Déplacer ou corriger un rendez-vous |
| DELETE | `/admin/appointments/:id` | Supprimer |

Statuts : `pending`, `confirmed`, `cancelled`, `completed`, `no_show`.
`notify: false` évite l'envoi de l'e-mail à la cliente.

## Contenus

| Ressource | Routes |
| --- | --- |
| Prestations | `GET/POST /admin/services`, `GET/PATCH/DELETE /admin/services/:id` |
| Catégories de prestations | `GET/POST /admin/service-categories`, `PATCH/DELETE /admin/service-categories/:id` |
| Galerie | `GET/POST /admin/gallery`, `PATCH/DELETE /admin/gallery/:id` |
| Catégories de galerie | `GET/POST /admin/gallery-categories`, `PATCH/DELETE /admin/gallery-categories/:id` |
| Équipe | `GET/POST /admin/team`, `PATCH/DELETE /admin/team/:id` |
| Avis | `GET/POST /admin/testimonials`, `PATCH/DELETE /admin/testimonials/:id` |
| Salon | `GET/PUT /admin/salon` |

Les listes admin incluent les éléments désactivés ; les listes publiques non.
Les slugs sont générés automatiquement à partir du nom et rendus uniques.
Une prestation liée à des rendez-vous ne peut pas être supprimée (`409`) :
désactivez-la avec `{ "isActive": false }`.

## Planning

| Méthode | Route | Description |
| --- | --- | --- |
| GET | `/admin/opening-hours` | Horaires |
| PUT | `/admin/opening-hours` | `{ hours: [{ weekday, isClosed, opensAt, closesAt }] }` |
| GET/POST | `/admin/time-slots` | Créneaux proposés |
| PATCH/DELETE | `/admin/time-slots/:id` | |
| GET/POST | `/admin/closures` | Fermetures exceptionnelles |
| DELETE | `/admin/closures/:id` | |

## Messages

| Méthode | Route | Description |
| --- | --- | --- |
| GET | `/admin/messages` | `?status=new\|read\|archived` `?page=` `?limit=` |
| GET | `/admin/messages/:id` | |
| PATCH | `/admin/messages/:id` | `{ status }` |
| DELETE | `/admin/messages/:id` | |

## Images

| Méthode | Route | Description |
| --- | --- | --- |
| POST | `/admin/uploads` | `multipart/form-data`, champ `image` (5 Mo max) |
| DELETE | `/admin/uploads/:filename` | |

Réponse :

```json
{ "path": "/uploads/1737-ab12-locks.jpg", "url": "http://localhost:4000/uploads/…", "filename": "…", "size": 84210 }
```

Enregistrez `path` dans `imageUrl` : l'API renvoie ensuite l'URL complète au front.
