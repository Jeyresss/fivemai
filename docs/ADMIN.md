# Installation, exploitation et intégration

## Installer la ressource

Prévoir un FXServer récent, OneSync, un runtime serveur JavaScript prenant en charge `node:sqlite`, et un compte OpenAI avec accès Realtime et facturation active pour la voix. La ressource déclare `node_version '22'`; certains builds Node 22 ne chargent pas SQLite sans option expérimentale. Vérifier la disponibilité dans le runtime réellement embarqué par votre build FXServer. Le runtime de développement utilisé pour les tests est indiqué dans `VALIDATION.md`. Aucun service auxiliaire, ESX, QBCore, Qbox, MySQL ou Redis n'est obligatoire.

Placer le dossier `fivemai` dans `resources/[local]/fivemai`, avec `fxmanifest.lua` directement à sa racine. Dans ce dossier :

```bash
npm ci --ignore-scripts
npm test
npm run check
node -e "require('node:sqlite').DatabaseSync; console.log('SQLite disponible dans ce Node')"
```

La dernière commande vérifie le Node de votre terminal, pas celui de FXServer. Une erreur SQLite au démarrage de la ressource doit être résolue en mettant à jour le runtime approprié; ne supprimer ni la base ni les fichiers JSON pour la masquer. Installer seulement les dépendances de production avec `npm ci --omit=dev --ignore-scripts` sur le serveur est possible après vérification complète ailleurs; Fengari est alors absent des tests et de l'analyse Lua.

Conserver la clé hors Git et hors `config.json`, dans une configuration privée chargée avant la ressource :

```cfg
set fivemai_openai_key "CLE_PRIVEE_OPENAI"
set onesync on
ensure fivemai
```

Utiliser `set`, pas `setr` ni `sets`. Le serveur doit joindre les endpoints HTTPS et WebSocket OpenAI. Les clients ont besoin d'un microphone autorisé dans Chromium/FiveM et de la connectivité WebRTC; la connexion HTTP du serveur ne suffit pas à vérifier ce circuit audio. Sans clé ou après épuisement du budget vocal, le script doit refuser clairement la conversation; les moteurs autonomes restent disponibles selon leurs règles. OpenAI Realtime n'est pas présenté comme gratuit.

## Données et migration

Le premier démarrage ouvre `data/fivemai.sqlite` et importe les anciens `data/profiles.json` et `data/memory.json` lorsqu'ils existent. Le code crée les sauvegardes `.before-sqlite-v1.bak` sans écraser les originaux ni une sauvegarde existante. Une marque de migration et les empreintes SHA-256 des sources rendent l'import idempotent. Les profils et souvenirs existants sont conservés; les conversations privées restent rattachées à leur joueur. Un JSON corrompu provoque un échec explicite et préserve son original et sa sauvegarde.

SQLite utilise WAL. Ne copier pas seulement le fichier `.sqlite` pendant une écriture : utiliser la sauvegarde cohérente de la ressource, ou arrêter la ressource puis copier intégralement `data/`. Conserver les sauvegardes hors de la ressource servie et en limiter l'accès. La base et les JSON ne sont pas chiffrés. Les souvenirs, soldes et inventaires sont des données serveur privées; l'archive source produite par `scripts/package.js` les exclut.

Les réservations de paiement d'un service interrompu sont remboursées au redémarrage. Les colis de mission suivent leur propre reprise persistante : ils ne doivent pas être distribués une deuxième fois ni être supprimés par la récupération des objets consommables. Une interruption de processus entre un effet GTA et l'enregistrement de sa confirmation reste une limite à vérifier; le moteur doit privilégier un remboursement et une nouvelle validation plutôt qu'inventer une réussite.

## Configuration et expérience joueur

