-- Keep behavior helpers local to the entry script; do not depend on another script loading first.
local FivemAIBehavior = {held={}, controlAttempts={}, threats={}, surrendered={}, incidents={}}
local function flag(name, ...)
    local fn = _G[name]
    if type(fn) ~= 'function' then return false end
    local value = fn(...)
    return value == true or value == 1
end
local function getter(name, ...)
    local fn = _G[name]
    if type(fn) == 'function' then return fn(...) end
end
local function playerIndex()
    return type(PlayerId) == 'function' and PlayerId() or -1
end
local function recentThreat(ped, player)
    local threat = FivemAIBehavior.threats[ped]
    if not threat then return nil end
    if not DoesEntityExist(ped) or getter('GetEntityModel', ped) ~= threat.model then FivemAIBehavior.threats[ped] = nil return nil end
    if GetGameTimer() - threat.at > 20000 then FivemAIBehavior.threats[ped] = nil return nil end
    return threat.player == player and threat or nil
end
local function rememberThreat(ped, player, cause)
    local previous = recentThreat(ped, player)
    if previous and previous.cause == 'hit' and cause ~= 'hit' then previous.at = GetGameTimer() return end
    FivemAIBehavior.threats[ped] = {player=player, cause=cause, at=GetGameTimer(), model=getter('GetEntityModel', ped)}
end
function FivemAIBehavior.recordAttack(victim, attacker)
    if not victim or victim == 0 or not DoesEntityExist(victim) or flag('IsPedAPlayer', victim) then return end
    if type(IsEntityAPed) == 'function' and not IsEntityAPed(victim) then return end
    if type(attacker) ~= 'number' or attacker <= 0 then return end
    if flag('IsEntityAVehicle', attacker) then attacker = getter('GetPedInVehicleSeat', attacker, -1) end
    if type(attacker) == 'number' and attacker > 0 and DoesEntityExist(attacker) then rememberThreat(victim, attacker, 'hit') FivemAIBehavior.incidents[victim]={at=GetGameTimer(),model=getter('GetEntityModel',victim)} end
end
AddEventHandler('gameEventTriggered', function(name, args)
    if name == 'CEventNetworkEntityDamage' and type(args) == 'table' then FivemAIBehavior.recordAttack(args[1], args[2]) end
end)
function FivemAIBehavior.observe(ped, player)
    local a, b = GetEntityCoords(ped), GetEntityCoords(player)
    local dx, dy, dz = a.x-b.x, a.y-b.y, a.z-b.z
    local nearby = dx*dx + dy*dy + dz*dz <= 30*30
    local targeting = nearby and flag('IsPlayerTargettingEntity', playerIndex(), ped)
    local armedAim = nearby and (flag('IsPlayerFreeAimingAtEntity', playerIndex(), ped) or targeting) and flag('IsPedArmed', player, 6)
    local meleeTarget = getter('GetMeleeTargetForPed', player)
    local weapon = getter('GetSelectedPedWeapon', player)
    local unarmed = type(weapon) == 'number' and weapon % 4294967296 == joaat('WEAPON_UNARMED') % 4294967296
    local meleePreparation = nearby and targeting and (flag('IsPedArmed', player, 1) or unarmed)
    local playerFighting = flag('IsPedInCombat', player, ped) or (flag('IsPedInMeleeCombat', player) and meleeTarget == ped)
    if armedAim then rememberThreat(ped, player, 'aim') end
    if meleePreparation or playerFighting then rememberThreat(ped, player, 'melee') end
    local threat = recentThreat(ped, player)
    if FivemAIBehavior.surrendered[ped] then return 'surrendered', threat and threat.cause or 'none' end
    if flag('IsPedFleeing', ped) then
        if threat then threat.at = GetGameTimer() return 'afraid_player', threat.cause end
        return 'afraid', 'none'
    end
    if flag('IsPedInCombat', ped, player) or playerFighting then return 'angry', threat and threat.cause or 'combat' end
    if meleePreparation then return 'angry', 'melee' end
    if flag('IsPedInCombat', ped, 0) or flag('IsPedInMeleeCombat', ped) then return 'combat', 'none' end
    if armedAim then return 'threatened', threat and threat.cause or 'aim' end
    if flag('IsPedRagdoll', ped) or flag('IsPedBeingStunned', ped, 0) then return threat and 'afraid_player' or 'afraid', threat and threat.cause or 'none' end
    if threat then return 'threatened', threat.cause end
    return 'calm', 'none'
end
function FivemAIBehavior.scan(player)
    -- Remember a targeted threat even before the player opens a conversation.
    for _, name in ipairs({'GetEntityPlayerIsFreeAimingAt', 'GetPlayerTargetEntity'}) do
        local fn = _G[name]
        if type(fn) == 'function' then
            local ok, targeted, entity = pcall(fn, playerIndex())
            if ok and targeted and type(entity) == 'number' and entity ~= 0 and DoesEntityExist(entity) and flag('IsPedHuman', entity) then FivemAIBehavior.observe(entity, player) end
        end
    end
    local melee = getter('GetMeleeTargetForPed', player)
    if type(melee) == 'number' and melee ~= 0 and DoesEntityExist(melee) and flag('IsPedInMeleeCombat', player) then FivemAIBehavior.observe(melee, player) end
    for ped, threat in pairs(FivemAIBehavior.threats) do
        if not DoesEntityExist(ped) or getter('GetEntityModel', ped) ~= threat.model then FivemAIBehavior.threats[ped] = nil
        elseif GetGameTimer() - threat.at > 20000 then FivemAIBehavior.threats[ped] = nil
        elseif flag('IsPedFleeing', ped) then threat.at = GetGameTimer() end
    end
end
function FivemAIBehavior.release(ped, resume, fixed)
    if not ped then return end
    local held = FivemAIBehavior.held[ped]
    FivemAIBehavior.held[ped] = nil
    FivemAIBehavior.controlAttempts[ped] = nil
    if not held or not DoesEntityExist(ped) then return end
    if type(TaskClearLookAt) == 'function' then TaskClearLookAt(ped) end
    -- Never replace the primary task of a fleeing or fighting actor.
    if not resume or FivemAIBehavior.observe(ped, PlayerPedId()) ~= 'calm' then return end
    if NetworkGetEntityIsNetworked(ped) and not flag('NetworkHasControlOfEntity', ped) then return end
    if fixed then
        if type(TaskStandStill) == 'function' then TaskStandStill(ped, -1) end
    elseif type(TaskWanderStandard) == 'function' then TaskWanderStandard(ped, 10.0, 10) end
end
function FivemAIBehavior.pose(ped, player, close, fixed, working)
    local state, cause = FivemAIBehavior.observe(ped, player)
    local inVehicle = flag('IsPedInAnyVehicle',ped,false)
    if state ~= 'calm' or not close or working or inVehicle then
        FivemAIBehavior.release(ped, not working and not inVehicle and state == 'calm', fixed)
        return state, cause
    end
    if NetworkGetEntityIsNetworked(ped) and not flag('NetworkHasControlOfEntity', ped) then
        local now = GetGameTimer()
        if now - (FivemAIBehavior.controlAttempts[ped] or -1000) >= 500 then
            FivemAIBehavior.controlAttempts[ped] = now
            if type(NetworkRequestControlOfEntity) == 'function' then NetworkRequestControlOfEntity(ped) end
        end
        return state, cause
    end
    local now = GetGameTimer()
    local held = FivemAIBehavior.held[ped]
    if not held then
        FivemAIBehavior.held[ped] = {last=now}
        if fixed then FreezeEntityPosition(ped, false) end
        SetBlockingOfNonTemporaryEvents(ped, false)
        if type(TaskTurnPedToFaceEntity) == 'function' then TaskTurnPedToFaceEntity(ped, player, 700) end
        if type(TaskLookAtEntity) == 'function' then TaskLookAtEntity(ped, player, 1500, 2048, 3) end
    elseif now - held.last >= 900 then
        held.last = now
        if type(TaskStandStill) == 'function' then TaskStandStill(ped, 1400) end
        if type(TaskLookAtEntity) == 'function' then TaskLookAtEntity(ped, player, 1500, 2048, 3) end
    end
    return state, cause
