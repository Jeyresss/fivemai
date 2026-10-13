const {modelHash}=require('./core');
const DEFAULT_ARCHETYPES=[
 {id:'gang',label:'Membre de gang',models:['g_m_y_ballaeast_01','g_m_y_ballaorig_01','g_m_y_ballasout_01','g_f_y_ballas_01','g_m_y_famca_01','g_m_y_famdnf_01','g_m_y_famfor_01','g_f_y_families_01','g_m_y_mexgoon_01','g_m_y_mexgoon_02','g_m_y_mexgoon_03','g_f_y_vagos_01','g_m_y_lost_01','g_m_y_lost_02','g_m_y_lost_03'],register:'Langage de rue, argot français naturel, direct et territorial. Méfiance envers les inconnus; jurons possibles en conflit. Pas de caricature ni de lien avec une origine ethnique.',temperament:'defiant',surrenderThreshold:0.85},
 {id:'police',label:'Police',models:['s_m_y_cop_01','s_f_y_cop_01','s_m_y_sheriff_01','s_f_y_sheriff_01','s_m_y_hwaycop_01'],register:'Précis, ferme, professionnel. Ton autoritaire en cas de menace, vocabulaire policier sans inventer des pouvoirs ou des actions non disponibles.',temperament:'resolute',surrenderThreshold:0.95},
 {id:'mechanic',label:'Personnel de garage',models:['s_m_y_xmech_01','s_m_y_xmech_02','s_m_m_autoshop_01','s_m_m_autoshop_02'],register:'Franc, pratique et familier. Vocabulaire de mécanique, explications concrètes et humour discret.',temperament:'prudent',surrenderThreshold:0.25},
 {id:'business',label:'Employé de bureau',models:['a_f_y_business_01','a_f_y_business_02','a_f_y_business_03','a_f_y_business_04','a_m_y_business_01','a_m_y_business_02','a_m_y_business_03','a_m_y_business_04'],register:'Poli et soigné, préoccupations professionnelles; phrases claires. La peur peut casser cette assurance.',temperament:'prudent',surrenderThreshold:0.2},
 {id:'driver',label:'Chauffeur',models:['s_m_m_gentransport','s_m_m_trucker_01'],register:'Pratique, cordial, vocabulaire de conduite et connaissance des destinations autorisées.',temperament:'prudent',surrenderThreshold:0.3},
 {id:'resident',label:'Passant',models:[],register:'Français courant, spontané, selon ta personnalité et tes souvenirs.',temperament:'prudent',surrenderThreshold:0.3}
];
const VOICES={male:['cedar','ash','echo'],female:['marin','coral','shimmer'],unknown:['marin','cedar']};
const COMMON_MODELS=['a_f_m_beach_01','a_f_y_beach_01','a_f_y_beach_02','a_f_m_fatwhite_01','a_f_m_fatbla_01','a_f_m_skidrow_01','a_f_m_soucent_01','a_f_m_soucent_02','a_f_y_hipster_01','a_f_y_hipster_02','a_f_y_hipster_03','a_f_y_hipster_04','a_f_y_tourist_01','a_f_y_tourist_02','a_f_y_vinewood_01','a_f_y_vinewood_02','a_f_y_vinewood_03','a_f_y_vinewood_04','a_f_y_hiker_01','a_f_y_runner_01','a_f_y_scdressy_01','a_f_y_yoga_01','a_f_y_soucent_01','a_f_y_soucent_02','a_f_y_soucent_03','a_m_y_hipster_01','a_m_y_hipster_02','a_m_y_hipster_03','a_m_y_beach_01','a_m_y_beach_02','a_m_y_beach_03','a_m_y_runner_01','a_m_y_runner_02','a_m_y_hiker_01','a_m_m_farmer_01','s_f_y_scrubs_01','s_f_y_shop_mid','s_f_y_shop_low','s_f_m_shop_high','s_m_y_garbage','s_m_m_postal_01','s_m_m_postal_02'];
const KNOWN_SEX=new Map([...DEFAULT_ARCHETYPES.flatMap(archetype=>archetype.models),...COMMON_MODELS].map(name=>[modelHash(name),/^(?:a|s|g|mp)_f_/.test(name)?'female':'male']));
function sexForModel(model,hint='unknown',overrides={}){
 const hash=typeof model==='string'?modelHash(model):model>>>0;
 const override=overrides?.[String(model)]??overrides?.[String(hash)]??overrides?.[String(hash|0)]??Object.entries(overrides||{}).find(([key])=>!/^[-+]?\d+$/.test(key)&&modelHash(key)===hash)?.[1];
 if(['male','female','unknown'].includes(override))return override;
 // Sex is an appearance hint only; it never authorizes a gameplay action.
 if(typeof model==='string'){
  if(/^(?:a|s|g|mp)_f_/.test(model))return 'female';
  if(/^(?:a|s|g|mp)_m_/.test(model))return 'male';
 }
 if(KNOWN_SEX.has(hash))return KNOWN_SEX.get(hash);
 return ['male','female'].includes(hint)?hint:'unknown';
}
function archetypeFor(model,definitions=DEFAULT_ARCHETYPES){
 const hash=typeof model==='string'?modelHash(model):model>>>0;
 return definitions.find(a=>a.models?.some(name=>modelHash(name)===hash))||definitions.find(a=>a.id==='resident')||DEFAULT_ARCHETYPES.at(-1);
}
function appearance(model,sex,definitions=DEFAULT_ARCHETYPES,voices=VOICES,sexOverrides={}){
 const archetype=archetypeFor(model,definitions),inferred=sexForModel(model,sex,sexOverrides);
 return {sex:inferred,archetypeId:archetype.id,language:archetype.register,temperament:archetype.temperament,surrenderThreshold:archetype.surrenderThreshold??0.3,voiceChoices:Array.isArray(voices?.[inferred])&&voices[inferred].length?voices[inferred]:VOICES[inferred]};
}
function enrichFixed(npc,config,hint){
 const traits=appearance(npc.model,['male','female'].includes(npc.sex)?npc.sex:hint,config.archetypes,config.voices,config.sexOverrides);
 const {voiceChoices,...fields}=traits;
 return {...fields,...npc,sex:traits.sex,voice:npc.voice||voiceChoices[0]};
}
module.exports={DEFAULT_ARCHETYPES,VOICES,sexForModel,archetypeFor,appearance,enrichFixed};
