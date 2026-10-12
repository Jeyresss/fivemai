# fivemai — PNJ vocaux, profils persistants et métiers

Ressource autonome FiveM. Conversations vocales bidirectionnelles WebRTC avec `gpt-realtime`, sans pipeline de transcription ni synthèse à partir de texte. Les biographies, souvenirs et outils métier sont du contexte textuel; la voix passe directement par OpenAI Realtime.

## Installation et mise à jour

FXServer récent avec Node 22, OneSync, accès OpenAI Realtime et facturation active. Placer le checkout dans `resources/[local]/fivemai`, avec `fxmanifest.lua` directement à la racine, puis :

```bash
npm ci --ignore-scripts
npm test
npm run check
```

Dans une configuration serveur privée, hors Git :

```cfg
set fivemai_openai_key "VOTRE_CLE_PRIVEE"
```

Charger cette configuration avant `ensure fivemai` dans `server.cfg`. Utiliser `set`, jamais `setr` ou `sets`. Activer OneSync :

```cfg
set onesync on
ensure fivemai
```

Le serveur doit pouvoir joindre `api.openai.com` en HTTPS et WebSocket. Les clients doivent disposer de la connectivité WebRTC OpenAI; une règle HTTP seule ne garantit pas le passage de l’audio.

Pour mettre à jour, dans le dossier de la ressource : `git pull --ff-only origin main`, puis `npm ci --ignore-scripts`. Dans la console FXServer : `restart fivemai`. Sauvegarder `data/` avant changement de serveur ou redéploiement. Si `config.json` a été personnalisé, conserver ces modifications et résoudre explicitement les éventuels conflits Git.

## Parler et entendre à proximité

Approcher un PNJ humain vivant, maintenir **N** et parler après « Connecté ». Relâcher pour demander sa réponse. Une nouvelle pression peut interrompre le PNJ. Aucun menu ni curseur; seul un indicateur vocal est affiché. La touche se change dans **Paramètres → Assignation des touches → FiveM → Maintenir pour parler au PNJ (IA)**.

La distance d’interaction est de 3 mètres. La voix est à plein volume jusqu’à `voiceFullDistance` (3 m), baisse progressivement jusqu’à `voiceMaxDistance` (18 m), puis devient inaudible. **S’éloigner ne ferme plus la connexion ni la lecture**. Si le PNJ parle encore quand vous revenez, vous entendez la suite de sa phrase, sans rejouer l’audio manqué. Le microphone est coupé lorsque vous ne maintenez pas la touche et lorsque vous quittez la portée d’interaction.

La conversation reste individuelle : l’atténuation est calculée pour l’interlocuteur; les autres joueurs ne reçoivent pas encore la voix du PNJ. La session se termine à sa durée maximale (180 s), à la déconnexion, au changement de bucket, à la disparition réelle du PNJ réseau ou à un changement de personnage. Ces limites restent différentes de la portée d’écoute.

Deux personnages de démonstration restent disponibles : Marcel (-341.7, -133.5, 39.0) et Léa (-537.5, -213.0, 37.65). Mettre `npcs: []` dans la configuration pour ne garder que les passants.

## Profils des passants

Avec `ambientNPCs: true`, la ressource recherche le PNJ humain vivant le plus proche parmi les peds chargés. À la première interaction, le serveur lui attribue prénom, nom, métier, personnalité, voix et biographie procédurale distincte. Les profils sont enregistrés dans `data/profiles.json`. Leur création locale ne nécessite pas un appel OpenAI supplémentaire. La limite `maxProfiles` est de 5 000; au-delà, la création est refusée plutôt que de supprimer silencieusement des personnages.

Les humains réseau peuvent partager leur identité entre joueurs. Une seule conversation active est autorisée par personnage. Les joueurs et les animaux sont exclus. Les PNJ purement locaux doivent pouvoir être enregistrés en réseau; si FiveM refuse cette opération, la conversation est refusée avec un diagnostic F8. Les scripts qui limitent la population ou le contrôle des entités peuvent nécessiter une intégration.

Un identifiant de ped ou de réseau n’est pas une identité durable après suppression/recréation. Le profil et ses souvenirs restent stockés, mais un nouveau passant reçoit un nouveau profil. Pour vos personnages récurrents, votre script de spawn doit conserver l’ID de profil et le rattacher après recréation, via cet export **serveur** :

```lua
exports['fivemai']:BindNPCProfile(networkId, profileId)
local profile = exports['fivemai']:GetNPCProfile(profileId)
```

Le serveur n’adopte pas une identité simplement déclarée par le client. Les deux PNJ fixes de démonstration restent des peds locaux, dans le bucket principal.

## Mémoire et perception