end

local config = json.decode(LoadResourceFile(GetCurrentResourceName(), 'config.json'))
local peds, demoNetIds = {}, {}
RegisterNetEvent('fivemai:demos',function(ids) demoNetIds=ids or {} end)
local talking = false
local workingJob = nil
local currentAction, finishAction, maintainAction = nil, nil, nil
local currentMood, currentCause, moodChangedAt = 'calm', 'none', 0
CreateThread(function()
    if config.demoNetwork then TriggerServerEvent('fivemai:demoRequest') return end
    for _, npc in ipairs(config.npcs) do
        local model = joaat(npc.model)
        RequestModel(model)
        local deadline = GetGameTimer() + 10000
        while not HasModelLoaded(model) and GetGameTimer() < deadline do Wait(50) end
        if HasModelLoaded(model) then
            local c = npc.coords
            local ped = CreatePed(4, model, c.x, c.y, c.z - 1.0, c.heading, true, true)
            SetEntityInvincible(ped, true)
            FreezeEntityPosition(ped, false)
            SetBlockingOfNonTemporaryEvents(ped, false)
            if type(TaskStandStill) == 'function' then TaskStandStill(ped, -1) end
            peds[npc.id] = ped
            SetModelAsNoLongerNeeded(model)
        end
    end
end)
local currentNpc, currentPed, candidate = nil, nil, nil
local pressed = false
local automatic, pendingReaction, candidateReaction, mutedPed = false, nil, nil, nil
local policeSpeechToken=nil
local nextAutoReaction, lastReaction = 0, 0
local reactionSeen = {}
local requestSerial = 0
local nuiReady, queuedOpen, uiSession = false, nil, 0
local voiceOwnerToken, voiceObservers = nil, {}
-- Other client scripts may inspect priorities without reaching into behavior state.
FivemAIClient = {
    busy=function(ped) return (talking and currentPed==ped) or (currentAction and currentAction.ped==ped) or (workingJob and workingJob.ped==ped) end,
    working=function(ped) return (currentAction and currentAction.ped==ped) or (workingJob and workingJob.ped==ped) end,
    conversation=function() return currentNpc and currentNpc.id, currentPed end
}
local function worldWorking(ped)
    return FivemAIWorld and FivemAIWorld.busy and FivemAIWorld.busy(ped) or false
end
local function cancelRoutine(ped)
    if FivemAIWorld and FivemAIWorld.cancelRoutine then FivemAIWorld.cancelRoutine(ped, 'conversation') end
end
local lastSearch = nil
local function entityDistance(a, b)
    local dx, dy, dz = a.x - b.x, a.y - b.y, a.z - b.z
    return math.sqrt(dx * dx + dy * dy + dz * dz)
end
local function nearestNpc()
    local player = PlayerPedId()
    local pos = GetEntityCoords(player)
    local nearest, best = nil, tonumber(config.interactionDistance) or 3
    local seen = {}
    lastSearch = {count=0, eligible=0, distance=math.huge}
    local function consider(ped, fixedId)
        if not ped or ped == player or seen[ped] or not DoesEntityExist(ped) then return end
        seen[ped] = true
        local coords = GetEntityCoords(ped)
        local d = entityDistance(pos, coords)
        local dead, isPlayer, human = IsEntityDead(ped), IsPedAPlayer(ped), IsPedHuman(ped)
        lastSearch.count = lastSearch.count + 1
        if d < lastSearch.distance then lastSearch.distance, lastSearch.dead, lastSearch.isPlayer, lastSearch.human = d, dead, isPlayer, human end
        if dead or isPlayer or not human then return end
        lastSearch.eligible = lastSearch.eligible + 1
        -- Recover the configured identity of a demo ped discovered through
        -- enumeration, rather than treating it as an unrelated ambient NPC.
        if not fixedId and config.demoNetwork and type(Entity)=='function' then
            local id=Entity(ped).state.fivemai_profile_id
            for _,profile in ipairs(config.npcs or {}) do if profile.id==id then fixedId=id break end end
        end
        if not fixedId and not config.demoNetwork then
            for _, profile in ipairs(config.npcs or {}) do
                if GetEntityModel(ped) == joaat(profile.model) and entityDistance(coords, vector3(profile.coords.x, profile.coords.y, profile.coords.z)) <= 2 then
                    fixedId = profile.id
                    break
                end
            end
        end
        if (fixedId or config.ambientNPCs) and d <= best then nearest, best = {ped=ped, id=fixedId}, d end
    end
    for id, ped in pairs(peds) do consider(ped, id) end
    if nearest then return nearest end
    local ok, pool = pcall(GetGamePool, 'CPed')
    if ok and type(pool) == 'table' then for _, ped in pairs(pool) do consider(ped) end end
    -- Newly streamed peds are not always present in a cached pool snapshot.
    if not nearest and type(FindFirstPed) == 'function' then
        local handle, ped = FindFirstPed()
        if handle and handle ~= -1 then
            local more = true
            repeat
                consider(ped)
                more, ped = FindNextPed(handle)
            until not more
            EndFindPed(handle)
        end
    end
    return nearest
end
local function printSearch()
    if not lastSearch then return end
    local near = lastSearch.distance < math.huge and string.format('%.2f m', lastSearch.distance) or 'aucun'
    print('[fivemai] Recherche PNJ : ' .. lastSearch.count .. ' détectés, ' .. lastSearch.eligible .. ' éligibles; plus proche=' .. near .. ', joueur=' .. tostring(lastSearch.isPlayer) .. ', mort=' .. tostring(lastSearch.dead) .. ', humain=' .. tostring(lastSearch.human))
end
RegisterCommand('pnjdiag', function() nearestNpc() printSearch() end, false)
local function nativeSpeech(ped, enabled)
    if not ped or not DoesEntityExist(ped) then return end
    if type(StopPedSpeaking)=='function' then StopPedSpeaking(ped, not enabled) end
    if type(DisablePedPainAudio)=='function' then DisablePedPainAudio(ped, not enabled) end
    if not enabled then
        if type(StopCurrentPlayingSpeech)=='function' then StopCurrentPlayingSpeech(ped) end
        if type(StopCurrentPlayingAmbientSpeech)=='function' then StopCurrentPlayingAmbientSpeech(ped) end
    end
end
local function restoreObservedPed(ped, exceptToken)
    if not ped or ped==mutedPed then return end
    for token, voice in pairs(voiceObservers) do if token~=exceptToken and voice.ped==ped then return end end
    nativeSpeech(ped,true)
end
local function updateVoiceObservers()
    for token, voice in pairs(voiceObservers) do
        local ped=voice.netId and NetworkDoesEntityExistWithNetworkId(voice.netId) and NetToPed(voice.netId) or nil
        if ped and (not DoesEntityExist(ped) or not IsPedHuman(ped) or IsPedAPlayer(ped)) then ped=nil end
        if voice.ped~=ped then restoreObservedPed(voice.ped,token) voice.ped=ped end
        local coords=ped and GetEntityCoords(ped) or voice.coords
        if coords and tonumber(coords.x) and tonumber(coords.y) and tonumber(coords.z) then
            local d=entityDistance(GetEntityCoords(PlayerPedId()),coords)
            if ped then nativeSpeech(ped,false) end
            SendNUIMessage({type='voiceProximity',token=token,distance=d,fullDistance=voice.fullDistance or config.voiceFullDistance or 3,maxDistance=voice.maxDistance or config.voiceMaxDistance or 18})
        end
    end