`config.json` est envoyé à la NUI : il doit contenir uniquement des réglages publics. Conserver les secrets dans des convars privées. Un fichier optionnel `config.local.json`, exclu de l'archive source, surcharge les paramètres serveur; il ne remplace pas les réglages lus directement dans `config.json` par le client. Les paramètres historiques restent utilisables : `model`, `npcs`, `ambientNPCs`, `maxProfiles`, `interactionDistance`, `voiceFullDistance`, `voiceMaxDistance`, `voices`, `archetypes`, `actions`, `reactions`, `jobs` et `destinations`. La limite de profils refuse une création supplémentaire; elle ne supprime pas silencieusement un ancien personnage.

| Paramètre ajouté | Valeur par défaut / effet |
| --- | --- |
| `voiceProvider` | `openai`; seuls les fournisseurs effectivement enregistrés sont disponibles |
| `maxConcurrentSessions`, `maxSessionSeconds` | 8 conversations simultanées, 180 s par session |
| `voiceBudget.maxCallsPerDay`, `maxAudioSecondsPerDay` | 200 appels et 18 000 s de sessions par journée UTC; durée réservée avant ouverture, ajustée à fermeture, réservation conservatrice en cas de crash |
| `voiceRelay.maxListeners` | 32 auditeurs par session; diffusion du PCM du propriétaire, coût réseau proportionnel aux auditeurs |
| `maxToolsPerSession`, `maxOutputTokens` | 60 demandes d'outil, limite de sortie 1 024 tokens; aucune garantie de montant financier OpenAI |
| `storage.maxRecordBytes`, `maxBytes`, `maxRecords` | 1 Mio par valeur JSON, 64 Mio de payload JSON cumulé, 100 000 enregistrements; le fichier SQLite physique peut être plus grand |
| `economy.initialBalance`, `reservationSeconds` | 1 000 $, séquestres de service de 420 s |
| `mechanic.prices`, `mechanic.upgrades` | Réparation 250 $, peinture 300 $, améliorations moteur/freins/transmission/suspension autorisées par slot/index et prix |
| `taxi.baseFare`, `pricePerKm` | 40 $ + 25 $/km à vol d'oiseau pour le devis; le trajet est exécuté par les tâches GTA |
| `police.incidentMaxAgeSeconds`, `maxUnits`, `pursuitSeconds`, `retrySeconds` | Incident de 300 s maximum, 2 agents au plus, poursuite de 60 s, nouvelle tentative après 30 s |
| `simulation.nearRadius`, `maxDetailed`, `perPlayer`, `maxDispatchPerTick` | Rayon 100 m, 32 personnages détaillés, 8 par joueur, 8 nouveaux dispatchs par tick |
| `simulation.tickMs`, `dispatchIntervalMs`, `coarseIntervalMs` | Tick ville 5 s, renouvellement tâche 15 s, état simplifié 60 s |
| `simulation.maxRumors`, `maxPublicEvents` | 16 connaissances publiques par personnage et 250 événements publics |
| `sexOverrides` | Association modèle → sexe configuré pour les modèles personnalisés |
| `adapters.police` | Nom d'un adaptateur serveur enregistré proposant `enforce`; vide par défaut |

Les horaires de routine sont exprimés en minutes de la journée utilisée par le moteur, de 0 à 1 440. Ils ne constituent pas un calendrier de rendez-vous utilisateur. Les valeurs de budget vocal limitent les appels et la durée de sessions; surveiller séparément les dépenses dans le compte fournisseur.

L'interaction débute dans `interactionDistance` (4 m par défaut), indépendamment de la portée d'écoute (18 m). Maintenir N et parler après la connexion; relâcher pour obtenir la réponse; reprendre N pour interrompre. La touche est modifiable dans les assignations FiveM. Les témoins proches écoutent le même flux; un seul interlocuteur utilise le microphone de cette conversation. La disparition du ped, le changement de bucket, la déconnexion, la durée limite et l'arrêt de la ressource ferment la session.

Dans F8, `pnjmicro` liste les microphones, `pnjmicro 2` sélectionne le deuxième et `pnjmicro default` revient au défaut. Le changement s'applique à la prochaine session. `pnjdiag` aide à expliquer un ped non sélectionné. Le niveau sonore et les octets audio ne constituent pas à eux seuls une preuve d'une voix effectivement entendue. Les réactions remplacent localement les paroles natives pendant leur prise en charge; chaque parole GTA native n'est pas interceptée et une nouvelle connexion ajoute une latence.