`data/memory.json` conserve les faits sélectionnés par le modèle, séparés par licence FiveM et personnage : 100 entrées récentes par paire. Chaque session reçoit jusqu’à 20 souvenirs relationnels et 10 observations publiques du PNJ. Les outils sont traités sur une connexion OpenAI sideband authentifiée côté serveur. Ce n’est pas un enregistrement exhaustif des conversations.

Vos scripts serveur doivent transmettre les événements qu’un PNJ a réellement vus ou entendus. Ils déterminent les témoins, la visibilité, les obstacles et les rumeurs; cette ressource ne détecte pas automatiquement tous les vols.

```lua
-- Mémoire du PNJ concernant ce joueur précis.
exports['fivemai']:RecordEvent(playerSource, {
    description = 'Marcel a vu ce joueur voler une voiture rouge devant son garage.',
    witnesses = { 'marcel_dubois' }
})

-- Observation publique propre au PNJ, accessible dans ses futures conversations.
exports['fivemai']:RecordNPCEvent('marcel_dubois', 'Une voiture rouge a été volée devant le garage.')
```

Ne jamais relayer directement une description arbitraire du client vers ces exports. Qualifier une information entendue de rumeur, sans la transformer en observation certaine. Les émotions sont guidées par la personnalité et les souvenirs; leur cohérence parfaite ne peut pas être garantie.

## Premier métier : mécanicien

Le métier `mechanic` expose deux outils Realtime : établir un devis, puis effectuer un service après accord oral explicite. Marcel est mécanicien; les modèles de mécaniciens listés dans `jobs[].models` reçoivent également ce métier. Les autres passants reçoivent un métier de la liste. Un métier narratif sans outils ne peut pas encore agir.

Services disponibles : réparation et peinture (rouge, bleu, noir, blanc, vert, jaune, orange, violet). **Ils sont gratuits dans ce prototype**, sans portefeuille, retrait d’argent ni intégration économique.

Pour tester : garer votre voiture près de Marcel, sortir et dire « Peux-tu réparer ma voiture ? ». Le joueur n’a plus besoin d’occuper le véhicule. Le serveur recherche les véhicules réseau dans le même bucket, à moins de 10 m du mécanicien et de 12 m du joueur. Avec un seul véhicule, sa plaque est retenue automatiquement. Avec plusieurs véhicules, l’outil renvoie les plaques et le PNJ demande laquelle choisir : répondre par exemple « La plaque est AA123BB ». Les espaces, tirets et différences de casse sont ignorés; les plaques inconnues ou identiques sur plusieurs voitures sont refusées.

Après accord sur le devis, le véhicule reste fixé à son identifiant réseau, son entité, son modèle et sa plaque : une voiture qui devient plus proche ne peut pas le remplacer. Le mécanicien rejoint un point devant le capot, obtenu à partir des dimensions et de l’orientation de la voiture, se tourne vers elle, ouvre le capot, puis lance l’animation de réparation. L’intervention commence seulement après son arrivée; le serveur attend quatre secondes et revalide le véhicule avant d’autoriser les natives côté client. À la fin, le capot est refermé s’il avait été ouvert par le service, et les PNJ de démonstration retournent à leur point de départ.

Le client doit obtenir le contrôle réseau du PNJ et du véhicule. Un trajet impossible, un contrôle refusé ou un déplacement de la voiture interrompt le service. Un véhicule sans capot ouvrable ne permet pas cette séquence de réparation. Le joueur reste à proximité et peut être à pied pendant toute l’intervention. Les services sont gratuits et n’intègrent pas encore les clés, la propriété des véhicules ni une économie. La confirmation vocale est interprétée par le modèle. Le résultat natif est confirmé par le client; il ne doit pas déclencher de récompense ni de paiement sans vérification supplémentaire.

Les PNJ fixes utilisent `jobId` dans `config.json`. Un script serveur peut attribuer un métier à un profil ambiant inactif :

```lua
exports['fivemai']:AssignNPCJob(profileId, 'mechanic')
```

Les métiers sont définis dans `server/jobs.js` via `JobRegistry`. Un script serveur JavaScript peut appeler `RegisterJob` avec `{id, label, tools, execute}` : `tools` contient les schémas Realtime; `execute(name, context, args)` réalise des validations serveur et retourne un résultat, éventuellement asynchrone. Les fonctions viennent de scripts serveur de confiance, jamais de code fourni par l’IA. Prévoir un identifiant et un libellé dans la configuration pour la génération automatique de ce métier.

## Microphone Windows

La NUI utilise un périphérique Windows qui peut différer du micro du chat vocal GTA. Dans **F8**, sans menu :

