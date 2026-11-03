/**
 * Grille tarifaire par défaut — d'après les documents du salon
 * (« Grille tarifaire — Resserrage de locks » et « Cahier de spécifications »).
 *
 * Copie fidèle des données du site v3 (src/data/tarifs.js). Elle ne sert qu'à
 * AMORCER la table `pricing_catalogue` : une fois la ligne créée, c'est la base
 * qui fait foi et l'administratrice la modifie via PUT /api/admin/tarifs.
 */
/**
 * Logique tarifaire de Beauté Halal — d'après les documents du salon
 * (« Grille tarifaire — Resserrage de locks » et « Cahier de spécifications »).
 * Ces informations ne viennent pas de l'API : les montants sont indicatifs, le salon confirme
 * volume, longueur et tarif final avant la prestation.
 * Le prix dépend de 3 critères : type de locks · volume des cheveux · délai depuis la dernière séance.
 */

export const BRAND_TAGLINE = 'L’art du soin capillaire texturé'
export const BRAND_INTRO =
  'Spécialistes des locks, micro-locks et small locks. Un savoir-faire d’exception pour sublimer vos cheveux naturels, dans le respect de leur nature.'

/** WhatsApp réservations (fourni par le salon) — repli quand l'API n'en renseigne pas. */
export const WHATSAPP = { display: '+225 05 66 15 74 32', number: '2250566157432' }

export const VOLUMES = [
  { id: 'XS', label: 'Très peu de volume', hint: 'Presque pas de cheveux, cuir chevelu bien visible' },
  { id: 'S', label: 'Peu de volume', hint: 'Des cheveux présents, mais peu fournis' },
  { id: 'M', label: 'Volume normal', hint: 'Volume normal, densité normale (référence)' },
  { id: 'L', label: 'Beau volume', hint: 'Cheveux avec une forte densité' },
  { id: 'XL', label: 'Volume très important', hint: 'Très forte densité, tête très fournie' },
]

export const LONGUEURS = [
  { label: 'Courte', hint: 'Jusqu’aux oreilles environ' },
  { label: 'Moyenne', hint: 'Jusqu’aux épaules environ' },
  { label: 'Longue', hint: 'Sous les épaules' },
]

/** Ajustements selon le délai depuis la dernière séance (montants en FCFA ; plus = « et plus »). */
const DELAI_2_MOIS = [
  { id: 'avance', label: 'Avant 2 mois', detail: '5 à 6 semaines', amount: -2000 },
  { id: 'standard', label: 'Dans les temps', detail: 'environ 2 mois', amount: 0 },
  { id: 'retard', label: 'Au-delà de 2 mois', detail: '9 à 10 semaines', amount: 3000 },
  { id: 'tres-retard', label: 'Au-delà de 3 mois', detail: '', amount: 5000, orMore: true },
]
const DELAI_MICRO = [
  { id: 'avance', label: '4 semaines', detail: 'cliente en avance', amount: -3000 },
  { id: 'standard', label: '5 à 6 semaines', detail: 'tarif standard', amount: 0 },
  { id: 'retard', label: '7 à 8 semaines', detail: '', amount: 3000 },
  { id: 'tres-retard', label: 'Au-delà de 8 semaines', detail: '', amount: 5000, orMore: true },
]

/** Majoration selon l'état des locks (pourcentage du tarif). */
const ETAT_STD = [
  { id: 'bon', label: 'Bon état', detail: 'pas de majoration', pct: 0 },
  { id: 'moyen', label: 'État moyen', detail: 'quelques locks défaites · +20 %', pct: 20 },
  { id: 'important', label: 'Dégât important', detail: 'presque toute la tête · +40 %', pct: 40 },
]
const ETAT_MICRO = [
  ETAT_STD[0],
  ETAT_STD[1],
  { id: 'important', label: 'Dégât important', detail: 'presque toute la tête · +40 à 50 %', pct: 40, orMore: true },
]

