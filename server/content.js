// Gameplay content is data. Rewards, prerequisites and objectives are never
// supplied or edited by the language model.
const POINTS={
 garage:{x:-341.7,y:-133.5,z:39},press:{x:-537.5,y:-213,z:37.65},
 taxi:{x:903.4,y:-173.8,z:74.1},shop:{x:25.7,y:-1346.8,z:29.5},
 police:{x:425.1,y:-979.5,z:30.7},hospital:{x:299.6,y:-584,z:43.3},
 depot:{x:1200.4,y:-1276.4,z:35.2},square:{x:215.8,y:-920.1,z:30.7},
 port:{x:817.3,y:-2982.6,z:6.0},alley:{x:461.2,y:-1006.4,z:28.4}
};
function routine(work,home,scenario){return [
 {id:'night',start:0,end:420,destination:home,scenario:'WORLD_HUMAN_STAND_MOBILE'},
 {id:'work',start:420,end:1080,destination:work,scenario},
 {id:'evening',start:1080,end:1440,destination:home,scenario:'WORLD_HUMAN_STAND_MOBILE'}
];}
const DEFAULT_CHARACTERS=[
 {id:'marcel_dubois',firstName:'Marcel',lastName:'Dubois',sex:'male',jobId:'mechanic',job:'Mécanicien',voice:'cedar',model:'s_m_y_xmech_01',coords:{...POINTS.garage,heading:70},story:'Ancien garagiste lyonnais, il a reconstruit son atelier après un incendie. Sa nièce Léa et son garage passent avant le reste.',personality:'Franc, patient, méfiant envers les voleurs, humour discret.',routine:routine(POINTS.garage,{x:-366.7,y:-110,z:38.7},'WORLD_HUMAN_VEHICLE_MECHANIC')},
 {id:'lea_moreau',firstName:'Léa',lastName:'Moreau',sex:'female',jobId:'journalist',job:'Journaliste locale',voice:'marin',model:'a_f_y_business_02',coords:{...POINTS.press,heading:200},story:'Journaliste marseillaise installée à Los Santos. Elle enquête sur la disparition de son frère et refuse toute accusation sans preuve.',personality:'Curieuse, empathique, tenace, inquiète face aux menaces.',routine:routine(POINTS.press,{x:-528.1,y:-223.2,z:37.65},'WORLD_HUMAN_CLIPBOARD')},
 {id:'sami_benali',firstName:'Sami',lastName:'Benali',sex:'male',jobId:'driver',job:'Chauffeur de taxi',voice:'ash',model:'s_m_m_gentransport',coords:{...POINTS.taxi,heading:180},serviceVehicle:{model:'taxi',coords:{x:899.3,y:-179.2,z:73.8,heading:230}},story:'Ancien livreur devenu taxi. Il aide sa sœur à payer ses études et connaît les grands axes de la ville.',personality:'Sociable, pratique, calme au volant, tient ses engagements.',routine:routine(POINTS.taxi,{x:893.1,y:-170.4,z:74.7},'WORLD_HUMAN_STAND_MOBILE')},
 {id:'nora_mercier',firstName:'Nora',lastName:'Mercier',sex:'female',jobId:'shopkeeper',job:'Épicière',voice:'coral',model:'mp_f_shopkeep_01',coords:{...POINTS.shop,heading:90},story:'Elle a repris l’épicerie familiale et livre les habitants qui ne peuvent plus se déplacer. Elle préfère les petites preuves aux grandes promesses.',personality:'Directe, attentive, organisée, protectrice de ses clients.',routine:routine(POINTS.shop,{x:30.4,y:-1339.5,z:29.5},'WORLD_HUMAN_STAND_IMPATIENT')},
 {id:'alice_renard',firstName:'Alice',lastName:'Renard',sex:'female',jobId:'police',job:'Officière de police',archetypeId:'police',voice:'shimmer',model:'s_f_y_cop_01',coords:{...POINTS.police,heading:90},story:'Officière de quartier, elle privilégie les témoins et les constats. Elle n’autorise ni arrestation citoyenne ni accusation sans preuve.',personality:'Ferme, précise, professionnelle, attentive aux habitants.',routine:routine(POINTS.police,{x:441.4,y:-982.9,z:30.7},'WORLD_HUMAN_CLIPBOARD')}
];
const near=(point,extra={})=>({type:'visit',destination:point,radius:6,dwellSeconds:3,...extra});
const back=npcId=>({type:'visit',npcId,radius:6,dwellSeconds:2,label:'Retourner voir le donneur de mission'});
const parcel=(item,pickup,dropoff)=>[
 {type:'pickup',destination:pickup,radius:6,dwellSeconds:3,items:{[item]:1},label:'Récupérer le colis scellé'},
 {type:'delivery',destination:dropoff,radius:6,dwellSeconds:3,items:{[item]:1},label:'Livrer le colis scellé'}
];
const DEFAULT_MISSIONS=[
 {id:'marcel_parts',npcId:'marcel_dubois',title:'Les pièces du garage',description:'Récupérez les pièces au dépôt puis rapportez-les au garage.',prerequisites:{trust:0,reputation:0},reward:{money:180},social:{trust:2,reputation:1},deadlineSeconds:1200,stages:[...parcel('mission_parts',POINTS.depot,POINTS.garage),back('marcel_dubois')]},
 {id:'marcel_repair',npcId:'marcel_dubois',title:'Remise en état contrôlée',description:'Amenez un véhicule endommagé au garage et faites réellement effectuer sa réparation par Marcel. Le service reste facturé selon son devis.',prerequisites:{trust:2,reputation:0},reward:{money:90},social:{trust:1,reputation:1},deadlineSeconds:900,stages:[{type:'select_vehicle',destination:POINTS.garage,radius:10,maxEngineHealth:800,label:'Présenter un véhicule endommagé au garage'},{type:'repair',npcId:'marcel_dubois',minEngineHealth:900,label:'Faire réparer le véhicule sélectionné par Marcel'},back('marcel_dubois')]},
 {id:'lea_investigation',npcId:'lea_moreau',title:'La tournée des lieux',description:'Repérez trois lieux publics pour Léa. Votre présence est vérifiée; il ne s’agit pas de preuves d’un crime.',prerequisites:{trust:0,reputation:0},reward:{money:150},social:{trust:2,reputation:1},deadlineSeconds:1500,stages:[near(POINTS.square,{label:'Observer la place publique',dwellSeconds:8}),near(POINTS.port,{label:'Observer l’entrée du port',dwellSeconds:8}),near(POINTS.police,{label:'Observer l’accueil du commissariat',dwellSeconds:8}),back('lea_moreau')]},
 {id:'lea_escort',npcId:'lea_moreau',title:'Rendez-vous à pied',description:'Accompagnez Léa jusqu’à la place. Elle doit arriver vivante auprès de vous; aucune menace ou protection armée n’est simulée par cette mission.',prerequisites:{trust:2,reputation:0},reward:{money:140},social:{trust:2,reputation:1},deadlineSeconds:900,stages:[{type:'escort',npcId:'lea_moreau',destination:POINTS.square,radius:8,maxSeparation:25,dwellSeconds:3,label:'Accompagner Léa à pied jusqu’à la place'}]},
 {id:'sami_transport',npcId:'sami_benali',title:'Un passager pour Pillbox',description:'Conduisez un véhicule de votre choix jusqu’à Pillbox avec Sami réellement assis comme passager. Prenez un siège conducteur libre puis laissez-le monter.',prerequisites:{trust:0,reputation:0},reward:{money:220},social:{trust:2,reputation:1},deadlineSeconds:900,stages:[{type:'transport',npcId:'sami_benali',destination:POINTS.hospital,radius:12,dwellSeconds:3,label:'Conduire Sami jusqu’à Pillbox avec lui dans votre véhicule'}]},
 {id:'nora_delivery',npcId:'nora_mercier',title:'Le panier de l’hôpital',description:'Prenez le panier à l’épicerie et livrez-le à l’accueil de Pillbox, puis revenez prévenir Nora.',prerequisites:{trust:0,reputation:0},reward:{money:120},social:{trust:2,reputation:1},deadlineSeconds:900,stages:[...parcel('mission_groceries',POINTS.shop,POINTS.hospital),back('nora_mercier')]},
 {id:'alice_search',npcId:'alice_renard',title:'Reconnaissance du quartier',description:'Parcourez les trois points publics indiqués et revenez. Cette tournée confirme une présence, pas une arrestation ni la découverte d’un suspect.',prerequisites:{trust:0,reputation:0},reward:{money:160},social:{trust:1,reputation:2},deadlineSeconds:900,stages:[near(POINTS.alley,{label:'Reconnaître la ruelle',dwellSeconds:10}),near(POINTS.square,{label:'Reconnaître la place',dwellSeconds:10}),near(POINTS.hospital,{label:'Reconnaître l’accès de l’hôpital',dwellSeconds:10}),back('alice_renard')]}
];
module.exports={POINTS,DEFAULT_CHARACTERS,DEFAULT_MISSIONS};
