# Preuves disponibles et recette sur FXServer

Les tests automatisés exécutent les vrais moteurs JavaScript, SQLite local et le Lua client avec des natives simulées. Le fournisseur Realtime et le navigateur sont simulés lorsque nécessaire. Aucun FXServer ni client GTA n'est disponible dans cet environnement et aucune clé OpenAI de production n'a été utilisée. Les nouveaux comportements ne sont donc pas déclarés validés en jeu.

## Contrôles reproductibles

```bash
npm ci --ignore-scripts
npm test
npm run check
node scripts/benchmark.js --players 128 --active-peds 200 --profiles 5000 --ticks 100
```

`check` parcourt les fichiers JavaScript serveur, web, tests et scripts; analyse le Lua avec Fengari lorsque les dépendances de développement sont présentes; parse la configuration JSON. Une analyse syntaxique n'exécute pas les natives et ne prouve pas la compatibilité du runtime FXServer.

Le benchmark fait travailler les vrais moteurs et la base sur des instantanés synthétiques. Il mesure temps CPU et durée murale, lectures de profil, écritures/lectures de mémoire, perception, ticks de simulation, sauvegarde, taille de base, mémoire RSS et retard maximal de boucle d'événements. Le résultat JSON est enregistré dans `work/benchmark.json`, ou dans le chemin donné par `--output`. Il ne mesure ni le streaming OneSync, ni le trafic relayé, ni le coût OpenAI, ni les FPS de GTA. Les 128 joueurs / 200 peds actifs / 5 000 profils sont un objectif de charge à tester, pas une capacité FXServer acquise. Les quotas CPU de l'hôte peuvent être inconnus.

Une exécution du 13 octobre 2026 est conservée dans [`benchmarks/node-sqlite-2026-10-13.json`](benchmarks/node-sqlite-2026-10-13.json). Node `v24.19.0`, Linux x64, CPU hôte annoncé Xeon Platinum 8573C, trois processeurs logiques visibles, quotas inconnus. Le jeu de données contient 5 000 profils et le moteur traite 200 personnages en mode détaillé sur 100 ticks avec 128 instantanés joueurs. Le benchmark augmente explicitement les budgets de détails/dispatch pour ce scénario; ce ne sont pas les limites de production par défaut.

| Mesure locale | Résultat |
| --- | --- |
| Tick de simulation, moyenne / p95 / maximum | 9,555 / 23,349 / 85,422 ms |
| Lecture de profil, p95 | 0,0129 ms sur 1 280 lectures |
| Écriture de mémoire, p95 | 0,1069 ms sur 384 écritures |
| Lecture de mémoire, p95 | 0,0086 ms sur 1 280 lectures |
| Observation de perception, p95 | 0,0033 ms sur 1 280 observations |
| Publication avec mémoire/relation/événement public, p95 | 1,5682 ms sur 128 publications |
| Sauvegarde SQLite | 7,427 ms |
| Base fermée / payload JSON | 5 877 760 / 4 747 278 octets, 6 162 enregistrements |
| Pic RSS observé | 110 215 168 octets (environ 105,1 Mio) |
| Durée totale / CPU cumulé | 1 578 / 2 126 ms |
| Retard maximal de boucle observé | 370,672 ms, peuplement synchrone initial compris |

Le dernier chiffre expose un blocage réel du processus Node pendant les travaux synchrones de ce scénario. Le coût du peuplement initial ne doit pas être confondu avec un tick courant. Les phases peuvent varier avec la contention CPU, le disque, le runtime et les autres ressources; reproduire sur le serveur ciblé avant de fixer les budgets. Le temps CPU peut dépasser le temps mural à cause des threads internes de Node. La perception valide des instantanés synthétiques d'identité, position et bucket; elle ne mesure pas une ligne de vue GTA ni un anticheat.

## Avant la recette

Utiliser un serveur de préproduction avec OneSync, SQLite réellement chargé, deux clients, une clé privée autorisée et des plafonds vocaux réduits. Sauvegarder les données et noter commit, build FXServer, carte, nombre de joueurs et ressources modifiant les peds/véhicules. Prévoir un véhicule endommagé et garé, un véhicule à plusieurs places, et les personnages récurrents. Relever la console serveur et F8 en évitant toute clé.

Pour chaque scénario, consigner le résultat physique, le résultat vocal, l'état SQLite, le solde et les objets avant/après. Une phrase du PNJ ou un marqueur de mission ne remplace pas la preuve de l'objectif. Le test est échoué si un refus paie, récompense, valide ou annonce une réussite.