Commandes joueur : `/pnjsolde`, `/pnjinventaire`, `/pnjutiliser water` (ou un autre ID du catalogue), `/pnjmission`. Les réponses sont affichées discrètement, sans menu obligatoire. Dans la console serveur, `pnjstats` expose stockage/sessions/missions/population et `pnjbackup` crée une sauvegarde SQLite cohérente. Ces deux commandes sont réservées à la console; elles ne créent pas une administration publique des soldes.

Le taxi résout les IDs, libellés et alias des lieux configurés. Ajouter autant de destinations que nécessaire à `destinations`, avec des coordonnées contrôlées. Une adresse inconnue demande une précision; le modèle ne fournit pas de coordonnées libres. La conduite GTA, les chemins et les collisions restent à valider sur la carte réelle.

La population persistante suit les passants enregistrés et les points de population configurés. Le profil conserve sa dernière position réellement observée et son incarnation; un nouveau handle ou network ID doit être rattaché côté serveur. Les routines agissent sur les personnages connus dans les budgets de simulation; cela ne rend pas automatiquement intelligents tous les peds GTA jamais rencontrés.

Lorsque `population.enabled` est activé, `nearRadius` et `despawnRadius` règlent respectivement la recréation proche et la libération lointaine des entités gérées; valeurs de moteur 100 et 150 m. `maxManagedEntities` vaut 40 et `maxSpawnsPerTick` 4 dans le moteur, avec surcharge publique possible. `maxTrackedProfiles` limite les identités suivies (5 000), pas le nombre de peds physiques simultanés. `spawnRetryMs` et `observationIntervalMs` valent 15 s. `seeds` définit des points `{id,model,coords,jobId?,sex?,bucket?}` dont le mapping de profil est créé une seule fois. Le décès est conservé et aucun personnage mort n'est ressuscité par défaut; `respawnAfterDeathSeconds > 0` active explicitement cette règle de jeu.

Le culling ne supprime pas un passant naturel non possédé par la ressource. Une recréation est un spawn explicite à la dernière position conservée, jamais une téléportation d'un ped déjà existant pour rattraper une routine. Les conflits avec d'autres ressources de population et les redémarrages à chaud doivent faire partie de la recette à deux clients.

## Intégrer des ressources serveur

Les exports sont réservés à des scripts serveur de confiance. Aucun client, modèle ou state bag n'a le droit de créer une preuve de paiement, de donner des objets ou de choisir une sanction. Pour un personnage durable créé par votre propre système de population :

```lua
local profile = exports['fivemai']:GetNPCProfile('marcel_dubois')
local attached = exports['fivemai']:BindNPCProfile(networkId, profile.id)
```

Conserver le profil dans votre système de spawn et rattacher le nouveau ped après recréation. Ne réutiliser pas un ancien network ID comme identité. `AssignNPCJob(profileId, jobId)` modifie le métier sans remplacer le profil. `RegisterJob` accepte un objet JavaScript `{id, label, tools, execute}` venant d'un script serveur; les outils réservés ne peuvent pas être remplacés.

Le mode autonome tient ses portefeuilles, stocks et inventaires dans SQLite. Il n'existe aucune connexion prête à l'emploi à ESX/QBCore/Qbox dans cette livraison. Les contrats d'adaptation acceptent des fonctions serveur, mais enregistrer un hook inutilisé ne change pas le moteur qui effectue une opération : vérifier les appels effectivement présents dans `server/runtime.js` avant intégration. Les amendes, la prison, les clés de véhicule et l'inventaire d'un framework doivent être raccordés explicitement au contrat utilisé. Ne compter pas un message affiché comme une incarcération ou une fouille d'inventaire.

