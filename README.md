# fivemai — ville persistante, PNJ vocaux et services réels

Ressource autonome FiveM/OneSync : voix directe OpenAI Realtime par WebRTC, identités et souvenirs SQLite, relations, actions GTA contrôlées, métiers, routines et sept missions écrites. Maintenir **N** pour parler, relâcher pour recevoir la réponse; reprendre la parole interrompt le PNJ. Aucun menu ni curseur de conversation.

Cette version possède du code et du contenu exécutables. Les tests vérifient les moteurs réels, SQLite et des natives GTA simulées. **Elle n'a pas été validée sur FXServer dans cet environnement.** Les fonctions incomplètes et les limites exactes figurent dans [docs/STATUS.md](docs/STATUS.md); le protocole de recette en jeu est dans [docs/VALIDATION.md](docs/VALIDATION.md).

## Installation

FXServer récent, OneSync, runtime serveur Node 22 avec `node:sqlite` disponible, accès OpenAI Realtime facturé, clients FiveM avec microphone/WebRTC. Le démarrage refuse une base JSON corrompue et un runtime sans SQLite; il ne supprime pas les anciennes données.

Placer la ressource dans `resources/[local]/fivemai`, avec le manifeste à la racine :

```sh
npm ci --ignore-scripts
npm test
npm run check
```

Dans un fichier de configuration serveur privé, chargé avant la ressource :

```cfg
set fivemai_openai_key "VOTRE_CLE_PRIVEE"
set onesync on
ensure fivemai
```

Utiliser `set` pour la clé. Les secrets restent côté serveur. La NUI reçoit uniquement le SDP de l'appel et un jeton de relais audio, jamais la clé OpenAI. Le fournisseur initial ne prétend à aucun quota gratuit.

`config.json` définit le contenu public et les paramètres par défaut. `config.local.json`, ignoré par Git et exclu des archives, peut remplacer les sections serveur (fusion superficielle); sauvegarder vos personnalisations avant mise à jour. Aucun service auxiliaire n'est requis : SQLite est embarqué dans le runtime serveur. Le mode autonome fournit réellement portefeuilles, inventaires et stocks; il n'est pas branché automatiquement sur une économie ESX/QB.

## Ce qui est jouable dans le code livré

| Personnage | Emplacement | Métier et missions |
| --- | --- | --- |
| Marcel Dubois | Garage, `-341.7, -133.5, 39` | Réparation, peinture, améliorations autorisées; pièces du garage et réparation contrôlée |
| Léa Moreau | Presse, `-537.5, -213, 37.65` | Reconnaissance de trois lieux publics puis escorte à pied |
| Sami Benali | Station taxi, `903.4, -173.8, 74.1` | Devis et conduite GTA vers des lieux extensibles; mission avec Sami passager |
| Nora Mercier | Épicerie, `25.7, -1346.8, 29.5` | Vente réelle sur catalogue/stock; livraison d'un panier à Pillbox |
| Alice Renard | Mission Row, `425.1, -979.5, 30.7` | Intervention sur incident serveur validé, poursuite/menottage/amende; reconnaissance du quartier |

Les personnages peuvent se déplacer selon leurs horaires. Leurs positions d'action et la portée vocale utilisent les entités réelles. Les passants éligibles acquièrent des identités séparées et peuvent être suivis par la population persistante. Les profils suivis vivants sont recréés après disparition ou redémarrage à leur dernière position enregistrée; un humain mort ne ressuscite pas par défaut. Une entité existante n'est jamais téléportée pour terminer une action.

Exemples vocaux : « Répare la voiture AA123BB », puis accepter le devis; « Emmène-moi à l'aéroport », puis accepter et monter à bord; « Montre ton catalogue »; « Tu as une mission pour moi ? ». Le PNJ attend le résultat de son outil avant de confirmer. Les lieux et tarifs proviennent du moteur, les accusations et récompenses ne sont pas inventées par l'IA.

Les réparations fonctionnent lorsque le joueur est à pied près du véhicule. Plusieurs véhicules imposent un choix par plaque. Les améliorations viennent uniquement de `mechanic.upgrades`; une modification indisponible pour le modèle est refusée. Le taxi réserve le montant puis ne le capture qu'après une arrivée contrôlée : véhicule retenu, PNJ conducteur, joueur à bord, même bucket, arrêt et destination. Une interruption rembourse la réservation.

La police utilise un incident réellement validé par un script serveur ou des dégâts réseau corrélés à une baisse de santé. Une déclaration du joueur ou un souvenir de conversation n'est jamais une preuve pénale. La détention autonome est un menottage temporaire sur place; les systèmes externes de prison/fouille doivent être intégrés explicitement.

## Voix, mémoire et autonomie

