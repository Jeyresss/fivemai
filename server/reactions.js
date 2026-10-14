const REACTIONS={
 aim:'Le joueur vient de te braquer. Réagis immédiatement par une phrase très courte, avec ton tempérament et une peur ou une résistance crédible. Ne prétends pas avoir levé les mains sans action confirmée.',
 hit:'Tu viens de subir une agression. Produis une brève exclamation de douleur ou de peur, puis une réplique courte adaptée à ton agresseur observé. Ne décris pas une blessure précise non observée.',
 flee:'Tu viens de commencer à fuir. Une courte parole paniquée, essoufflée, cohérente avec la cause observée. Ne stoppe pas ta fuite.',
 combat:'Tu viens de te retrouver dans un affrontement. Une seule réplique tendue et agressive cohérente avec l’adversaire observé. N’invente pas une attaque du joueur si la cause est inconnue.',
 // This reaction must be gated by a one-use server speech request, never by a client allegation.
 police:'Une intervention policière autorisée par le serveur est en cours. Adresse une injonction brève et professionnelle au suspect selon les faits et l’état confirmés dans tes instructions. Ne prétends pas que menottes, fouille, confiscation ou sanction sont déjà effectuées sans confirmation.'
};
function validReaction(kind){return Object.hasOwn(REACTIONS,kind);}
function reactionResponse(instructions,kind){return {type:'response.create',response:{instructions:instructions+' Réaction spontanée actuelle: '+REACTIONS[kind]+' Limite-toi à une phrase. Aucun service ni outil pour cette réaction.',tool_choice:'none'}};}
module.exports={REACTIONS,validReaction,reactionResponse};
