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
function sexForModel(model,hint='unknown'){
 // Sex is an appearance hint only; it never authorizes a gameplay action.
 if(typeof model==='string'){
  if(/^(?:a|s|g|mp)_f_/.test(model))return 'female';
  if(/^(?:a|s|g|mp)_m_/.test(model))return 'male';
 }
 return ['male','female'].includes(hint)?hint:'unknown';
}
function archetypeFor(model,definitions=DEFAULT_ARCHETYPES){
 const hash=typeof model==='string'?modelHash(model):model>>>0;
 return definitions.find(a=>a.models?.some(name=>modelHash(name)===hash))||definitions.find(a=>a.id==='resident')||DEFAULT_ARCHETYPES.at(-1);
}
function appearance(model,sex,definitions=DEFAULT_ARCHETYPES,voices=VOICES){
 const archetype=archetypeFor(model,definitions),inferred=sexForModel(model,sex);
 return {sex:inferred,archetypeId:archetype.id,language:archetype.register,temperament:archetype.temperament,surrenderThreshold:archetype.surrenderThreshold??0.3,voiceChoices:voices[inferred]||VOICES[inferred]};
}
function enrichFixed(npc,config,hint){
 const traits=appearance(npc.model,['male','female'].includes(npc.sex)?npc.sex:hint,config.archetypes,config.voices);
 const {voiceChoices,...fields}=traits;
 return {...fields,...npc,sex:traits.sex,voice:npc.voice||voiceChoices[0]};
}
module.exports={DEFAULT_ARCHETYPES,VOICES,sexForModel,archetypeFor,appearance,enrichFixed};