export const LOCK_TYPES = [
  {
    id: 'traditionnels',
    name: 'Locks Traditionnels',
    tagline: 'Les locks classiques',
    description: 'Locks classiques aux dimensions généreuses.',
    size: 'À partir de 1 cm',
    rhythm: 'Resserrage tous les 2 mois',
    prices: { XS: [10000, 7000], S: [12000, 8500], M: [15000, 10500], L: [17000, 12000], XL: [20000, 14000] },
    delais: DELAI_2_MOIS,
    etats: ETAT_STD,
    repair: { from: 35000, text: 'À partir de 35 000 FCFA' },
  },
  {
    id: 'small',
    name: 'Small Locks',
    tagline: 'Le format semi-fin',
    description: 'Locks fines et élégantes, pour un rendu raffiné.',
    size: '0,6 cm à 0,8 cm',
    rhythm: 'Resserrage tous les 2 mois',
    prices: { XS: [15000, 10500], S: [18000, 12500], M: [22000, 15500], L: [26000, 18000], XL: [30000, 21000] },
    delais: DELAI_2_MOIS,
    etats: ETAT_STD,
    repair: { from: 50000, text: 'À partir de 50 000 FCFA' },
  },
  {
    id: 'micro',
    name: 'Micro-Locks',
    tagline: 'Le format premium',
    description: 'Le summum du détail et de la finesse : un travail minutieux, un resserrage toutes les 6 semaines.',
    size: '0,2 cm à 0,4 cm',
    rhythm: 'Resserrage toutes les 6 semaines',
    prices: { XS: [20000, 14000], S: [25000, 17500], M: [30000, 21000], L: [36000, 25000], XL: [42000, 29500] },
    delais: DELAI_MICRO,
    etats: ETAT_MICRO,
    repair: { from: 70000, text: '70 000 à 180 000 FCFA' },
  },
]

export const FORMULES = [
  {
    id: 'complet',
    label: 'Resserrage complet',
    short: 'Complet',
    detail: 'racines + tiges',
    index: 0,
    help: 'Racines et tiges retravaillées. Recommandé pour les locks en cours de maturation (moins de 2 ans).',
  },
  {
    id: 'racines',
    label: 'Reprise de racines seule',
    short: 'Racines seules',
    detail: '−30 %',
    index: 1,
    help: 'Uniquement la repousse au niveau du cuir chevelu. Pour les locks matures (plus de 2 ans) ou sur demande.',
  },
  {
    id: 'reparation',
    label: 'Réparation',
    short: 'Réparation',
    detail: 'selon dégâts',
    index: -1,
    help: 'Tarif indicatif « à partir de » : le prix définitif dépend de l’ampleur des dégâts et du temps de travail.',
  },
]

export const engagement =
  'Chaque resserrage complet inclut le travail des racines ET des tiges jusqu’à la maturation complète de vos locks (environ 2 ans).'

export const consultation = {
  nouvelle: 'Nouvelle cliente : consultation payante 5 000 FCFA',
  ancienne: 'Ancienne cliente : diagnostic gratuit',
  final: 'Le tarif final vous est annoncé avant le début de la prestation.',
}

export const videoAdvice =
  'Envoyez-nous une courte vidéo de vos cheveux au naturel : nous confirmons votre volume et votre longueur en quelques minutes.'