end
RegisterNetEvent('fivemai:voiceOwner', function(data)
    local token=type(data)=='table' and data.token or data
    if not currentNpc or type(token)~='string' or #token>100 then return end
    if type(data)=='table' and ((data.sessionId and data.sessionId~=uiSession) or (data.npcId and data.npcId~=currentNpc.id)) then return end
    voiceOwnerToken=token
    SendNUIMessage({type='voiceOwner',token=token,sessionId=uiSession})
end)
RegisterNetEvent('fivemai:voiceListen', function(data)
    if type(data)~='table' or type(data.token)~='string' or #data.token>100 then return end
    local previous=voiceObservers[data.token]
    data.ped=previous and previous.ped or nil
    voiceObservers[data.token]=data
    SendNUIMessage({type='voiceListen',token=data.token,npcId=data.npcId,netId=data.netId,coords=data.coords,fullDistance=data.fullDistance,maxDistance=data.maxDistance,epoch=data.epoch})
    updateVoiceObservers()
end)
RegisterNetEvent('fivemai:voiceAudio', function(data)
    if type(data)=='table' and voiceObservers[data.token] then SendNUIMessage({type='voiceAudio',token=data.token,seq=data.seq,sampleRate=data.sampleRate,audio=data.audio,epoch=data.epoch}) end
end)
RegisterNetEvent('fivemai:voiceClear', function(data)
    if type(data)=='table' and (voiceObservers[data.token] or data.token==voiceOwnerToken) then SendNUIMessage({type='voiceClear',token=data.token,epoch=data.epoch}) end
end)
RegisterNetEvent('fivemai:voiceLeave', function(data)
    if type(data)~='table' then return end
    local voice=voiceObservers[data.token]
    if voice then voiceObservers[data.token]=nil restoreObservedPed(voice.ped,data.token) end
    SendNUIMessage({type='voiceLeave',token=data.token})
end)
local function closeConversation(notifyServer, interruptGameplay)
    local closingSession = uiSession
    if mutedPed then
        local observed=false
        for _, voice in pairs(voiceObservers) do if voice.ped==mutedPed then observed=true break end end
        if not observed then nativeSpeech(mutedPed, true) end
    end
    mutedPed=nil voiceOwnerToken=nil
    automatic, pendingReaction, candidateReaction=false,nil,nil
    policeSpeechToken=nil
    if interruptGameplay and finishAction then finishAction(true, 'interrupted') end
    if currentPed then FivemAIBehavior.release(currentPed, not workingJob and not currentAction and not worldWorking(currentPed), currentNpc and peds[currentNpc.id] == currentPed) end
    uiSession = uiSession + 1
    queuedOpen = nil
    talking, pressed, currentNpc, currentPed, candidate = false, false, nil, nil, nil
    SendNUIMessage({type='closed',sessionId=closingSession})
    if notifyServer ~= false then TriggerServerEvent('fivemai:stop', closingSession) end
end
local function deliverOpen()
    if not nuiReady or not queuedOpen then return end
    SendNUIMessage(queuedOpen)
    SendNUIMessage({type='ptt', held=pressed})
end
local function openConversation(profile, ped)
    cancelRoutine(ped)
    currentNpc, currentPed, candidate = profile, ped, nil
    nativeSpeech(ped,false) mutedPed=ped
    currentMood, currentCause = FivemAIBehavior.pose(ped, PlayerPedId(), true, peds[profile.id] == ped, workingJob ~= nil or currentAction ~= nil or worldWorking(ped))
    moodChangedAt = GetGameTimer()
    uiSession = uiSession + 1
    local session = uiSession
    queuedOpen = {type='open', sessionId=session, microphone=GetResourceKvpString('fivemai_microphone'), npc={id=profile.id, name=profile.firstName .. ' ' .. profile.lastName}}
    deliverOpen()
    SetTimeout(10000, function()
        if uiSession == session and queuedOpen then
            closeConversation()
            print('[fivemai] Interface vocale non chargée. Reconnectez-vous après la mise à jour de la ressource.')
        end
    end)
end
RegisterNUICallback('ready', function(_, cb)
    nuiReady = true
    deliverOpen()
    cb({ok=true})
end)
RegisterNUICallback('opened', function(data, cb)
    if data.sessionId == uiSession and currentNpc then
        queuedOpen = nil
        SendNUIMessage({type='ptt', held=pressed})
    end
    cb({ok=true})
end)
local function requestProfile(nearest)
    if candidate ~= nearest then return end
    nearest.attempt = (nearest.attempt or 0) + 1
    local attempt = nearest.attempt
    TriggerServerEvent('fivemai:resolve', {netId=nearest.netId, requestId=nearest.requestId, sex=type(IsPedMale)=='function' and (flag('IsPedMale', nearest.ped) and 'male' or 'female') or 'unknown'})
    SetTimeout(5000, function()
        if candidate == nearest and nearest.attempt == attempt then
            print('[fivemai] Le serveur ne répond pas à la résolution du profil. Vérifiez les erreurs fivemai dans la console txAdmin et que toute la ressource a été mise à jour.')
            closeConversation()
        end
    end)
end
local function startConversation(nearest, reaction)
    automatic, pendingReaction, candidateReaction = reaction ~= nil, reaction, reaction
    talking, candidate = true, nearest
    -- Fixed profiles already exist in shared config; preserve their original
    -- startup path. The offer is still authorized on the server.
    if nearest.id then
        for _, profile in ipairs(config.npcs) do
            if profile.id == nearest.id then openConversation(profile, nearest.ped) return end
        end
    end
    requestSerial = requestSerial + 1
    nearest.requestId = requestSerial
    CreateThread(function()
        if not NetworkGetEntityIsNetworked(nearest.ped) then NetworkRegisterEntityAsNetworked(nearest.ped) end
        local deadline = GetGameTimer() + 1500
        while DoesEntityExist(nearest.ped) and not NetworkGetEntityIsNetworked(nearest.ped) and GetGameTimer() < deadline do Wait(50) end
        if not DoesEntityExist(nearest.ped) or not NetworkGetEntityIsNetworked(nearest.ped) then
            print('[fivemai] Ce PNJ ne peut pas être synchronisé avec le serveur.')
            closeConversation()
            return
        end
        nearest.netId = NetworkGetNetworkIdFromEntity(nearest.ped)
        requestProfile(nearest)
    end)
end
RegisterCommand('+fivemai_talk', function()
    if pressed then return end
    local nearest = nearestNpc()
    if not nearest then
        printSearch()
        print('[fivemai] Aucun PNJ éligible détecté à portée (' .. tostring(config.interactionDistance) .. ' m).')
        SendNUIMessage({type='notice', message='Approchez-vous d’un PNJ vivant pour lui parler.'})
        return
    end
    if currentNpc and currentPed ~= nearest.ped then closeConversation() end
    pressed = true
    automatic, pendingReaction = false, nil
    if not talking then startConversation(nearest)
    else
        TriggerServerEvent('fivemai:speaking', true)
        if queuedOpen then deliverOpen() else SendNUIMessage({type='ptt', held=true}) end
    end
end, false)
RegisterCommand('-fivemai_talk', function()
    pressed = false
    if currentNpc then TriggerServerEvent('fivemai:speaking', false) end
    SendNUIMessage({type='ptt', held=false})
end, false)
RegisterNetEvent('fivemai:resolved', function(result)
    if not candidate or result.requestId ~= candidate.requestId then return end
    local nearest = candidate
    if result.ok and type(result.profile) == 'table' then
        openConversation(result.profile, nearest.ped)
    elseif result.retryable and nearest.attempt < 3 then
        print('[fivemai] ' .. tostring(result.error) .. '. Nouvelle vérification dans une seconde.')
        SetTimeout(1000, function() requestProfile(nearest) end)
    else
        print('[fivemai] Profil indisponible : ' .. tostring(result.error or 'erreur inconnue'))
        closeConversation()
    end
end)
RegisterNetEvent('fivemai:position', function(coords)
    if currentNpc then currentNpc.coords = coords end
end)
RegisterNetEvent('fivemai:policeSpeech',function(data)
    if type(data)~='table' or type(data.requestToken)~='string' or #data.requestToken>100 or type(data.npcNetId)~='number' then return end
    local ped=NetworkDoesEntityExistWithNetworkId(data.npcNetId) and NetToPed(data.npcNetId) or nil
    if not ped or not DoesEntityExist(ped) or not IsPedHuman(ped) or IsPedAPlayer(ped) or IsEntityDead(ped) then return end
    if entityDistance(GetEntityCoords(PlayerPedId()),GetEntityCoords(ped))>math.min(4,config.interactionDistance or 4) then return end
    if currentNpc and currentNpc.id==data.npcId then return end
    if talking then closeConversation() end
    pressed=false
    policeSpeechToken=data.requestToken
    startConversation({ped=ped,id=data.npcId,netId=data.npcNetId},'police')
end)
RegisterKeyMapping('+fivemai_talk', 'Maintenir pour parler au PNJ (IA)', 'keyboard', 'N')
local function reactionKind(ped, state, cause)
    local incident=FivemAIBehavior.incidents[ped]
    if incident and GetGameTimer()-incident.at<1800 and incident.model==GetEntityModel(ped) then return 'hit',incident.at end
    if state=='afraid' or state=='afraid_player' then return 'flee',0 end
    if state=='angry' or state=='combat' then return 'combat',0 end
    if state=='threatened' and cause=='aim' then return 'aim',0 end
