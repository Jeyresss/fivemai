# Architecture et autorité

La ressource reste autonome : scripts JavaScript serveur, client Lua et NUI. Une session OpenAI Realtime existe pour une conversation active, jamais pour chaque personnage simulé. Les métiers, missions et routines peuvent fonctionner sans ouverture permanente d'une session vocale.

| Module | Responsabilité |
| --- | --- |
| `server/database.js` | SQLite, espaces de clés, migrations JSON, transactions et sauvegardes cohérentes |
| `server/profiles.js`, `server/archetypes.js` | Identité durable, apparence, voix, métier, biographie et personnalité |
| `server/core.js` | Mémoire, relation joueur/PNJ, instructions vocales et utilitaires de validation |
| `server/index.js` | Entrées réseau/exports de confiance, sessions, vérifications d'entités, buckets et orchestration |
| `server/voice.js`, `server/provider.js` | Un interlocuteur propriétaire, un flux audio partagé et interface du fournisseur Realtime |
| `server/actions.js`, `client/main.lua` | Actions autorisées, contrôle réseau, tâches GTA, vérification et annulation |
| `server/economy.js`, `server/jobs.js`, `server/services.js` | Portefeuille et inventaire autonomes, stock, devis, métier, séquestres, facturation et remboursement |
| `server/perception.js` | Témoins et provenance; corrélation de dégâts réseau avec une baisse de santé relevée par le serveur; déclarations client non sanctionnantes |
| `server/population.js` | Profils de population suivis, incarnation réelle, observation des positions, création/despawn bornés des seules entités appartenant à la ressource |
| `server/runtime.js`, `server/simulation.js`, `server/missions.js`, `server/content.js` | Intégration aux natives serveur, événements validés, connaissances de témoins, routines proches/lointaines, objectifs persistants et contenu |
| `server/adapters.js`, `server/destinations.js`, `server/security.js` | Contrats d'intégration, lieux/alias autorisés, limites de requêtes, durée audio et arguments |
| `web/app.js` | Capture microphone et lecture audio; aucun secret OpenAI |

Une décision du modèle devient une demande d'outil structuré. Le serveur vérifie session, métier, proximité, bucket, entités et règles. Le client exécute uniquement la tâche préautorisée; le retour est borné par un jeton et un délai. Lorsque les natives serveur permettent de vérifier le résultat, le serveur les consulte. Les cas qui reposent encore sur l'accusé client sont explicités dans le statut et ne doivent pas être assimilés à une protection anticheat complète. Le modèle ne fournit ni code, ni prix faisant autorité, ni récompense faisant autorité.

La conversation est moins prioritaire qu'un métier, une mission, une conduite, une fuite ou un combat. Elle peut orienter un ped calme vers le joueur; elle ne remplace pas une tâche prioritaire. Les annulations libèrent les tâches de cette ressource et les séquestres concernés. Un obstacle produit un échec ou un délai dépassé; il ne déclenche pas de téléportation de rattrapage silencieuse.

L'ID de profil est indépendant du handle GTA et du network ID. Le serveur conserve son propre rattachement entre profil et entité; l'état répliqué d'un ped ne suffit pas à créer ce rattachement. Les personnages récurrents gardent leur profil lorsqu'ils sont recréés. Pour un autre script de population, appeler l'export serveur `BindNPCProfile` après le spawn.

SQLite contient `records(namespace,key,value,updated_at)` avec une clé primaire `(namespace,key)`, une table `migrations` et des statistiques de capacité mises à jour par des triggers. Le schéma actuel est en version 2. Les namespaces stockent profils, mémoires, relations et états des autres moteurs. WAL et `synchronous=FULL` assurent une durabilité locale transactionnelle; les écritures sont synchrones et leur coût figure dans le benchmark. Cette implémentation vise une seule instance de ressource. Elle ne constitue pas une base distribuée ni une garantie de capacité d'un serveur GTA.

Les souvenirs portent une provenance : `server_validated`, `observation`, `player_declaration` ou `rumor`. Une déclaration du joueur n'est pas une infraction validée. Une rumeur conserve sa source et ne circule que depuis les connaissances publiques autorisées; une conversation privée ne devient pas une rumeur. Les conséquences économiques et policières viennent d'événements approuvés côté serveur.

Le mode autonome possède ses propres soldes, inventaires et stocks. Ces objets virtuels ne deviennent pas automatiquement des objets ESX, QBCore ou Qbox. Les adaptateurs facultatifs sont des contrats de fonctions serveur de confiance; aucun connecteur à un framework externe n'est prétendu livré sans implémentation. Un adaptateur doit conserver les mêmes garanties d'idempotence, refus, remboursement et vérification.

La voix reste audio directe : microphone → WebRTC Realtime → voix du personnage. Le propriétaire entend le flux WebRTC direct; la NUI capture une fois sa sortie distante en PCM16LE mono à 24 kHz et relaie les mêmes échantillons aux auditeurs proches. Les témoins n'ouvrent ni microphone ni deuxième session IA. Le serveur filtre bucket/distance/propriétaire/jeton, séquence, époque d'annulation et débit; le client témoin limite sa file et rejette les paquets d'une époque terminée. Le PCM brut représente 48 000 octets/seconde de parole, avant encodage Base64 et protocole; le trafic de sortie se multiplie par le nombre d'auditeurs. Cela explique la limite d'auditeurs et la nécessité de mesurer le réseau sur le serveur ciblé.

Le serveur peut autoriser le relais du propriétaire, mais ne peut pas prouver cryptographiquement que chaque échantillon reçu provient d'OpenAI : la diffusion relève d'un client de confiance limitée. La latence, la synchronisation, le comportement WebAudio de CEF et les limites de débit doivent être vérifiés sur FXServer. Aucun chiffre de latence de relais en conditions réelles n'a été mesuré dans le cloud.