| Export serveur | Utilisation |
| --- | --- |
| `RecordIncident(playerSource,event)` | Incident issu d'un script gameplay de confiance; `{id?,type,description,witnesses,radius?}`; le serveur filtre les témoins par proximité et bucket |
| `RecordPerceivedEvent(event,scope)` | Événement gameplay de confiance avec `actorSource`, `type`, `description`, témoins et visibilité privée par défaut; seuls les publics autorisés alimentent les rumeurs |
| `GetWallet(playerSource)`, `GetInventory(playerSource)` | Lecture du portefeuille ou des objets autonomes; identité fournie par le serveur |
| `RestockShop(vendor,itemId,quantity,operationId)` | Réapprovisionnement idempotent d'un vendeur |
| `GrantReward(playerSource,operationId,reward)` | Récompense de confiance `{money,items}`, à identifiant unique |
| `GetMissionStatus(playerSource)` | Mission et progression enregistrées par le moteur |
| `UseInventoryItem(playerSource,itemId,operationId)` | Réserve un objet, applique son effet enregistré, consomme seulement après succès |
| `RegisterItemEffect(itemId,fn)` | Fonction serveur asynchrone `fn(playerSource,data)` retournant `{ok:true}` seulement après l'effet réel |
| `BackupDatabase()` | Sauvegarde SQLite cohérente sous `data/backups/`, sans écraser une sauvegarde existante |
| `RegisterAdapter(name,hooks)` | Fonctions serveur de confiance; le hook police `enforce(ctx,sanction)` est consulté lorsque `adapters.police` choisit cet adaptateur |

Le solde initial autonome est de 1 000 $ par joueur par défaut, une seule fois à la création du portefeuille. Le catalogue initial comprend eau (15 $), pain (20 $), soins (90 $), kit de réparation (180 $), avec stocks configurables. Eau/pain mettent à jour les besoins simplifiés de cette ressource. La trousse soigne par native puis vérifie une augmentation de santé côté serveur; le kit répare le véhicule occupé et arrêté puis vérifie son identité et sa santé moteur côté serveur. Sans état serveur répliqué exploitable, l'effet est refusé et l'objet rendu. `RegisterItemEffect` peut remplacer ces effets par une fonction de confiance. Ces valeurs ne se synchronisent pas automatiquement avec les besoins d'un framework.

Une infraction n'est jamais créée par les seules paroles du modèle. Les événements de dégâts réseau sont corrélés à une baisse de santé observée par le serveur; les autres types de crime nécessitent un événement d'un script gameplay de confiance. L'intervention automatique sélectionne des agents témoins disponibles dans le même bucket, poursuit dans les limites configurées, explique le motif par la voix si le fournisseur est disponible et effectue la sanction après confirmation. En mode autonome, la garde à vue correspond à un menottage temporaire sur place; aucun déplacement en prison ni système judiciaire externe n'est livré. Si le joueur ne peut pas payer, l'amende reste due dans le registre de sanctions, sans fabriquer de monnaie.

## Personnages et missions livrés

Les personnages récurrents sont définis dans `server/content.js` et configurables dans `npcs`. Un stockage existant conserve les modifications d'identité faites auparavant; les valeurs du contenu ne réécrivent pas automatiquement sa biographie ou sa voix. Vérifier les positions de spawn/routines après personnalisation d'une carte.

| Donneur / position initiale | Mission | Objectif vérifié par le moteur | Récompense de base |
| --- | --- | --- | --- |
| Marcel, garage (-341,7; -133,5; 39) | Les pièces du garage | Prendre les pièces au dépôt, les livrer au garage puis revoir Marcel | 180 $ |
| Marcel | Remise en état contrôlée | Choisir un véhicule réellement endommagé, faire vérifier sa réparation par Marcel, revenir | 90 $; service facturé séparément; confiance de mission ≥ 2 |
| Léa, presse (-537,5; -213; 37,65) | La tournée des lieux | Présence temporisée sur la place, au port et à l'accueil du commissariat; retour | 150 $ |
| Léa | Rendez-vous à pied | Léa doit arriver vivante, physiquement près du joueur et de la place | 140 $; confiance de mission ≥ 2 |
| Sami, taxi (903,4; -173,8; 74,1) | Un passager pour Pillbox | Le joueur conduit et Sami est réellement passager du même véhicule à l'arrivée | 220 $ |
| Nora, épicerie (25,7; -1346,8; 29,5) | Le panier de l'hôpital | Prendre le panier, le livrer à Pillbox et revoir Nora | 120 $ |
| Alice, police (425,1; -979,5; 30,7) | Reconnaissance du quartier | Présence temporisée à trois lieux publics puis retour | 160 $ |