end
local function spontaneousTarget()
    if not config.reactions or not config.reactions.enabled then return end
    local now,player=GetGameTimer(),PlayerPedId()
    local candidates,seen={},{}
    local function add(ped,id)
        if not ped or seen[ped] or ped==player or not DoesEntityExist(ped) or IsPedAPlayer(ped) or not IsPedHuman(ped) or IsEntityDead(ped) then return end
        if not id and not config.ambientNPCs then return end
        seen[ped]=true
        local d=entityDistance(GetEntityCoords(player),GetEntityCoords(ped))
        if d>(config.reactions.radius or config.interactionDistance) then return end
        local state,cause=FivemAIBehavior.observe(ped,player)
        local kind,incidentAt=reactionKind(ped,state,cause)
        local key=kind and kind..':'..tostring(incidentAt) or 'calm'
        local previous=reactionSeen[ped]
        reactionSeen[ped]={key=key,model=GetEntityModel(ped),at=now}
        if kind and (not previous or previous.key~=key or previous.model~=GetEntityModel(ped)) then
            table.insert(candidates,{ped=ped,id=id,kind=kind,distance=d})
        end
    end
    for id,ped in pairs(peds) do add(ped,id) end
    local ok,pool=pcall(GetGamePool,'CPed')
    if ok and type(pool)=='table' then
        local count=0
        for _,ped in pairs(pool) do add(ped) count=count+1 if count>=128 then break end end
    end
    for ped,entry in pairs(reactionSeen) do if now-entry.at>20000 then reactionSeen[ped]=nil end end
    for ped,entry in pairs(FivemAIBehavior.incidents) do if now-entry.at>2000 then FivemAIBehavior.incidents[ped]=nil end end
    table.sort(candidates,function(a,b)return a.distance<b.distance end)
    return candidates[1]
end
CreateThread(function()
    local nextScan, nextObservation = 0, 0
    while true do
        Wait(100)
        if maintainAction then maintainAction() end
        updateVoiceObservers()
        if GetGameTimer() >= nextScan then
            for id,netId in pairs(demoNetIds) do
                if NetworkDoesEntityExistWithNetworkId(netId) then
                    local ped=NetToPed(netId) peds[id]=ped
                    if flag('NetworkHasControlOfEntity',ped) then SetEntityInvincible(ped,true) end
                else peds[id]=nil end
            end
            FivemAIBehavior.scan(PlayerPedId()) nextScan=GetGameTimer()+400
            if not talking and nuiReady and GetGameTimer()>=nextAutoReaction then
                local target=spontaneousTarget()
                if target then nextAutoReaction=GetGameTimer()+(config.reactions.autoCooldownSeconds or 15)*1000 startConversation(target,target.kind) end
            end
        end
        if currentNpc then
            local ped = currentPed
            if ped and DoesEntityExist(ped) and GetGameTimer() >= nextObservation then
                nextObservation=GetGameTimer()+1000
                TriggerServerEvent('fivemai:observation', currentNpc.id, {aimed=flag('IsPedArmed',PlayerPedId(),6) and (flag('IsPlayerFreeAimingAtEntity',playerIndex(),ped) or flag('IsPlayerTargettingEntity',playerIndex(),ped)),armed=flag('IsPedArmed',ped,7)})
            end
            if currentNpc.netId and NetworkDoesEntityExistWithNetworkId(currentNpc.netId) then ped = NetToPed(currentNpc.netId) currentPed = ped end
            local coords = ped and DoesEntityExist(ped) and GetEntityCoords(ped) or vector3(currentNpc.coords.x, currentNpc.coords.y, currentNpc.coords.z)
            local distance = entityDistance(GetEntityCoords(PlayerPedId()), coords)
            if ped and DoesEntityExist(ped) then
                local observed = FivemAIBehavior.observe(ped, PlayerPedId())
                if observed ~= 'calm' then moodChangedAt = GetGameTimer() end
                local recovered = currentMood == 'calm' or GetGameTimer() - moodChangedAt >= 1800
                local mood, cause = FivemAIBehavior.pose(ped, PlayerPedId(), distance <= config.interactionDistance + 1 and recovered, peds[currentNpc.id] == ped, workingJob ~= nil or currentAction ~= nil or worldWorking(ped))
                if (mood ~= currentMood or cause ~= currentCause) and (mood ~= 'calm' or GetGameTimer() - moodChangedAt >= 1800) then
                    currentMood, currentCause = mood, cause
                    TriggerServerEvent('fivemai:behavior', currentNpc.id, mood, pressed, cause)
                end
                if not pressed and config.reactions and config.reactions.enabled then
                    local kind,stamp=reactionKind(ped,mood,cause)
                    local key=kind and kind..':'..tostring(stamp) or 'calm'
                    if key~=pendingReaction then
                        pendingReaction=key
                        if kind and GetGameTimer()-lastReaction>=(config.reactions.cooldownSeconds or 8)*1000 then
                            lastReaction=GetGameTimer()
                            local incident=FivemAIBehavior.incidents[ped]
                            TriggerServerEvent('fivemai:observation',currentNpc.id,{aimed=flag('IsPedArmed',PlayerPedId(),6) and (flag('IsPlayerFreeAimingAtEntity',playerIndex(),ped) or flag('IsPlayerTargettingEntity',playerIndex(),ped)),armed=flag('IsPedArmed',ped,7),hit=incident and GetGameTimer()-incident.at<1800})
                            TriggerServerEvent('fivemai:react',currentNpc.id,kind)
                        end
                    end
                end
            end
            SendNUIMessage({type='proximity', distance=distance, fullDistance=config.voiceFullDistance or 3, maxDistance=config.voiceMaxDistance or 18})
            if pressed and distance > config.interactionDistance + 1 then
                pressed = false
                TriggerServerEvent('fivemai:speaking', false)
                SendNUIMessage({type='ptt', held=false})
            end
        end
    end
end)
RegisterNUICallback('voiceReady', function(data, cb)
    if currentNpc and data.npcId==currentNpc.id and (not data.sessionId or data.sessionId==uiSession) then TriggerServerEvent('fivemai:voiceReady',currentNpc.id,uiSession) end
    cb({ok=true})
end)
RegisterNUICallback('voiceFrame', function(data, cb)
    local valid=currentNpc and type(data)=='table' and data.token==voiceOwnerToken and data.sessionId==uiSession
    if valid then TriggerServerEvent('fivemai:voiceFrame',data) end
    cb({ok=valid==true})
end)
RegisterNUICallback('offer', function(data, cb)
    if not currentNpc or data.npcId~=currentNpc.id or (data.sessionId and data.sessionId~=uiSession) then cb({ok=false}) return end
    local mood, cause = 'calm', 'none'
    if currentPed and DoesEntityExist(currentPed) then mood, cause = FivemAIBehavior.observe(currentPed, PlayerPedId()) end
    TriggerServerEvent('fivemai:offer', data.npcId, data.sdp, mood, pressed, cause, {sessionId=uiSession,speechToken=policeSpeechToken,aimed=currentPed and flag('IsPedArmed', PlayerPedId(), 6) and (flag('IsPlayerFreeAimingAtEntity', playerIndex(), currentPed) or flag('IsPlayerTargettingEntity', playerIndex(), currentPed)), armed=currentPed and flag('IsPedArmed', currentPed, 7), netId=currentPed and NetworkGetEntityIsNetworked(currentPed) and NetworkGetNetworkIdFromEntity(currentPed) or nil, hit=currentPed and FivemAIBehavior.incidents[currentPed]~=nil,sex=currentPed and type(IsPedMale)=='function' and (flag('IsPedMale',currentPed) and 'male' or 'female') or 'unknown',automatic=automatic,reaction=automatic and candidateReaction or nil})
    cb({ok=true})
end)
RegisterNUICallback('close', function(data, cb)
    if not data.sessionId or data.sessionId==uiSession then closeConversation() end
    cb({ok=true})
end)
RegisterNetEvent('fivemai:answer', function(sdp, sessionId)
    if type(sdp)=='table' then sessionId=sdp.sessionId sdp=sdp.sdp end
    if currentNpc and (not sessionId or sessionId==uiSession) then SendNUIMessage({type='answer',sdp=sdp,sessionId=uiSession}) end
end)
RegisterNetEvent('fivemai:error', function(message)
    local sessionId=type(message)=='table' and message.sessionId or nil
    if sessionId and sessionId~=uiSession then return end
    if type(message)=='table' then message=message.message end
    local text = type(message) == 'string' and message ~= '' and message or 'Erreur serveur sans détail. Consultez la console txAdmin.'
    print('[fivemai] ' .. text)
    SendNUIMessage({type='error', message=text,sessionId=uiSession})
end)
RegisterNetEvent('fivemai:notice',function(message)
    local value=type(message)=='table' and message.message or message
    if type(value)=='string' and #value<=1200 then SendNUIMessage({type='notice',message=value}) end
end)
RegisterNetEvent('fivemai:closed', function(data)
    local sessionId=type(data)=='table' and data.sessionId or data
    if not sessionId or sessionId==uiSession then closeConversation(false,type(data)=='table' and data.interruptGameplay==true) end
end)
RegisterNUICallback('diagnostic', function(data, cb)
    local text = type(data.message) == 'string' and data.message ~= '' and data.message or 'Diagnostic vide reçu de l’interface vocale.'
    print('[fivemai] ' .. text)
    cb({ok=true})
end)
AddEventHandler('onResourceStop', function(name)
    if name ~= GetCurrentResourceName() then return end
    nativeSpeech(mutedPed,true)
    for _,voice in pairs(voiceObservers) do nativeSpeech(voice.ped,true) end
    voiceObservers={}
    if finishAction then finishAction(true, 'interrupted') end
    if workingJob then
        local job=workingJob workingJob=nil
        if job.openedHood and DoesEntityExist(job.vehicle) and NetworkHasControlOfEntity(job.vehicle) then
            if job.hoodWasOpen then SetVehicleDoorOpen(job.vehicle,4,false,false) else SetVehicleDoorShut(job.vehicle,4,false) end
        end
        if DoesEntityExist(job.ped) and (not NetworkGetEntityIsNetworked(job.ped) or NetworkHasControlOfEntity(job.ped)) and FivemAIBehavior.observe(job.ped,PlayerPedId())=='calm' then ClearPedTasks(job.ped) end
    end
    if currentPed then FivemAIBehavior.release(currentPed, true, peds[currentNpc and currentNpc.id] == currentPed) end
    if not config.demoNetwork then for _, ped in pairs(peds) do DeleteEntity(ped) end end
end)