La voix suit le circuit **microphone → modèle audio → audio du PNJ**. Le propriétaire garde sa lecture WebRTC directe; son flux distant réel est relayé en PCM aux auditeurs autorisés à proximité. Un seul appel et un interlocuteur principal par PNJ : les autres joueurs entendent la même réponse et reçoivent un refus explicite s'ils demandent la parole tant que l'interlocuteur garde la session. Le relais ajoute une latence à mesurer et dépend du client interlocuteur; son contenu sonore n'est pas une preuve de gameplay.

Le volume baisse entre 3 et 18 mètres sans interrompre l'appel. Revenir pendant une phrase permet d'en entendre la suite. Les sons de parole/pain natifs sont suspendus localement pendant la prise en charge; les événements observés remplacent certaines réactions, sans intercepter chaque phrase native. Une nouvelle connexion spontanée a la latence de WebRTC/OpenAI.

Le choix du micro s'effectue avec `pnjmicro`, `pnjmicro 2` ou `pnjmicro default` dans F8. `pnjdiag` affiche les peds repérés. N peut être remplacé dans les assignations FiveM. L'écoute des voisins n'ouvre pas leur microphone.

La mémoire distingue observations serveur, observations client incertaines, déclarations et rumeurs, avec séparation par licence/PNJ. Les rumeurs proviennent uniquement d'événements explicitement publics et de rencontres physiques; les conversations privées ne circulent pas. Relations et mission réussie modifient durablement refus, tarifs et accès. Les routines proches utilisent un exécuteur GTA unique; loin des joueurs, besoins et horaires progressent sous forme simplifiée, sans session vocale permanente par passant.

## Commandes et intégration

Commandes joueur dans le chat : `/pnjsolde`, `/pnjinventaire`, `/pnjutiliser medicine`, `/pnjutiliser repair_kit`, `/pnjmission`. L'eau et le pain modifient les besoins internes; soins et kit nécessitent une modification native effectivement observée côté serveur. Console administrateur : `pnjbackup` et `pnjstats`.

Les exports `BindNPCProfile`, `RecordEvent`, `RecordIncident`, `RecordPerceivedEvent`, `RecordNPCEvent`, `RegisterJob`, `RegisterVoiceProvider`, `RegisterAdapter` et `RegisterItemEffect` sont des frontières **serveur de confiance**. Les inventaires, récompenses, amendes et stocks ont des exports dédiés. Leur contrat et les exemples se trouvent dans [docs/ADMIN.md](docs/ADMIN.md). Les adaptateurs ESX/QBCore/Qbox prêts à l'emploi ne sont pas fournis; un hook déclaré doit réellement être raccordé au moteur concerné.

Une conversation qui expire conserve une réparation ou un trajet déjà commencé. La mort, la disparition d'entité, le changement de bucket, une interruption de danger ou la déconnexion peuvent arrêter l'activité. Les échecs de contrôle réseau, de navigation, les sièges occupés et les véhicules déplacés remontent un résultat d'échec.

## Mise à jour, sauvegardes et retour arrière

La base inspectée est le commit `2ac8d27b06d6e40c35bf3ef08b7680c8b04d2f35`, conservé sous `backup-before-living-city-2026-10-13`. Une archive du checkout et un bundle Git ont été créés avant modification. Les données privées réelles de votre serveur ne sont pas présentes dans ce workspace : sauvegarder votre `data/` et votre configuration locale avant déploiement.

Au premier démarrage, `profiles.json` et `memory.json` sont copiés en `.before-sqlite-v1.bak`, puis importés atomiquement et une seule fois dans `data/fivemai.sqlite`. Les originaux restent intacts. `pnjbackup` produit un instantané SQLite cohérent. Copier uniquement le fichier `.sqlite` d'un serveur actif ne remplace pas cette procédure WAL.

Pour revenir au code sauvegardé, arrêter la ressource, préserver les données actuelles, puis sélectionner le tag. L'ancienne version lit le JSON et ne sait pas lire les progrès SQLite; revenir également aux JSON sauvegardés perd l'accès aux progrès créés depuis la migration. Le retour arrière n'est donc jamais une conversion automatique silencieuse. Voir [docs/ADMIN.md](docs/ADMIN.md) pour la procédure complète.

## Contrôles et mesures

```sh
npm test
npm run check
npm run benchmark -- --players 128 --peds 200 --profiles 5000 --ticks 100
npm run package -- --output /CHEMIN_ABSOLU/fivemai-living-city.zip
```

Le paquet source exclut données, secrets, dépendances installées et fichiers temporaires. Réinstaller les dépendances à destination. Les mesures Node/SQLite reproductibles sont publiées dans [docs/benchmarks/node-sqlite-2026-10-13.json](docs/benchmarks/node-sqlite-2026-10-13.json); elles n'établissent pas une capacité mesurée de 128 joueurs sur FXServer.

Pour l'audit initial et la séparation des modules : [AUDIT](docs/AUDIT.md), [ARCHITECTURE](docs/ARCHITECTURE.md), [ADMIN](docs/ADMIN.md), [VALIDATION](docs/VALIDATION.md), [STATUS](docs/STATUS.md).