/** Étapes de la consultation capillaire (étape « Consultation » de la prise de rendez-vous). */
export const soins = {
  "etapes": {
    "profil": { "label": "Votre profil", "title": "Faisons connaissance", "intro": "" },
    "consultation": { "label": "Consultation", "title": "Consultation capillaire", "intro": "" },
    "besoin": { "label": "Votre besoin", "title": "De quoi avez-vous besoin ?", "intro": "" },
    "type": { "label": "Type de locks", "title": "Choisissez votre type de locks", "intro": "" },
    "methode": { "label": "Méthode", "title": "Choisissez votre méthode de pose", "intro": "" },
    "volume": { "label": "Volume", "title": "Votre volume de cheveux", "intro": "" },
    "longueur": { "label": "Longueur", "title": "La longueur de vos cheveux", "intro": "" },
    "precisions": { "label": "Resserrage", "title": "Votre resserrage", "intro": "" },
    "jour": { "label": "Jour", "title": "Choisissez un jour", "intro": "" },
    "recap": { "label": "Récapitulatif", "title": "Vérifiez votre demande", "intro": "" }
  },
  "propose": {
    "title": "Souhaitez-vous une consultation capillaire ?",
    "text": "Un temps d’échange avec une experte pour examiner vos cheveux et choisir les soins qui conviennent. Elle n’est pas obligatoire pour réserver.",
    "faireLabel": "Faire une consultation capillaire",
    "faireHint": "Recommandé pour des soins de qualité.",
    "ignorerLabel": "Ignorer la consultation",
    "ignorerHint": "Passer directement à la réservation.",
    "ignoreeMessage": "Vous avez choisi de ne pas faire de consultation capillaire. Vous pouvez poursuivre votre réservation."
  },
  "locks": {
    "title": "Avez-vous déjà des locks ?",
    "text": "Selon votre réponse, la consultation ne porte pas sur les mêmes points.",
    "ouiLabel": "Oui, j’ai des locks",
    "ouiHint": "Faire le point sur leur état et leur entretien.",
    "nonLabel": "Non, je n’en ai pas",
    "nonHint": "Préparer la création de vos locks."
  },
  "modes": {
    "title": "Comment souhaitez-vous faire votre consultation ?",
    "whatsappLabel": "Par WhatsApp",
    "whatsappHint": "La discussion s’ouvre avec un message déjà rédigé.",
    "placeLabel": "Par prise de rendez-vous",
    "placeHint": "Une consultation en salon, à la date de votre choix.",
    "confirmation": "Parfait. Vous pouvez poursuivre votre réservation : le salon vous accompagne pour la consultation."
  },
  "avecLocks": {
    "title": "Pourquoi une consultation, même avec des locks ?",
    "lead": "La consultation capillaire chez Beauté Halal est une étape essentielle, même pour les clientes qui portent déjà des locks.",
    "points": [
      {
        "title": "Analyse technique.",
        "text": "La locticienne analyse la structure de vos locks actuelles, la qualité de vos cheveux et l’état de vos racines : crucial si vos locks ont été commencées ailleurs."
      },
      {
        "title": "Tarification exacte.",
        "text": "Nos tarifs sont présentés sous forme d’intervalles : la consultation permet de fixer le prix précis de votre prestation (resserrage ou réparation) selon la longueur et le volume de vos cheveux."
      },
      {
        "title": "Conseil personnalisé.",
        "text": "C’est le moment de parler de votre routine d’entretien et de s’assurer que la technique de resserrage est adaptée à votre cuir chevelu, pour un résultat de qualité."
      }
    ],
    "outro": ""
  },
  "sansLocks": {
    "title": "Pourquoi une consultation avant vos locks ?",
    "lead": "La consultation capillaire est une étape obligatoire chez Beauté Halal avant tout départ de locks ou de micro-locks.",
    "points": [
      {
        "title": "Analyse de votre fibre capillaire.",
        "text": "Nature de vos cheveux, volume et densité : essentiel pour déterminer la méthode la plus adaptée à votre cuir chevelu."
      },
      {
        "title": "Choix de la méthode.",
        "text": "Interlocking, braids ou twists : nous vous conseillons la technique qui garantira la meilleure tenue et la meilleure santé pour vos futures locks."
      },
      {
        "title": "Tarification précise.",
        "text": "Nos tarifs dépendent de la longueur et du volume de vos cheveux : c’est lors de ce rendez-vous que nous fixons le prix exact de votre prestation."
      },
      {
        "title": "Planification personnalisée.",
        "text": "Nous évaluons le temps nécessaire à la pose, qui varie selon la complexité du travail."
      }
    ],
    "outro": "En résumé : un gage de qualité pour un résultat durable et une coiffure qui vous ressemble."
  }
}