Les propositions et acceptations passent par les outils vocaux `mission_list`, `mission_offer`, `mission_accept`; `mission_status` et `mission_abandon` lisent l'état ou demandent un abandon confirmé. Le moteur fournit objectifs/prix/récompenses, pas le modèle. Une seule mission peut être active par joueur; une mission déjà terminée n'est pas répétable par défaut. Les délais continuent pendant une déconnexion; la reprise retrouve l'étape mais ne suspend pas sa date limite. Un véhicule sélectionné avant restart est revérifié ou doit être sélectionné à nouveau pour éviter un network ID réutilisé.

Les colis sont des objets scellés de l'inventaire autonome, conservés dans un séquestre de mission. La présence au point et sa durée sont contrôlées côté serveur. Aucun objet décoratif de colis posé dans le monde ni animation libre de remise à un autre ped n'est promis par ces deux livraisons. Les tournées d'enquête/reconnaissance valident un itinéraire, pas une preuve policière ou la découverte d'un suspect. Les récompenses et progrès de relation sont enregistrés une fois; les callbacks de conséquences sont repris sans rejouer la récompense.

## Mettre à jour et revenir en arrière

1. Tester la version sur un serveur de préproduction avec deux clients. Conserver votre configuration personnalisée, votre code d'intégration et l'intégralité de `data/`.
2. Arrêter la ressource : `stop fivemai`. Copier `data/` à l'arrêt, avec les éventuels fichiers WAL/SHM, vers une sauvegarde datée hors du dépôt.
3. Mettre à jour le code, puis réappliquer la configuration personnalisée en comparant explicitement les nouveaux paramètres. Ne remplacer pas `data/` par les données d'un autre serveur.
4. Exécuter `npm ci --ignore-scripts`, `npm test` et `npm run check`; démarrer avec `ensure fivemai`, lire le diagnostic de migration puis effectuer les scénarios de `VALIDATION.md`.

Pour un déploiement Git, préparer un checkout propre puis utiliser une révision identifiée. Le tag `backup-before-living-city-2026-10-13` contient la base d'avant cette évolution. Exemple de retour au code sauvegardé, ressource arrêtée et fichiers locaux sauvegardés :

```bash
git switch --detach backup-before-living-city-2026-10-13
npm ci --ignore-scripts
```

Cette ancienne version lit les JSON et ne sait pas relire les nouvelles écritures SQLite. Pour restaurer un état cohérent, utiliser votre sauvegarde de données d'avant mise à jour; conserver la base actuelle séparément pour ne pas perdre les progrès depuis la migration. Ne copier pas les `.bak` par-dessus les données actuelles à l'aveugle. Redémarrer la ressource seulement après avoir choisi le code et l'état de données compatibles. Pour revenir à la livraison, sélectionner sa branche ou son commit puis relancer l'installation et les contrôles. Un passage vers un schéma plus récent n'autorise pas automatiquement une rétrogradation.

## Construire une archive de livraison

```bash
node scripts/package.js --output /chemin/absolu/fivemai-source.zip
```

L'archive comprend les sources, la configuration publique, les dépendances verrouillées, les tests et les documents. Elle exclut `data/`, `work/`, `node_modules/`, les journaux, Git, les configurations `.cfg` et les fichiers de clés. Elle refuse d'écraser un fichier existant et signale une clé OpenAI potentielle détectée. Après extraction, exécuter `npm ci`; `node_modules` n'est pas embarqué.