- `pnjmicro` liste les entrées audio.
- `pnjmicro 2` sélectionne la deuxième entrée de cette liste et ferme la session courante pour appliquer le choix à la prochaine connexion.
- `pnjmicro default` restaure le défaut Windows.

Relâcher puis maintenir la touche pour reconnecter. Le choix est conservé localement. Vérifier le signal dans **Windows → Système → Son → Entrée** et les autorisations microphone des applications de bureau.

L’indicateur affiche le niveau lorsque Chromium expose cette statistique. F8 indique le microphone, le niveau maximum et les octets audio envoyés. Des paquets audio peuvent contenir du silence; un niveau indisponible ne signifie pas un niveau nul. Les erreurs de microphone, de lecture et d’OpenAI sont également affichées.

## Vérifications et limites

Les tests cloud vérifient la logique de prise de parole, l’atténuation/reprise du volume, la persistance des profils, l’isolation des mémoires et les validations des métiers. Les nouvelles fonctions ne sont pas validées sur un FXServer dans le cloud. Le fonctionnement vocal de la version précédente a été confirmé par l’utilisateur sur son serveur.

Tests en jeu à réaliser après mise à jour :

1. Pendant une longue réponse, s’éloigner au-delà de 18 m et revenir avant la fin : entendre la suite sans nouvelle connexion.
2. Rencontrer deux passants : identités distinctes; retrouver le même ped : profil et souvenir conservés. Avec un second joueur, vérifier la même identité et le refus si le PNJ est occupé.
3. Vérifier que disparition/recréation d’un passant ne réutilise pas l’identité par accident; tester `BindNPCProfile` pour un personnage récurrent.
4. À pied près de Marcel et de la voiture garée : demander une réparation et une peinture, accepter le devis, vérifier les changements réels. Tester aussi choix par plaque avec plusieurs véhicules, ouverture du capot, refus et départ pendant l’intervention et absence de réussite annoncée après échec.
5. Vérifier microphone, erreurs réseau, déconnexion, changement de bucket, durée limite et arrêt de ressource.

Le JSON convient à un prototype mono-instance. Sauvegarder `data/`, limiter les droits d’accès et définir une politique de conservation; les fichiers ne sont pas chiffrés. Le serveur limite les sessions simultanées à huit et les ouvertures à une toutes les dix secondes par joueur. Les processus Realtime sont à redémarrer après un redéploiement; les données conservées ne sauvegardent pas les appels actifs.

### Profil qui ne se résout pas

Les PNJ fixes démarrent directement à partir de leur profil configuré; leur appel reste autorisé côté serveur. Les passants utilisent une demande de profil numérotée et attendent un retour explicite. Un PNJ pas encore visible sur le serveur donne lieu à trois tentatives au maximum. Une erreur permanente est affichée dans F8 et détaillée par étape dans txAdmin; les erreurs vides ou les refus dus à la fréquence des demandes ne restent plus silencieux.

Au démarrage, la console serveur doit afficher `[fivemai] Serveur prêt — résolution des profils v2.`. Si F8 indique que le serveur ne répond pas, vérifier d’abord les erreurs de chargement serveur et la mise à jour complète de la ressource, plutôt que modifier le microphone ou la clé OpenAI.

### Touche de parole et chargement de l’interface

La commande maintenue `+fivemai_talk` et sa commande de relâchement `-fivemai_talk` restent associées à N par défaut, avec modification dans les paramètres FiveM. L’ouverture de l’interface est mise en attente si elle n’est pas encore chargée; son accusé de réception empêche une session bloquée après une pression trop tôt au redémarrage. Les PNJ configurés sont repérés directement et restent utilisables sans parcours de la population ambiante. Une pression hors de portée affiche un motif plutôt que rester silencieuse.

### PNJ visible mais non sélectionné, ou ligne F8 vide

La recherche utilise les coordonnées explicites des peds, puis une énumération native si le pool ne contient pas le personnage. Les modèles de démonstration situés près de leur point de spawn retrouvent leur profil configuré. `pnjdiag` dans F8 affiche le nombre de personnages détectés et, pour le plus proche, la distance et les indicateurs joueur/mort/humain. Un personnage joueur n’est jamais traité comme PNJ, même s’il porte un modèle de mécanicien.

Les erreurs de microphone sans message affichent désormais leur type. Si l’identifiant enregistré d’un microphone n’est plus disponible, la NUI signale explicitement le problème, essaie le défaut Windows et efface l’ancien choix seulement si cette capture fonctionne. `pnjmicro` permet ensuite de choisir à nouveau le casque.

Après mise à jour, F8 doit afficher `Version npc-capture-2`. La console txAdmin affiche aussi le chemin de la ressource chargée : vérifier que c’est le checkout où `git pull` a été exécuté si plusieurs dossiers `fivemai` existent.