/** « Bon à savoir » — le texte des documents du salon. */
export const goodToKnow = [
  { title: 'Consultation & diagnostic', text: 'Consultation payante à 5 000 FCFA pour toute nouvelle cliente. Diagnostic gratuit pour les anciennes clientes. Le tarif vous est annoncé avant le début de la prestation.' },
  { title: 'Travail des racines ET des tiges', text: 'Chaque resserrage complet inclut la reprise des racines et la retouche des tiges, jusqu’à la maturation complète de vos locks (environ 2 ans). C’est notre signature.' },
  { title: 'Respect des délais', text: 'Pour préserver la santé de vos locks et bénéficier du tarif standard : 2 mois pour les Locks Traditionnels et les Small Locks, 6 semaines pour les Micro-Locks.' },
  { title: 'Temps de prestation', text: 'Un resserrage de Micro-Locks demande au minimum 3 heures de travail en solo (2 heures à deux mains), et peut aller jusqu’à 5-6 heures selon l’état. Merci de prévoir le temps nécessaire.' },
  { title: 'Retouche de tiges seule', text: 'Pour les cas particuliers (événement, entre-deux séances), la retouche de tiges seule est étudiée au cas par cas : parlez-nous-en.' },
  { title: 'Réparations', text: 'Les tarifs de réparation sont des fourchettes indicatives : le prix définitif dépend de l’ampleur des dégâts et du temps de travail (jusqu’à 2 jours pour les cas lourds). Réparations offertes pour les clientes abonnées à l’Institut Beauté Halal qui respectent le calendrier de suivi.' },
]


/* Parcours « nouvelle logique » : création complète ou resserrage      */
/* ------------------------------------------------------------------ */

export const BESOINS = [
  {
    id: 'creation',
    name: 'Installation de locks',
    text: 'Vous démarrez vos locks, micro-locks et small locks : le salon évalue avec vous le type, le volume et la longueur.',
    note: 'Le tarif d’une installation est annoncé par le salon après diagnostic.',
  },
  {
    id: 'resserrage',
    name: 'Resserrage',
    text: 'Vous avez déjà des locks : resserrage complet ou reprise de racines.',
    note: 'Tarif indicatif calculé selon la grille du salon.',
  },
  {
    id: 'reparation',
    name: 'Réparation',
    text: 'Vos locks sont abîmées ou fragilisées : le salon les remet en état, partiellement ou globalement.',
    note: 'Tarif indicatif « à partir de » : le prix définitif dépend de l’ampleur des dégâts.',
  },
]

/** Les prestations de la nouvelle logique (nom + description), présentées sur les coiffures. */

/**
 * Textes et règles du site public réglables depuis le dashboard (« Textes et règles du site »).
 * Dans un titre, un mot entouré d'astérisques est mis en valeur : « Locks et *micro-locks* ».
 */