-- F8 commands only; no menu and no NUI focus.
RegisterCommand('pnjmicro', function(_, args)
    if args[1] == 'default' then
        DeleteResourceKvp('fivemai_microphone')
        closeConversation()
        print('[fivemai] Micro Windows par défaut sélectionné. Relâchez puis maintenez votre touche pour reconnecter.')
        return
    end
    SendNUIMessage({type='microphones', index=tonumber(args[1])})
end, false)
RegisterNUICallback('microphoneFallback', function(data, cb)
    if GetResourceKvpString('fivemai_microphone') == data.deviceId then DeleteResourceKvp('fivemai_microphone') end
    cb({ok=true})
end)
RegisterNUICallback('microphone', function(data, cb)
    if type(data.deviceId) == 'string' and #data.deviceId < 512 then
        SetResourceKvp('fivemai_microphone', data.deviceId)
        closeConversation()
        print('[fivemai] Micro sélectionné : ' .. tostring(data.label) .. '. Relâchez puis maintenez votre touche pour reconnecter.')
    end
    cb({ok=true})
end)

local movementSerial = 0
local function takeControl(entity, deadline)
    if not NetworkGetEntityIsNetworked(entity) then return true end
    while DoesEntityExist(entity) and not NetworkHasControlOfEntity(entity) and GetGameTimer() < deadline do
        NetworkRequestControlOfEntity(entity)
        Wait(50)
    end
    return DoesEntityExist(entity) and NetworkHasControlOfEntity(entity)
end
local function atWorkPosition(ped, target, radius)
    local coords = GetEntityCoords(ped)
    local dx, dy = coords.x - target.x, coords.y - target.y
    -- Ped coordinates are above their feet; the navmesh target is on the floor.
    return dx * dx + dy * dy <= radius * radius and math.abs(coords.z - target.z) <= 2.0
end
local function mechanicLog(message)
    print('[fivemai] Mécanicien : ' .. message)
end
local function aimedAt(ped)
    return flag('IsPedArmed', PlayerPedId(), 6) and (flag('IsPlayerFreeAimingAtEntity', playerIndex(), ped) or flag('IsPlayerTargettingEntity', playerIndex(), ped))
end
local function actionEvidence(action)
    local result={npcNetId=DoesEntityExist(action.ped) and NetworkGetEntityIsNetworked(action.ped) and NetworkGetNetworkIdFromEntity(action.ped) or nil}
    if action.vehicle and DoesEntityExist(action.vehicle) then
        local c=GetEntityCoords(action.vehicle)
        result.vehicleNetId=NetworkGetNetworkIdFromEntity(action.vehicle)
        result.coords={x=c.x,y=c.y,z=c.z}
        result.speed=GetEntitySpeed(action.vehicle)
        result.driver=GetPedInVehicleSeat(action.vehicle,-1)==action.ped
        result.playerInside=GetVehiclePedIsIn(PlayerPedId(),false)==action.vehicle
    end
    return result
end
finishAction = function(clear, reason)
    local action = currentAction
    if not action then return end
    if clear and NetworkGetEntityIsNetworked(action.ped) and not NetworkHasControlOfEntity(action.ped) then clear=false reason='control' end
    currentAction = nil
    FivemAIBehavior.surrendered[action.ped] = nil
    if DoesEntityExist(action.ped) then
        SetBlockingOfNonTemporaryEvents(action.ped, false)
        if clear and not flag('IsPedInCombat', action.ped, 0) and not flag('IsPedFleeing', action.ped) and not flag('IsPedRagdoll', action.ped) and (not NetworkGetEntityIsNetworked(action.ped) or NetworkHasControlOfEntity(action.ped)) then
            ClearPedTasks(action.ped)
            if action.vehicle and DoesEntityExist(action.vehicle) then TaskVehicleTempAction(action.ped,action.vehicle,27,1500) end
        end
    end
    if action.confirmed then TriggerServerEvent('fivemai:actionEnded', action.token, reason or 'interrupted', actionEvidence(action)) end
