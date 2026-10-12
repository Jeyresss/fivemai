# fivemai — PNJ vocaux avec OpenAI Realtime

Première ressource autonome FiveM. Deux PNJ configurés ont chacun prénom, nom, métier, histoire, personnalité et voix. Conversation audio bidirectionnelle WebRTC avec `gpt-realtime`, détection des tours de parole et interruption. Aucun service de transcription ni conversion texte → voix n’est utilisé. Les descriptions et souvenirs sont du texte de contexte; l’API peut émettre des événements textuels de sortie, qui ne servent pas à produire la voix.

## Installation

Prérequis : FXServer récent avec Node 22, OneSync activé, compte OpenAI autorisé pour Realtime et facturation active. Le client FiveM doit réellement autoriser `getUserMedia` dans sa NUI. **Cette compatibilité microphone n’a pas été validée dans le cloud** : si le client refuse la capture, cette version ne fournit pas de conversation vocale. Une passerelle audio externe serait alors nécessaire; aucun contournement par transcription n’est prévu.

1. Placer le dossier dans `resources/[local]/fivemai` (le nom de ressource doit être `fivemai`).
2. Dans ce dossier : `npm ci --ignore-scripts`, puis `npm test` et `npm run check`.
3. Définir la convar **serveur uniquement** `fivemai_openai_key` dans un fichier privé de configuration FXServer, hors dépôt. Utiliser `set`, jamais `setr` ou `sets`. Ne pas mettre la clé dans `config.json`, les fichiers NUI ou Git. Exemple de syntaxe avec valeur fictive : `set fivemai_openai_key "VOTRE_CLE_PRIVEE"`.
4. Charger ce fichier privé via `exec` dans `server.cfg`, activer OneSync (`set onesync on`), puis `ensure fivemai`.
5. Autoriser HTTPS et WebSocket vers `api.openai.com` sur le serveur et la connectivité WebRTC OpenAI sur les clients. WebRTC peut nécessiter UDP/TURN selon le réseau; une simple règle HTTP ne garantit pas la voix.

Approcher Marcel (-341.7, -133.5, 39.0) ou Léa (-537.5, -213.0, 37.65), appuyer sur E (ou `/parlerpnj`), puis cliquer sur « Activer le microphone ». Échap termine la conversation. La fenêtre indique explicitement que la voix est une IA. Le micro GTA et celui de la NUI peuvent fonctionner simultanément : configurer votre chat vocal pour éviter que les autres joueurs entendent une conversation privée.

## Identités et mémoire

Modifier `config.json` pour ajouter des PNJ avec un `id` stable, un modèle GTA valide, des coordonnées et une biographie distincte. Cette version fait apparaître des PNJ fixes locaux, dans le bucket principal; elle n’attribue pas automatiquement une identité à chaque passant ambiant. Les dialogues sont individuels; les autres joueurs n’entendent pas cette voix. Les émotions sont guidées par le contexte et les instructions, sans garantie de cohérence psychologique parfaite.

La mémoire est stockée dans `data/memory.json`, indexée par licence FiveM et ID de PNJ. Les faits durables de conversation sont enregistrés via un outil traité sur une connexion OpenAI sideband authentifiée côté serveur. Ce sont des souvenirs sélectionnés par le modèle, pas un enregistrement exhaustif : 100 entrées récentes par paire, 30 fournies au démarrage, maximum 20 écritures par session. Sauvegarder ce dossier entre déploiements. Les données ne sont pas chiffrées; limiter les droits et définir votre politique de conservation. Supprimer les entrées d’une licence, serveur arrêté, pour effacer sa mémoire.

Les autres scripts de jeu doivent transmettre leurs événements **depuis le serveur**, après validation du gameplay. Aucun client ne peut déclarer directement un vol via un événement réseau de cette ressource. Exemple Lua, à intégrer à votre script de vol :

```lua
-- playerSource : voleur confirmé; témoins déterminés par votre script serveur.
exports['fivemai']:RecordEvent(playerSource, {
    description = 'Marcel a vu ce joueur voler une voiture rouge devant son garage.',
    witnesses = { 'marcel_dubois' }
})
```

Seuls les témoins listés apprennent l’événement. Votre intégration doit déterminer visibilité, distance, obstacles et rumeurs : la ressource ne détecte pas elle-même tous les vols. Ne jamais convertir cet export en relais réseau acceptant des descriptions arbitraires du client. Pour une information entendue, l’indiquer explicitement comme rumeur. Les événements pendant une conversation sont ajoutés au contexte sans forcer une réplique immédiate.

## Limites et sécurité

Clé serveur, SDP transmis via événements FiveM, connexion WebRTC directe au fournisseur. Vérification serveur de proximité et du bucket, une session par joueur, huit simultanées, délai de dix secondes entre ouvertures, durée maximale de trois minutes. Le coût reste lié à la facturation OpenAI; définir aussi des budgets côté fournisseur. Le client contrôle sa connexion WebRTC et peut altérer ses instructions : les souvenirs de conversation sont à considérer comme non fiables, jamais comme preuve d’un crime ni comme autorisation de paiement, inventaire ou sanction. Aucune action de gameplay n’est confiée au modèle.

Le JSON convient à un prototype mono-instance; un serveur chargé nécessitera une base de données, une politique de rétention et une meilleure gestion des écritures. Aucune clé ni FXServer n’est présent dans la machine cloud, donc aucun appel vocal réel ni démarrage FiveM n’a été validé.

## Vérification en jeu requise

- Vérifier apparition des deux PNJ, refus à distance et accès au microphone.
- Poser oralement une question, entendre la réponse, puis interrompre le PNJ.
- Dire un fait durable, terminer, reconnecter et vérifier le souvenir, y compris après redémarrage du serveur.
- Enregistrer un événement via un script serveur : seul le témoin doit le connaître; un autre joueur ne doit pas partager cette mémoire.
- Vérifier fermeture à distance, déconnexion, durée limite, erreurs OpenAI et arrêt de ressource.

Les tests cloud couvrent persistance, isolation des mémoires, rétention et configuration audio; ils ne remplacent pas ces vérifications.