export const SITE = {
  /* Encadré, méthodes de pose (avec durées) et détails des coiffures : réglables depuis « Textes et règles du site ». */
  regles: {
    "titre": "À savoir avant de réserver",
    "lignes": [
      "Beauté Halal est un salon de coiffure fermé aux hommes : les rendez-vous sont réservés aux femmes.",
      "Nous réalisons uniquement des locks (installation, resserrage, réparation) : ni mèches, ni ajouts."
    ]
  },
  /* Page « Politique de réservation » du site ; aussi reprise dans l'e-mail et le message WhatsApp envoyés après le paiement. */
  politique: {
    "titre": "Politique de prise de rendez-vous",
    "intro": "Ce qu’il faut savoir avant de réserver chez Beauté Halal.",
    "sections": [
      { "titre": "Consultation capillaire", "texte": "Elle n’est plus obligatoire mais reste essentielle. Elle permet une analyse technique de vos cheveux et de votre cuir chevelu afin de vous donner des conseils personnalisés et un tarif précis. Son coût est de 5 000 FCFA." },
      { "titre": "Fixation du prix", "texte": "Le tarif peut être fixé en salon lors d’une consultation ou à distance. Pour un devis à distance, vous devez envoyer une photo ou une vidéo nette et bien éclairée montrant le volume et la longueur de vos cheveux (étirés vers l’oreille, le cou ou l’épaule)." },
      { "titre": "Réservation et avance", "texte": "Pour valider un rendez-vous, une avance de 5 000 FCFA est requise. Pour les anciennes clientes, ce montant est déduit de la prestation. Pour les nouvelles clientes, il couvre les frais de consultation." },
      { "titre": "Annulations et retards", "texte": "L’avance n’est pas remboursable en cas d’annulation moins de 48 h avant le rendez-vous. En cas de retard de plus de 15 à 30 minutes, vous serez placée en attente." },
      { "titre": "Horaires", "texte": "L’institut est ouvert de 09 h à 19 h 30, mais reste fermé le vendredi. Les services se font uniquement sur rendez-vous." }
    ]
  },
  methodes: {
    "micro": {
      "intro": "Micro-locks : la finesse se joue à l’épaisseur de vos cheveux. Choisissez la méthode qui convient le mieux à vos cheveux.",
      "noteTemps": "La durée dépend surtout du volume, de la longueur de vos cheveux et du format de micro-locks choisi.",
      "methodes": [
        {
          "id": "interlocking",
          "label": "Micro interlocking",
          "conseil": "Une pose très tenue, adaptée aux micro-locks fines. À choisir pour un maintien durable.",
          "duree": "en moyenne une journée entière ou une journée et demie, voire 2 à 3 jours"
        },
        {
          "id": "braid",
          "label": "Micro braid",
          "conseil": "Un départ en micro-tresses : rendu régulier et soigné sur des locks très fines.",
          "duree": "8 h minimum, jusqu’à une journée et demie"
        },
        {
          "id": "twist",
          "label": "Micro twist",
          "conseil": "Un départ en micro-torsades : rendu souple, pour un effet naturel.",
          "duree": "4 h à 5 h en moyenne"
        },
        {
          "id": "broderie",
          "label": "Broderie",
          "conseil": "Conseillée sur des cheveux épais plutôt que fins : la broderie demande de la matière.",
          "duree": ""
        }
      ]
    },
    "small": {
      "intro": "Small locks : un format intermédiaire. La méthode se choisit selon l’épaisseur de vos cheveux.",
      "noteTemps": "La durée dépend de la longueur et du volume de vos cheveux.",
      "methodes": [
        {
          "id": "interlocking",
          "label": "Small interlocking",
          "conseil": "Une pose tenue et précise pour des locks fines à moyennes.",
          "duree": "environ 10 h en moyenne, voire une journée et demie"
        },
        {
          "id": "braid",
          "label": "Small micro braid",
          "conseil": "Un départ en petites tresses : rendu régulier et net.",
          "duree": "5 h à 6 h en moyenne"
        },
        {
          "id": "twist",
          "label": "Small micro twist",
          "conseil": "Un départ en petites torsades : rendu souple et naturel.",
          "duree": "3 h à 5 h en moyenne"
        },
        {
          "id": "broderie",
          "label": "Small broderie",
          "conseil": "Plutôt conseillée sur des cheveux épais que sur des cheveux fins.",
          "duree": "6 h à 8 h en moyenne"
        }
      ]
    },
    "traditionnels": {
      "intro": "Locks traditionnelles : des locks généreuses (environ 1,5 cm). Quatre méthodes sont possibles.",
      "noteTemps": "La durée dépend du volume et de la longueur de vos cheveux.",
      "methodes": [
        {
          "id": "broderie",
          "label": "Broderie",
          "conseil": "Une technique au crochet qui convient bien aux locks traditionnelles.",
          "duree": "environ 5 h en moyenne"
        },
        {
          "id": "twist",
          "label": "Twist",
          "conseil": "Un départ en torsades, pour un rendu naturel et souple.",
          "duree": "environ 3 h en moyenne"
        },
        {
          "id": "braid",
          "label": "Braid",
          "conseil": "Un départ en tresses, pour un rendu régulier et net.",
          "duree": "environ 4 h en moyenne"
        },
        {
          "id": "interlocking",
          "label": "Interlocking",
          "conseil": "Conseillé sur des locks fines plutôt que sur de grosses locks.",
          "duree": ""
        }
      ]
    }
  },
  detailsCoiffure: {
    "tempsNote": "Le temps d’installation dépend de la méthode choisie, du volume et de la longueur des cheveux, et du format de locks choisi. Prévoyez 2 jours, surtout pour une installation de micro-locks en interlocking.",
    "reparationTemps": "Une réparation prend en moyenne 8 h selon les dégâts sur les locks, et peut aller jusqu’à deux jours.",
    "soins": [
      {
        "id": "shampooing",
        "name": "Shampooing simple",
        "price": 3000,
        "text": "Un shampooing pour nettoyer vos locks."
      },
      {
        "id": "detox",
        "name": "Shampooing détox",
        "from": 10000,
        "text": "Selon la longueur de vos locks."
      },
      {
        "id": "retrait",
        "name": "Retrait des locks",
        "from": 30000,
        "text": "Nous retirons uniquement les locks épaisses. Le prix dépend de l’âge et de la durée des locks : plus elles sont anciennes, plus le retrait est long. Prévoyez au minimum une journée."
      }
    ]
  },
  accueil: { titre: 'Locks, small locks et *micro-locks* à Abidjan.', bouton: 'Réserver mon rendez-vous', lien: 'Nos services et tarifs' },
  approche: {
    eyebrow: 'Le savoir-faire',
    titre: 'Une affaire de *geste*, de tension et de régularité.',
    lien: 'Découvrir le salon',
    valeurs: [
      { title: 'Racines ET tiges', text: 'Chaque resserrage complet inclut le travail des racines et des tiges jusqu’à la maturation complète de vos locks, environ 2 ans. C’est notre signature.' },
      { title: 'Des tarifs transparents', text: 'Le tarif dépend du type de locks, du volume de vos cheveux et du délai depuis votre dernière séance. Il vous est annoncé avant le début de la prestation.' },
      { title: 'Le respect de vos locks', text: 'Resserrer dans les délais (2 mois, 6 semaines pour les micro-locks) préserve leur santé et vous garantit le tarif standard.' },
    ],
  },
  etapes: {
    eyebrow: 'Comment ça marche',
    titre: 'Votre demande en *quatre temps*',
    liste: [
      { title: 'Identifiez', text: 'Votre type de locks (traditionnelles, small ou micro) et votre volume, de XS à XL.' },
      { title: 'Estimez', text: 'Le tarif indicatif selon la formule, le délai depuis votre dernière séance et l’état de vos locks.' },
      { title: 'Réservez', text: 'Installation, resserrage ou réparation, puis votre jour et votre heure parmi les créneaux proposés.' },
      { title: 'Confirmez', text: 'Votre avance versée valide automatiquement votre rendez-vous.' },
    ],
  },
  invitation: { titre: 'Prête pour de beaux locks ?', texte: 'Choisissez installation, resserrage ou réparation, puis votre jour et votre heure.' },
  invitationGalerie: { titre: 'Une coiffure vous inspire ?', texte: 'Ouvrez la photo, choisissez « Réserver cette coiffure », puis indiquez s’il s’agit d’une installation, d’un resserrage ou d’une réparation.' },
  pages: {
    services: { eyebrow: 'Nos services', titre: 'Locks, small locks et *micro-locks*.', intro: 'Trois types de locks, une grille tarifaire claire et un engagement : le travail des racines et des tiges.' },
    galerie: { eyebrow: 'Nos coiffures', titre: 'Les *coiffures* du salon.', intro: 'Ouvrez une photo en grand, puis demandez un rendez-vous pour la coiffure qui vous plaît : installation, resserrage ou réparation.' },
    apropos: { eyebrow: 'À propos', titre: 'L’art du soin capillaire *texturé*.' },
    contact: { eyebrow: 'Contact', titre: 'Écrivez-*nous*, appelez-nous.', intro: 'Pour une question avant de réserver, ou pour modifier une demande déjà envoyée (rappelez alors votre référence).' },
    rendezvous: { eyebrow: 'Rendez-vous', titre: 'Demandez votre *rendez-vous*.', intro: 'Étape par étape : votre profil, votre consultation, votre besoin, puis le jour et l’heure qui vous conviennent.' },
  },
  sections: {
    types: { eyebrow: 'Nos services', titre: 'Trois types de locks, *un même savoir-faire*', lien: 'Voir tous les tarifs' },
    galerie: { eyebrow: 'Nos coiffures', titre: 'Des réalisations qui *parlent d’elles-mêmes*', lien: 'Toutes les coiffures' },
    avis: { eyebrow: 'Avis de clientes', titre: 'Elles en parlent *mieux que nous*' },
    bonASavoir: { eyebrow: 'Bon à savoir', titre: 'Notre engagement *envers vous*' },
    grille: { eyebrow: 'Grille tarifaire', titre: 'Resserrage de locks : *des tarifs clairs*', intro: 'Nos tarifs dépendent du type de vos locks, du volume de vos cheveux et du délai depuis votre dernière séance. Le volume est le critère qui influence le plus la durée et le prix.' },
    introuvable: { titre: 'Cette page s’est *défaite*.', texte: 'L’adresse demandée n’existe pas ou n’existe plus. Revenez à l’accueil ou demandez directement un rendez-vous.' },
  },
  /** Titre et description de chaque page pour Google et les partages (WhatsApp, Facebook). */
  seo: {
    home: { title: 'Beauté Halal — Locks, Small Locks et Micro-Locks à Abidjan', description: 'Spécialiste des locks et soins capillaires texturés à Abidjan. Installation, resserrage et réparation de locks traditionnelles, small locks et micro-locks. Prise de rendez-vous en ligne.' },
    services: { title: 'Nos services — Beauté Halal', description: 'Locks traditionnelles, small locks et micro-locks : grille tarifaire du resserrage selon le volume, le délai et l’état de vos locks. Réservez en ligne.' },
    gallery: { title: 'Nos coiffures — Beauté Halal', description: 'Les coiffures réalisées par le salon : locks traditionnelles, small locks et micro-locks. Réservez celle qui vous plaît.' },
    about: { title: 'À propos — Beauté Halal', description: 'Le salon Beauté Halal : notre savoir-faire, notre équipe et notre engagement pour la santé de vos locks.' },
    booking: { title: 'Rendez-vous — Beauté Halal', description: 'Choisissez installation, resserrage ou réparation, votre jour et votre heure, puis validez votre rendez-vous.' },
    contact: { title: 'Contact — Beauté Halal', description: 'Coordonnées du salon Beauté Halal. Écrivez-nous par formulaire, téléphone ou WhatsApp.' },
  },
  pied: { rendezvous: 'Choisissez votre besoin, puis le jour et l’heure qui vous conviennent : votre rendez-vous est validé dès le paiement de l’avance.' },
  /** Conditions affichées avant le paiement : la cliente doit les accepter. */
  conditions: {
    title: 'Conditions de rendez-vous',
    lines: [
      'Le versement de l’avance valide automatiquement votre rendez-vous.',
      'Cette avance n’est pas remboursable, quel que soit le motif d’annulation, même si vous prévenez quelques heures avant.',
      'L’heure que vous choisissez est un engagement : en cas de retard, le salon peut annuler ou déplacer votre rendez-vous.',
    ],
    accept: 'J’ai lu et j’accepte les conditions de rendez-vous.',
  },
  /** Aide « Comment lire les tailles ? » au choix du type de locks. */
  tailles: {
    title: 'Comment lire les tailles ?',
    lines: [
      'Micro-locks : 0,2 cm à 0,4 cm (les 0,4 cm sont un peu plus larges que les 0,2 cm).',
      'Small locks : 0,6 cm à 0,8 cm.',
      'À partir de 1 cm : locks traditionnelles (dreadlocks).',
    ],
  },
  /** Heures proposées selon le profil (le calendrier du salon reste la source : seules les heures libres s'affichent). */
  creneaux: {
    consultation: ['10:00'],
    nouvelle: ['10:00'],
    ancienneResserrage: ['09:00'],
    autres: ['14:00', '14:30'],
  },
}