| Scénario | Réussite à constater | Refus, interruption et récupération |
| --- | --- | --- |
| N et microphone | Micro actif uniquement pendant N, réponse après relâchement, interruption nette en reprenant N, diagnostic/changement de périphérique | Appui avant NUI prête, micro débranché, autorisation refusée, connexion échouée, relâchement avant connexion, reconnexion |
| Distance vocale | Pendant une longue réponse : s'éloigner au-delà de 18 m puis revenir; entendre la suite, sans rejouer l'audio manqué | Sortir de la portée d'interaction coupe le micro; sortir/revenir en bucket différent ne laisse pas de son résiduel |
| Voix partagée | Deux clients entendent une seule réponse du même PNJ, volumes adaptés à leurs positions réelles | Second interlocuteur refusé, pas de micro témoin, interruption de l'interlocuteur vide la file témoin, changement de propriétaire/bucket et déconnexion nettoyés |
| Identité et mémoire | Deux passants différents; même ped retrouvé puis reconnu après reconnexion; récurrent recréé avec même profil; données relues après restart | Network ID réutilisé, ped joueur/animal, état client falsifié, import JSON corrompu, limite de profils, aucune fuite de mémoire d'un autre joueur |
| Perception et rumeurs | Un témoin valide conserve une observation et sa source; une rencontre autorisée transmet une rumeur explicitement incertaine | Témoin distant/autre bucket exclu; accusation vocale non sanctionnante; client forgeant un événement ou une relation refusé; conversation privée non diffusée |
| Peur, combat et priorités | PNJ calme regarde le joueur; fuite causée par le joueur reconnue; fuite par un tiers non attribuée; combat et travail continuent selon priorité | Menace/blessure annule le service prévu; conversation ne bloque pas la conduite ou l'escorte; baisse de l'arme ne garde pas les mains indéfiniment |
| Reddition et mouvements | Mains réellement levées, attente, suivi, fuite, montée/descente et déplacement constatés | Personnage résistant/armé, siège occupé, contrôle réseau refusé, trajet bloqué, cible supprimée, animation interrompue : cause d'échec précise, aucune téléportation silencieuse |
| Mécanicien | À pied près d'un véhicule garé : plaque si choix ambigu, devis réel accepté, marche au capot, animation, état/réparation/couleur/amélioration vérifiés puis paiement unique | Accord refusé, fonds insuffisants, voiture déplacée ou remplacée, contrôle perdu, départ/bucket/restart pendant travail : aucun prélèvement définitif avant confirmation, réservations remboursées |
| Taxi | Destination résolue par ID/libellé/alias, devis accepté, prise en charge, passager présent, conduite réelle jusqu'à la destination puis paiement | Adresse ambiguë/inconnue, conducteur/siège occupé, absence de passager, abandon ou véhicule bloqué : pas de réussite annoncée, séquestre récupéré |
| Vendeur et objets | Catalogue/stock/prix réels; achat retire monnaie et stock et ajoute objets une fois; effet consommable réellement appliqué | Quantité invalide, rupture, solde insuffisant, répétition d'un jeton, effet refusé/interrompu/restart : pas de duplication, restitution conforme |
| Police | Incident réellement validé; motif correct, poursuite et ordres pendant l'action, reddition/contrôle selon règles, sanction reliée à l'incident | Accusation inventée, infraction sans témoin autorisé, autre bucket, cible disparaissant, refus/résistance, reprise; aucun export client capable d'amender; adaptateur absent explique sa limite |
| Ville autonome | Sans conversation, récurrents suivent leurs routines proches; événements/relations restent après restart; loin des joueurs évolution simplifiée sans appel IA | PNJ occupé non détourné, tâches bloquées déclarées, disparition/recréation liée au profil; limites de peds/ticks respectées, aucun spawn illimité |
| Missions | Offre accessible selon règles; chaque étape réelle, retour au donneur, récompense unique, relation changée; livraison consomme le colis; escorte/transfert vérifie le ped | Accès refusé, étape déclarée seulement par le modèle, abandon, décès, délai expiré, véhicule différent, déconnexion/restart; reprise de l'étape et des colis sans double récompense |
| Charge et budget | Monter progressivement vers 128 clients et 200 peds actifs; mesurer resmon/CPU/latence, flux et base; baisse du budget refuse de nouvelles voix | Huit sessions ou plafond configuré atteint, répétitions d'ouvertures, charge d'audio falsifiée, coupure OpenAI, saturation du stockage : refus explicite et état cohérent |

Pour la recette des sept missions, parcourir chaque objectif et sa variante d'abandon : pièces du garage, réparation contrôlée, tournée de Léa, escorte de Léa, transport de Sami, panier de Nora et reconnaissance d'Alice. La tournée/reconnaissance ne doit jamais être annoncée comme découverte d'une preuve ou capture d'un suspect.

## État de validation à compléter

La matrice `STATUS.md` décrit ce qui est livré et les limites connues. Pour chaque serveur validé, enregistrer ici la date, le commit, le build, le nombre de clients, les scénarios passés et les échecs restants. Tant qu'aucune entrée FXServer n'existe, toute compatibilité de natives, synchronisation vocale, conduite ou arrestation reste à confirmer en jeu.