end
maintainAction = function()
    local action = currentAction
    if not action or not action.confirmed then return end
    if not DoesEntityExist(action.ped) or IsEntityDead(action.ped) then finishAction(false, 'gone') return end
    local now = GetGameTimer()
    if IsEntityDead(PlayerPedId()) then finishAction(true,'player_dead') return end
    if worldWorking(action.ped) then finishAction(false,'priority') return end
    if NetworkGetEntityIsNetworked(action.ped) and not NetworkHasControlOfEntity(action.ped) then finishAction(false,'control') return end
    if action.vehicle and (not DoesEntityExist(action.vehicle) or GetVehiclePedIsIn(PlayerPedId(),false)~=action.vehicle) then finishAction(true,'released') return end
    if action.vehicle and action.destination then
        if GetPedInVehicleSeat(action.vehicle,-1)~=action.ped then finishAction(false,'driver') return end
        if not NetworkHasControlOfEntity(action.vehicle) then finishAction(false,'control') return end
        local coords=GetEntityCoords(action.vehicle)
        local remaining=entityDistance(coords,action.destination)
        if remaining<=8.0 and math.abs(coords.z-action.destination.z)<=3.0 then
            TaskVehicleTempAction(action.ped,action.vehicle,27,1500)
            if GetEntitySpeed(action.vehicle)<=1.0 then
                action.stoppedAt=action.stoppedAt or now
                if now-action.stoppedAt>=800 then finishAction(false,'arrived') return end
            else action.stoppedAt=nil end
        else
            action.stoppedAt=nil
            if not action.lastProgress or entityDistance(coords,action.lastProgress)>=3.0 then action.lastProgress=coords action.progressAt=now action.recoveries=0 end
            if now-(action.progressAt or now)>=10000 and now-(action.retryAt or 0)>=10000 then
                if (action.recoveries or 0)>=2 then finishAction(true,'stuck') return end
                action.recoveries=(action.recoveries or 0)+1 action.retryAt=now
                -- Ask GTA to find another route. Occupants are never teleported.
                TaskVehicleDriveToCoordLongrange(action.ped,action.vehicle,action.destination.x,action.destination.y,action.destination.z,12.0,786603,6.0)
            end
        end
    end
    if action.action=='wait' and now>=action.expires then finishAction(true,'completed') return end
    if now >= action.expires then finishAction(true, 'expired') return end
    if entityDistance(GetEntityCoords(action.ped), GetEntityCoords(PlayerPedId())) > action.maxDistance then finishAction(true, 'distance') return end
    if action.action == 'hands_up' then
        if flag('IsPedInCombat', action.ped, 0) or flag('IsPedFleeing',action.ped) or flag('IsPedRagdoll', action.ped) then finishAction(false, 'danger') return end
        if not flag('IsEntityPlayingAnim',action.ped,'missminuteman_1ig_2','handsup_base',3) then finishAction(false,'interrupted') return end
        if aimedAt(action.ped) then action.lastThreat = now end
        if now - action.lastThreat >= action.releaseAfterThreat then finishAction(true, 'released') return end
    elseif action.action ~= 'flee' and FivemAIBehavior.observe(action.ped, PlayerPedId()) ~= 'calm' then finishAction(false, 'danger') return end
