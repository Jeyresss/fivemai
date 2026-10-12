# fivemai — PNJ vocaux avec OpenAI Realtime

Première ressource autonome FiveM. Deux PNJ configurés ont chacun prénom, nom, métier, histoire, personnalité et voix. Conversation audio bidirectionnelle WebRTC avec `gpt-realtime`, prise de parole à touche maintenue et interruption. Aucun service de transcription ni conversion texte → voix n’est utilisé. Les descriptions et souvenirs sont du texte de contexte; l’API peut émettre des événements textuels de sortie, qui ne servent pas à produire la voix.

## Installation

Prérequis : FXServer récent avec Node 22, OneSync activé, compte OpenAI autorisé pour Realtime et facturation active. Le client FiveM doit réellement autoriser `getUserMedia` dans sa NUI. **Cette compatibilité microphone n’a pas été validée dans le cloud** : si le client refuse la capture, cette version ne fournit pas de conversation vocale. Une passerelle audio externe serait alors nécessaire; aucun contournement par transcription n’est prévu.

1. Placer le dossier dans `resources/[local]/fivemai` (le nom de ressource doit être `fivemai`).
2. Dans ce dossier : `npm ci --ignore-scripts`, puis `npm test` et `npm run check`.
3. Définir la convar **serveur uniquement** `fivemai_openai_key` dans un fichier privé de configuration FXServer, hors dépôt. Utiliser `set`, jamais `setr` ou `sets`. Ne pas mettre la clé dans `config.json`, les fichiers NUI ou Git. Exemple de syntaxe avec valeur fictive : `set fivemai_openai_key "VOTRE_CLE_PRIVEE"`.
4. Charger ce fichier privé via `exec` dans `server.cfg`, activer OneSync (`set onesync on`), puis `ensure fivemai`.
5. Autoriser HTTPS et WebSocket vers `api.openai.com` sur le serveur et la connectivité WebRTC OpenAI sur les clients. WebRTC peut nécessiter UDP/TURN selon le réseau; une simple règle HTTP ne garantit pas la voix.

Approcher Marcel (-341.7, -133.5, 39.0) ou Léa (-537.5, -213.0, 37.65). Maintenir **N** pour parler, puis relâcher pour demander la réponse vocale. Aucun menu ni curseur : seul un petit indicateur affiche la connexion, la prise de parole et les erreurs. À la première pression, attendre le message « Connecté » avant de parler; la voix prononcée pendant la connexion n’est pas conservée. La touche est modifiable dans **Paramètres → Assignation des touches → FiveM → Maintenir pour parler au PNJ (IA)**. Une nouvelle pression interrompt la réponse. S’éloigner ferme la session; le serveur limite aussi sa durée. Le micro est coupé hors de la prise de parole. L’indicateur précise que la voix est une IA. Le micro GTA et celui de la NUI peuvent fonctionner simultanément : configurer votre chat vocal pour éviter que les autres joueurs entendent une conversation privée.

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
- Maintenir la touche pendant une question, la relâcher, entendre la réponse puis interrompre le PNJ avec une nouvelle pression. Vérifier aussi le changement de touche dans les paramètres.
- Dire un fait durable, terminer, reconnecter et vérifier le souvenir, y compris après redémarrage du serveur.
- Enregistrer un événement via un script serveur : seul le témoin doit le connaître; un autre joueur ne doit pas partager cette mémoire.
- Vérifier fermeture à distance, déconnexion, durée limite, erreurs OpenAI et arrêt de ressource.

Les tests cloud couvrent persistance, isolation des mémoires, rétention, requêtes API, activation du micro et séquence commit audio → réponse; ils ne remplacent pas ces vérifications.

Si le PNJ reste silencieux : vérifier que l’indicateur passe à « Connecté », puis « Le PNJ vous écoute » pendant la pression et « Le PNJ prépare sa réponse » après relâchement. Les erreurs de microphone, de lecture, de connexion et les refus OpenAI sont affichés et envoyés dans F8. Vérifier le microphone par défaut de Windows et ses autorisations. Le fait que la création de l’appel réussisse ne prouve pas que le navigateur capture du son ni que le réseau transporte l’audio.

### Microphone silencieux ou mauvais périphérique (Windows)

L’indicateur affiche le niveau du micro pendant la touche maintenue, quand Chromium expose ces statistiques. F8 affiche le périphérique réellement utilisé, le niveau maximum et les octets audio envoyés. Un appel accepté ou des octets envoyés ne garantissent pas un signal vocal : WebRTC peut envoyer du silence. Un niveau non disponible ne signifie pas un niveau nul.

Dans **F8** (sans menu) : `pnjmicro` liste les entrées audio Windows. `pnjmicro 2` sélectionne par exemple la deuxième entrée; utilisez le numéro de votre microphone dans la liste. Éloignez-vous du PNJ pour fermer la connexion, puis revenez et maintenez la touche pour reconnecter. Le choix est conservé localement sur ce client FiveM. `pnjmicro default` revient au périphérique Windows par défaut. Le réglage du micro dans le chat vocal GTA/FiveM ne change pas nécessairement le micro de la NUI. Si le périphérique disparaît, resélectionnez-le ou revenez au défaut; la capture ne bascule pas silencieusement vers un autre appareil.

Vérifier aussi le signal dans Windows → Système → Son → Entrée et les autorisations microphone des applications de bureau. Parler seulement après « Connecté ». Ces diagnostics et la sélection d’appareil ne garantissent pas la capture sur chaque build FiveM : les statistiques et le test en jeu permettent de localiser le problème restant.