/** Deux niveaux de réparation : le prix « à partir de » dépend du niveau, pas du type de locks. */
export const REPARATIONS = [
  { id: 'partielle', name: 'Réparation partielle', from: 35000, text: 'Votre dernier resserrage date de plus de deux fois le délai habituel : des locks glissent ou se défont et sont à reprendre.' },
  { id: 'globale', name: 'Réparation globale', from: 50000, text: 'Vos tiges sont extrêmement affinées, avec des boules ou des trous dans les locks : un travail de fond est nécessaire.' },
]

/**
 * Fourchettes de prix d'INSTALLATION, par type de locks et par méthode (grille « Toutes nos fourchettes »).
 * `min` / `max` en FCFA ; sans montant, `note` dit pourquoi (« Sur demande », « Non proposé »).
 */
export const INSTALLATIONS = [
  {
    id: 'traditionnels',
    title: 'Locks traditionnels',
    size: '1 à 1,5 cm',
    methods: [
      { name: 'Twists', min: 5000, max: 25000, note: '' },
      { name: 'Braids', min: 7000, max: 25000, note: '' },
      { name: 'Crochet broderie', min: 30000, max: 70000, note: '' },
      { name: 'Interlocking', min: null, max: null, note: 'Sur demande' },
    ],
  },
  {
    id: 'small',
    title: 'Small locks',
    size: '0,6 à 0,8 cm',
    methods: [
      { name: 'Small twists', min: 15000, max: 40000, note: '' },
      { name: 'Small braids', min: 10000, max: 40000, note: '' },
      { name: 'Crochet broderie', min: 50000, max: 130000, note: '' },
      { name: 'Interlocking', min: 50000, max: 125000, note: '' },
    ],
  },
  {
    id: 'micro',
    title: 'Micro-locks',
    size: '0,1 à 0,4 cm',
    methods: [
      { name: 'Micro-twists', min: 25000, max: 65000, note: '' },
      { name: 'Micro-braids', min: 45000, max: 120000, note: '' },
      { name: 'Interlocking', min: 80000, max: 250000, note: '' },
      { name: 'Crochet broderie', min: null, max: null, note: 'Non proposé' },
    ],
  },
]

export const PRESTATIONS = [
  { id: 'creation', name: 'Installation de locks', description: 'Installation de vos locks de A à Z, dans le type choisi (traditionnels, small ou micro-locks).' },
  { id: 'resserrage', name: 'Resserrage complet', description: 'Racines et tiges retravaillées jusqu’à la maturation complète de vos locks (environ 2 ans).' },
  { id: 'racines', name: 'Reprise de racines seule', description: 'Uniquement la repousse au niveau du cuir chevelu, pour les locks matures ou sur demande (−30 %).' },
  { id: 'reparation', name: 'Réparation', description: 'Remise en état des locks abîmées ou fragilisées, partielle ou globale : tarif indicatif selon l’ampleur des dégâts.' },
]

