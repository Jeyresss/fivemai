# Audit de la base avant évolution — 13 octobre 2026

L'audit porte sur le dépôt `Jeyresss/fivemai`, commit `2ac8d27b06d6e40c35bf3ef08b7680c8b04d2f35`, conservé dans le tag `backup-before-living-city-2026-10-13`. Le dépôt distant et le checkout avaient le même commit. Les huit fichiers de tests historiques passent après installation des dépendances. Leur transport Realtime, navigateur et natives GTA sont simulés : ce résultat n'établit pas une validation FiveM.

Avant modification, le code suivi a été conservé dans `work/backups/fivemai-before-living-city-2026-10-13.tar.gz` et dans un bundle Git du même nom. Ces archives de code ne contiennent pas les données privées d'un serveur de production. La mise à jour de ce checkout ne touche pas les données de votre FXServer distant.

| Système de départ | Constat dans le code | Conséquence |
| --- | --- | --- |
| Voix | WebRTC navigateur ↔ OpenAI Realtime, contrôle serveur par connexion latérale; N maintenu, interruption et atténuation selon distance | Préserver ce circuit audio et les tests de microphone |
| Voix des témoins | Seul l'interlocuteur reçoit le flux vocal | Ajouter une diffusion des mêmes échantillons, sans deuxième réponse IA |
| Identités | UUID de profil; rattachement serveur au ped réseau; biographies et voix conservées | Un network ID réutilisé ne constitue pas une identité durable; rattacher explicitement les récurrents |
| Persistance | `profiles.json` et `memory.json`, lecture complète et réécriture synchrone du fichier à chaque mutation | Passer à une base transactionnelle; préserver les originaux et importer de façon idempotente |
| Mémoire | Isolation par joueur et PNJ; 100 entrées récentes, 30 envoyées au modèle | Ajouter provenance, relations structurées et consolidation; ne pas partager les conversations privées |
| Perception | Peur, arme pointée, agression et combat via observations client bornées; `RecordEvent` serveur avec témoins nommés | Le client peut mentir; garder sanctions et récompenses sur des preuves serveur |
| Actions | Reddition, suivi, fuite, véhicule et conduite; retour asynchrone des natives avant résultat IA | Conserver les refus, délais, annulations et l'exclusivité; vérifier davantage côté serveur lorsque c'est possible |
| Métiers | Mécanicien gratuit, chauffeur avec destinations configurées, registre extensible | Ajouter devis payants, réservations/remboursements, vente réelle et contrôles police; documenter les adaptateurs absents |
| Ville et missions | Aucun moteur de routines, relations évolutives ou missions persistantes | Ajouter simulation détaillée à proximité, évolution logique ailleurs et objectifs contrôlés par le moteur |
| Déploiement | Ressource autonome Node 22 / Lua / NUI; `ws` requis, Fengari pour tests | Pas d'ESX/QB obligatoire; vérifier la disponibilité réelle de SQLite dans le runtime FXServer |

Les tests initiaux couvrent notamment la stabilité des voix, l'atténuation sans nouvelle connexion, la touche maintenue, les erreurs de microphone, l'exclusivité du PNJ, les distances/buckets, le refus de passagers occupés, les interventions et les réactions. Ils ne mesurent ni circulation GTA, ni latence OpenAI réelle, ni fonctionnement WebAudio dans Chromium FiveM.

Les principaux risques à traiter sont une validation client présentée à tort comme preuve serveur, les doubles paiements au redémarrage, l'usurpation de témoins, la divulgation de mémoire privée, les profils recréés à partir d'IDs d'entités périmés et la montée en charge des écritures synchrones. Le guide de validation et la matrice de statut indiquent les preuves effectivement obtenues après modification.