end
RegisterNetEvent('fivemai:actionCancel', function(data)
    if type(data)=='table' and currentAction and currentAction.token == data.token then finishAction(true, data.reason or 'interrupted') end
end)
RegisterNetEvent('fivemai:actionStart', function(data)
    if type(data)~='table' or type(data.token)~='string' then return end
    local ped=currentNpc and currentNpc.id==data.npcId and currentPed or (data.npcNetId and NetworkDoesEntityExistWithNetworkId(data.npcNetId) and NetToPed(data.npcNetId) or peds[data.npcId])
    if not ped or not DoesEntityExist(ped) or workingJob or worldWorking(ped) then TriggerServerEvent('fivemai:actionResult', data.token, false, 'danger') return end
    cancelRoutine(ped)
    finishAction(true, 'interrupted')
    local action = {token=data.token,ped=ped,npcId=data.npcId,action=data.action,expires=GetGameTimer()+math.min(180,tonumber(data.durationSeconds) or 30)*1000,
        maxDistance=math.min(50,tonumber(data.maxDistance) or 30),lastThreat=GetGameTimer(),releaseAfterThreat=(tonumber(data.releaseAfterThreatSeconds) or 8)*1000}
    currentAction = action
    CreateThread(function()
        local ok, reason = false, 'script'
        local success, err = xpcall(function()
            if not takeControl(ped, GetGameTimer()+1500) then reason='control' return end
            if currentAction ~= action or not DoesEntityExist(ped) or IsEntityDead(ped) then reason='gone' return end
            if flag('IsPedRagdoll', ped) or (flag('IsPedInAnyVehicle', ped, false) and data.action~='exit_vehicle') then reason='danger' return end
            if data.action == 'hands_up' then
                if not aimedAt(ped) then reason='weapon' return end
                if flag('IsPedArmed', ped, 7) and not (config.actions and config.actions.allowArmedSurrender) then reason='refused' return end
                RequestAnimDict('missminuteman_1ig_2')
                local deadline=GetGameTimer()+2000
                while not HasAnimDictLoaded('missminuteman_1ig_2') and GetGameTimer()<deadline do Wait(50) end
                if currentAction ~= action or not aimedAt(ped) then reason='weapon' return end
                if not HasAnimDictLoaded('missminuteman_1ig_2') then reason='animation' return end
                FivemAIBehavior.release(ped, false, peds[data.npcId]==ped)
                ClearPedTasks(ped)
                SetBlockingOfNonTemporaryEvents(ped, true)
                TaskHandsUp(ped, data.durationSeconds*1000, PlayerPedId(), -1, true)
                Wait(500)
                if currentAction ~= action then return end
                -- Explicit looping animation supports peds whose native hands-up task differs.
                if not flag('IsEntityPlayingAnim', ped, 'missminuteman_1ig_2', 'handsup_base', 3) then
                    TaskPlayAnim(ped, 'missminuteman_1ig_2', 'handsup_base', 4.0, -4.0, data.durationSeconds*1000, 49, 0, false, false, false)
                    Wait(300)
                end
                ok=flag('IsEntityPlayingAnim', ped, 'missminuteman_1ig_2', 'handsup_base', 3)
                if ok then FivemAIBehavior.surrendered[ped]=true else reason='animation' end
            else
                local state=FivemAIBehavior.observe(ped, PlayerPedId())
                if data.action ~= 'flee' and state ~= 'calm' then reason='danger' return end
                FivemAIBehavior.release(ped, false, peds[data.npcId]==ped)
                if data.action == 'wait' then
                    TaskStandStill(ped,math.max(1,math.min(180,tonumber(data.durationSeconds) or 30))*1000)
                    Wait(300)
                    local status=getter('GetScriptTaskStatus',ped,joaat('SCRIPT_TASK_STAND_STILL'))
                    ok=(status==0 or status==1) and not flag('IsPedInCombat',ped,0) and not flag('IsPedFleeing',ped)
                    reason='path'
                elseif data.action == 'go_to' then
                    local point=data.destination
                    if type(point)~='table' or not tonumber(point.x) or not tonumber(point.y) or not tonumber(point.z) then reason='path' return end
                    TaskFollowNavMeshToCoord(ped,point.x,point.y,point.z,1.5,15000,1.0,0,0.0)
                    local deadline=GetGameTimer()+15000
                    while currentAction==action and DoesEntityExist(ped) and GetGameTimer()<deadline do
                        if FivemAIBehavior.observe(ped,PlayerPedId())~='calm' then reason='danger' return end
                        if atWorkPosition(ped,point,1.6) then ok=true break end
                        Wait(100)
                    end
                    reason='path'
                elseif data.action == 'exit_vehicle' then
                    local vehicle=GetVehiclePedIsIn(ped,false)
                    if vehicle==0 or not DoesEntityExist(vehicle) then reason='vehicle' return end
                    if GetEntitySpeed(vehicle)>0.5 then reason='moved' return end
                    TaskLeaveVehicle(ped,vehicle,0)
                    local deadline=GetGameTimer()+10000
                    while currentAction==action and DoesEntityExist(ped) and GetGameTimer()<deadline do
                        if not flag('IsPedInAnyVehicle',ped,false) and GetVehiclePedIsIn(ped,false)==0 then ok=true break end
                        Wait(100)
                    end
                    reason='vehicle'
                elseif data.action == 'follow' then
                    TaskFollowToOffsetOfEntity(ped, PlayerPedId(), 0.0, -1.5, 0.0, 1.5, -1, 2.0, true)
                    Wait(500)
                    ok=not flag('IsPedFleeing',ped) and not flag('IsPedInCombat',ped,0) and (getter('GetScriptTaskStatus',ped,joaat('SCRIPT_TASK_FOLLOW_TO_OFFSET_OF_ENTITY'))==1 or getter('GetScriptTaskStatus',ped,joaat('SCRIPT_TASK_FOLLOW_TO_OFFSET_OF_ENTITY'))==0)
                elseif data.action == 'flee' then
                    if flag('IsPedInCombat',ped,0) then reason='danger' return end
                    TaskSmartFleePed(ped, PlayerPedId(), 60.0, data.durationSeconds*1000, false, false)
                    Wait(500)
                    ok=flag('IsPedFleeing', ped)
                elseif data.action == 'approach_vehicle' or data.action == 'enter_vehicle' or data.action == 'drive' then
                    local vehicle=NetworkDoesEntityExistWithNetworkId(data.vehicleNetId) and NetToVeh(data.vehicleNetId) or 0
                    if not DoesEntityExist(vehicle) or GetEntitySpeed(vehicle)>0.5 or not takeControl(vehicle,GetGameTimer()+1500) then reason='vehicle' return end
                    if data.action == 'approach_vehicle' then
                        local point=GetOffsetFromEntityInWorldCoords(vehicle,2.0,0.0,0.0)
                        TaskFollowNavMeshToCoord(ped,point.x,point.y,point.z,1.5,15000,1.0,0,0.0)
                        local deadline=GetGameTimer()+15000
                        while currentAction==action and DoesEntityExist(vehicle) and GetGameTimer()<deadline do
                            if FivemAIBehavior.observe(ped,PlayerPedId())~='calm' then reason='danger' return end
                            if atWorkPosition(ped,point,1.6) then ok=true break end
                            Wait(100)
                        end
                        reason='path'
                    else
                        local seat=data.action=='drive' and -1 or nil
                        if not seat then
                            for index=0,GetVehicleMaxNumberOfPassengers(vehicle)-1 do if IsVehicleSeatFree(vehicle,index,false) then seat=index break end end
                        end
                        if seat==nil or not IsVehicleSeatFree(vehicle,seat,false) then reason='vehicle' return end
                        if data.action=='drive' and (type(data.destination)~='table' or not tonumber(data.destination.x) or not tonumber(data.destination.y) or not tonumber(data.destination.z)) then reason='path' return end
                        TaskEnterVehicle(ped,vehicle,15000,seat,1.0,1,0)
                        local deadline=GetGameTimer()+15000
                        while currentAction==action and DoesEntityExist(vehicle) and GetGameTimer()<deadline do
                            if FivemAIBehavior.observe(ped,PlayerPedId())~='calm' then reason='danger' return end
                            if GetPedInVehicleSeat(vehicle,seat)==ped then ok=true break end
                            Wait(100)
                        end
                        reason='vehicle'
                        if ok and data.action=='drive' then
                            local boardingDeadline=GetGameTimer()+8000
                            while currentAction==action and GetVehiclePedIsIn(PlayerPedId(),false)~=vehicle and GetGameTimer()<boardingDeadline do Wait(100) end
                            if currentAction~=action or GetVehiclePedIsIn(PlayerPedId(),false)~=vehicle then ok=false reason='vehicle' return end
                            TaskVehicleDriveToCoordLongrange(ped,vehicle,data.destination.x,data.destination.y,data.destination.z,15.0,786603,8.0)
                            action.vehicle,action.destination=vehicle,data.destination
                            action.lastProgress,action.progressAt,action.retryAt,action.recoveries=GetEntityCoords(vehicle),GetGameTimer(),GetGameTimer(),0
                            Wait(300)
                            local status=getter('GetScriptTaskStatus',ped,joaat('SCRIPT_TASK_VEHICLE_DRIVE_TO_COORD_LONGRANGE'))
                            ok=status==0 or status==1
                        end
                    end
                end
            end
        end, function(e)return tostring(e)end)
        if not success then print('[fivemai] Action PNJ : '..tostring(err)) ok=false reason='script' end
        if currentAction ~= action then return end
        action.confirmed=ok
        TriggerServerEvent('fivemai:actionResult', action.token, ok, reason,actionEvidence(action))
        if not ok then finishAction(true, reason) end
    end)
end)
RegisterNetEvent('fivemai:jobStart', function(data)
    local ped = currentNpc and currentNpc.id == data.npcId and currentPed or (data.npcNetId and NetToPed(data.npcNetId) or peds[data.npcId])
    local vehicle = NetworkDoesEntityExistWithNetworkId(data.netId) and NetToVeh(data.netId) or 0
    if currentAction or not ped or not DoesEntityExist(ped) or not DoesEntityExist(vehicle) or worldWorking(ped) then
        TriggerServerEvent('fivemai:jobArrived', data.token, false)
        return
    end
    cancelRoutine(ped)
    if FivemAIBehavior.observe(ped, PlayerPedId()) ~= 'calm' then
        TriggerServerEvent('fivemai:jobArrived', data.token, false, 'danger')
        return
    end
    FivemAIBehavior.release(ped, false, false)
    movementSerial = movementSerial + 1
    local job = {token=data.token,npcId=data.npcId, ped=ped, vehicle=vehicle, origin=GetEntityCoords(ped), heading=GetEntityHeading(ped), fixed=peds[data.npcId]==ped, serial=movementSerial}
    workingJob = job
    CreateThread(function()
        local success, err = xpcall(function()
        local deadline = GetGameTimer() + 15000
        if not takeControl(ped, GetGameTimer() + 2000) or not takeControl(vehicle, GetGameTimer() + 2000) then
            TriggerServerEvent('fivemai:jobArrived', job.token, false, 'control')
            return
        end
        if workingJob ~= job then return end
        local startVehicle = GetEntityCoords(vehicle)
        local _, max = GetModelDimensions(GetEntityModel(vehicle))
        local target = GetOffsetFromEntityInWorldCoords(vehicle, 0.0, max.y + 0.7, 0.0)
        local ground, z = GetGroundZFor_3dCoord(target.x, target.y, target.z + 2.0, false)
        if ground then target = vector3(target.x, target.y, z) end
        FreezeEntityPosition(ped, false)
        ClearPedTasks(ped)
        local center = GetEntityCoords(vehicle)
        local heading = GetHeadingFromVector_2d(center.x - target.x, center.y - target.y)
        TaskFollowNavMeshToCoord(ped, target.x, target.y, target.z, 1.0, 15000, 0.65, 0, heading)
        local failureReason = 'path'
        while workingJob == job and DoesEntityExist(ped) and DoesEntityExist(vehicle) and GetGameTimer() < deadline do
            if FivemAIBehavior.observe(ped, PlayerPedId()) ~= 'calm' then failureReason = 'danger' break end
            if entityDistance(GetEntityCoords(vehicle), startVehicle) > 0.5 or GetEntitySpeed(vehicle) > 0.3 then failureReason = 'moved' break end
            if atWorkPosition(ped, target, 1.3) then
                mechanicLog('arrivé devant le capot')
                TaskAchieveHeading(ped, heading, 700)
                Wait(700)
                if workingJob ~= job or not DoesEntityExist(vehicle) or entityDistance(GetEntityCoords(vehicle), startVehicle) > 0.5 then break end
                RequestAnimDict('mini@repair')
                local animationDeadline = GetGameTimer() + 1500
                while not HasAnimDictLoaded('mini@repair') and GetGameTimer() < animationDeadline do Wait(50) end
                if workingJob == job and HasAnimDictLoaded('mini@repair') and FivemAIBehavior.observe(ped, PlayerPedId()) == 'calm' then
                    job.target, job.vehicleOrigin = target, startVehicle
                    if GetIsDoorValid(vehicle, 4) then
                        job.hoodWasOpen = GetVehicleDoorAngleRatio(vehicle, 4) > 0.05
                        SetVehicleDoorOpen(vehicle, 4, false, false)
                        job.openedHood = true
                        Wait(400)
                        mechanicLog(GetVehicleDoorAngleRatio(vehicle, 4) > 0.05 and 'capot ouvert' or 'ouverture du capot demandée; ce modèle ne confirme pas son animation')
                    else
                        -- Missing/damaged/custom bonnets must not prevent repairing the engine.
                        mechanicLog('capot absent ou non animé sur ce modèle; réparation maintenue')
                    end
                    if workingJob ~= job or not DoesEntityExist(vehicle) or entityDistance(GetEntityCoords(vehicle), startVehicle) > 0.5 then break end
                    TaskPlayAnim(ped, 'mini@repair', 'fixing_a_ped', 3.0, -3.0, -1, 1, 0, false, false, false)
                    mechanicLog('animation lancée, validation envoyée au serveur')
                    TriggerServerEvent('fivemai:jobArrived', job.token, true)
                    return
                end
                break
            end
            Wait(100)
        end
        if workingJob == job then
            if DoesEntityExist(ped) then
                local coords = GetEntityCoords(ped)
                local dx, dy = coords.x - target.x, coords.y - target.y
                mechanicLog(string.format('préparation interrompue (%s), distance au point au sol=%.2f m, décalage vertical=%.2f m', failureReason, math.sqrt(dx * dx + dy * dy), math.abs(coords.z - target.z)))
            end
            TriggerServerEvent('fivemai:jobArrived', job.token, false, failureReason)
        end
        end, function(error) return tostring(error) end)
        if not success and workingJob == job then
            mechanicLog('erreur de préparation : ' .. tostring(err))
            TriggerServerEvent('fivemai:jobArrived', job.token, false, 'script')
        end
    end)
end)
RegisterNetEvent('fivemai:jobEnd', function(data)
    local job = workingJob
    if not job or data.token ~= job.token then return end
    workingJob = nil
    if job.openedHood and DoesEntityExist(job.vehicle) and NetworkHasControlOfEntity(job.vehicle) then
        if job.hoodWasOpen then SetVehicleDoorOpen(job.vehicle, 4, false, false) else SetVehicleDoorShut(job.vehicle, 4, false) end
    end
    if not DoesEntityExist(job.ped) then return end
    if NetworkGetEntityIsNetworked(job.ped) and not NetworkHasControlOfEntity(job.ped) then return end
    if FivemAIBehavior.observe(job.ped, PlayerPedId()) ~= 'calm' then return end
    ClearPedTasks(job.ped)
    -- Demo peds return to their anchor so their configured server position remains valid.
    if job.fixed then
        CreateThread(function()
            TaskFollowNavMeshToCoord(job.ped, job.origin.x, job.origin.y, job.origin.z, 1.0, 15000, 0.65, 0, job.heading)
            local deadline = GetGameTimer() + 15000
            while movementSerial == job.serial and DoesEntityExist(job.ped) and GetGameTimer() < deadline do
                if NetworkGetEntityIsNetworked(job.ped) and not NetworkHasControlOfEntity(job.ped) then return end
                if FivemAIBehavior.observe(job.ped, PlayerPedId()) ~= 'calm' then return end
                if atWorkPosition(job.ped, job.origin, 1.3) then
                    if type(TaskStandStill) == 'function' then TaskStandStill(job.ped, -1) end
                    return
                end
                Wait(100)
            end
        end)
    end
end)
RegisterNetEvent('fivemai:jobApply', function(data)
    if type(data)~='table' or type(data.token)~='string' then return end
    CreateThread(function()
        local observed={}
        local success,err=xpcall(function()
        local modifications=data.modifications
        if not modifications and type(data.upgrade)=='table' then modifications={{type=data.upgrade.slot,index=data.upgrade.level}} end
        local vehicle = NetworkDoesEntityExistWithNetworkId(data.netId) and NetToVeh(data.netId) or 0
        local job = workingJob
        local ok = job and job.token == data.token and job.target and job.npcId == data.npcId and DoesEntityExist(vehicle) and job.vehicle == vehicle and entityDistance(GetEntityCoords(PlayerPedId()), GetEntityCoords(vehicle)) <= 12
        if ok then
            local deadline = GetGameTimer() + 1500
            while not NetworkHasControlOfEntity(vehicle) and GetGameTimer() < deadline do NetworkRequestControlOfEntity(vehicle) Wait(50) end
            ok = workingJob == job and job.npcId == data.npcId and NetworkHasControlOfEntity(vehicle) and job.vehicle == vehicle and entityDistance(GetEntityCoords(PlayerPedId()), GetEntityCoords(vehicle)) <= 12
        end
        if ok then
            ok = DoesEntityExist(job.ped) and FivemAIBehavior.observe(job.ped, PlayerPedId()) == 'calm' and atWorkPosition(job.ped, job.target, 1.6) and entityDistance(GetEntityCoords(vehicle), job.vehicleOrigin) <= 0.5 and GetEntitySpeed(vehicle) <= 0.3
        end
        if ok and data.service == 'repair' then
            SetVehicleFixed(vehicle)
            SetVehicleDeformationFixed(vehicle)
            SetVehicleEngineHealth(vehicle, 1000.0)
            SetVehicleBodyHealth(vehicle, 1000.0)
            ok = GetVehicleEngineHealth(vehicle) >= 990.0
        elseif ok and data.service == 'repaint' and type(data.colour) == 'table' then
            SetVehicleCustomPrimaryColour(vehicle, data.colour[1], data.colour[2], data.colour[3])
            SetVehicleCustomSecondaryColour(vehicle, data.colour[1], data.colour[2], data.colour[3])
            local r, g, b = GetVehicleCustomPrimaryColour(vehicle)
            ok = r == data.colour[1] and g == data.colour[2] and b == data.colour[3]
        elseif ok and data.service == 'upgrade' and type(modifications)=='table' and #modifications>0 and #modifications<=8 then
            SetVehicleModKit(vehicle,0)
            -- The server chooses an authorized package; reject the entire unsupported
            -- package before applying any part of it to this actual vehicle model.
            local allowed={[11]=true,[12]=true,[13]=true,[15]=true,[16]=true}
            local seen, previous={},{}
            for _,mod in ipairs(modifications) do
                if type(mod)~='table' then ok=false break end
                local kind,index=tonumber(mod.type),tonumber(mod.index)
                if not allowed[kind] or not index or index~=math.floor(index) or index<0 or index>=GetNumVehicleMods(vehicle,kind) or seen[kind] then ok=false break end
                seen[kind]=true previous[kind]=GetVehicleMod(vehicle,kind)
            end
            if ok then
                for _,mod in ipairs(modifications) do SetVehicleMod(vehicle,mod.type,mod.index,false) end
                Wait(100)
                for _,mod in ipairs(modifications) do
                    local actual=GetVehicleMod(vehicle,mod.type)
                    table.insert(observed,{type=mod.type,index=actual})
                    if actual~=mod.index then ok=false end
                end
                if not ok then for kind,index in pairs(previous) do SetVehicleMod(vehicle,kind,index,false) end end
            end
        else
            ok = false
        end
        mechanicLog(ok and 'intervention appliquée avec succès' or 'intervention refusée : position, contrôle réseau ou véhicule invalidé')
        TriggerServerEvent('fivemai:jobResult', data.token, ok, observed)
        end,function(e)return tostring(e)end)
        if not success then mechanicLog('erreur d’application : '..tostring(err)) TriggerServerEvent('fivemai:jobResult',data.token,false,observed) end
    end)
end)

print('[fivemai] Version living-city-1 : commande N chargée, personnalisable dans les paramètres FiveM.')
