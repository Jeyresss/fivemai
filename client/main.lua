local config = json.decode(LoadResourceFile(GetCurrentResourceName(), 'config.json'))
local peds = {}
local talking = false
CreateThread(function()
    for _, npc in ipairs(config.npcs) do
        local model = joaat(npc.model)
        RequestModel(model)
        local deadline = GetGameTimer() + 10000
        while not HasModelLoaded(model) and GetGameTimer() < deadline do Wait(50) end
        if HasModelLoaded(model) then
            local c = npc.coords
            local ped = CreatePed(4, model, c.x, c.y, c.z - 1.0, c.heading, false, false)
            SetEntityInvincible(ped, true)
            FreezeEntityPosition(ped, true)
            SetBlockingOfNonTemporaryEvents(ped, true)
            peds[npc.id] = ped
            SetModelAsNoLongerNeeded(model)
        end
    end
end)
local currentNpc, currentPed, candidate = nil, nil, nil
local pressed = false
local requestSerial = 0
local nuiReady, queuedOpen, uiSession = false, nil, 0
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
        if not fixedId then
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
local function closeConversation(notifyServer)
    uiSession = uiSession + 1
    queuedOpen = nil
    talking, pressed, currentNpc, currentPed, candidate = false, false, nil, nil, nil
    SendNUIMessage({type='closed'})
    if notifyServer ~= false then TriggerServerEvent('fivemai:stop') end
end
local function deliverOpen()
    if not nuiReady or not queuedOpen then return end
    SendNUIMessage(queuedOpen)
    SendNUIMessage({type='ptt', held=pressed})
end
local function openConversation(profile, ped)
    currentNpc, currentPed, candidate = profile, ped, nil
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
    TriggerServerEvent('fivemai:resolve', {netId=nearest.netId, requestId=nearest.requestId})
    SetTimeout(5000, function()
        if candidate == nearest and nearest.attempt == attempt then
            print('[fivemai] Le serveur ne répond pas à la résolution du profil. Vérifiez les erreurs fivemai dans la console txAdmin et que toute la ressource a été mise à jour.')
            closeConversation()
        end
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
    if not talking then
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
    else
        if queuedOpen then deliverOpen() else SendNUIMessage({type='ptt', held=true}) end
    end
end, false)
RegisterCommand('-fivemai_talk', function()
    pressed = false
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
RegisterKeyMapping('+fivemai_talk', 'Maintenir pour parler au PNJ (IA)', 'keyboard', 'N')
CreateThread(function()
    while true do
        Wait(100)
        if currentNpc then
            local ped = currentPed
            if currentNpc.netId and NetworkDoesEntityExistWithNetworkId(currentNpc.netId) then ped = NetToPed(currentNpc.netId) currentPed = ped end
            local coords = ped and DoesEntityExist(ped) and GetEntityCoords(ped) or vector3(currentNpc.coords.x, currentNpc.coords.y, currentNpc.coords.z)
            local distance = entityDistance(GetEntityCoords(PlayerPedId()), coords)
            SendNUIMessage({type='proximity', distance=distance, fullDistance=config.voiceFullDistance or 3, maxDistance=config.voiceMaxDistance or 18})
            if pressed and distance > config.interactionDistance + 1 then
                pressed = false
                SendNUIMessage({type='ptt', held=false})
            end
        end
    end
end)
RegisterNUICallback('offer', function(data, cb)
    TriggerServerEvent('fivemai:offer', data.npcId, data.sdp)
    cb({ok=true})
end)
RegisterNUICallback('close', function(_, cb)
    closeConversation()
    cb({ok=true})
end)
RegisterNetEvent('fivemai:answer', function(sdp) SendNUIMessage({type='answer', sdp=sdp}) end)
RegisterNetEvent('fivemai:error', function(message)
    local text = type(message) == 'string' and message ~= '' and message or 'Erreur serveur sans détail. Consultez la console txAdmin.'
    print('[fivemai] ' .. text)
    SendNUIMessage({type='error', message=text})
end)
RegisterNetEvent('fivemai:closed', function() closeConversation(false) end)
RegisterNUICallback('diagnostic', function(data, cb)
    local text = type(data.message) == 'string' and data.message ~= '' and data.message or 'Diagnostic vide reçu de l’interface vocale.'
    print('[fivemai] ' .. text)
    cb({ok=true})
end)
AddEventHandler('onResourceStop', function(name)
    if name ~= GetCurrentResourceName() then return end
    for _, ped in pairs(peds) do DeleteEntity(ped) end
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

local workingJob = nil
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
RegisterNetEvent('fivemai:jobStart', function(data)
    local ped = currentNpc and currentNpc.id == data.npcId and currentPed or (data.npcNetId and NetToPed(data.npcNetId) or peds[data.npcId])
    local vehicle = NetworkDoesEntityExistWithNetworkId(data.netId) and NetToVeh(data.netId) or 0
    if not ped or not DoesEntityExist(ped) or not DoesEntityExist(vehicle) then
        TriggerServerEvent('fivemai:jobArrived', data.token, false)
        return
    end
    movementSerial = movementSerial + 1
    local job = {token=data.token, ped=ped, vehicle=vehicle, origin=GetEntityCoords(ped), heading=GetEntityHeading(ped), fixed=peds[data.npcId]==ped, serial=movementSerial}
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
            if entityDistance(GetEntityCoords(vehicle), startVehicle) > 0.5 or GetEntitySpeed(vehicle) > 0.3 then failureReason = 'moved' break end
            if atWorkPosition(ped, target, 1.3) then
                mechanicLog('arrivé devant le capot')
                TaskAchieveHeading(ped, heading, 700)
                Wait(700)
                if workingJob ~= job or not DoesEntityExist(vehicle) or entityDistance(GetEntityCoords(vehicle), startVehicle) > 0.5 then break end
                RequestAnimDict('mini@repair')
                local animationDeadline = GetGameTimer() + 1500
                while not HasAnimDictLoaded('mini@repair') and GetGameTimer() < animationDeadline do Wait(50) end
                if workingJob == job and HasAnimDictLoaded('mini@repair') then
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
    ClearPedTasks(job.ped)
    -- Demo peds return to their anchor so their configured server position remains valid.
    if job.fixed then
        CreateThread(function()
            TaskFollowNavMeshToCoord(job.ped, job.origin.x, job.origin.y, job.origin.z, 1.0, 15000, 0.65, 0, job.heading)
            local deadline = GetGameTimer() + 15000
            while movementSerial == job.serial and DoesEntityExist(job.ped) and GetGameTimer() < deadline do
                if atWorkPosition(job.ped, job.origin, 1.3) then
                    FreezeEntityPosition(job.ped, true)
                    return
                end
                Wait(100)
            end
        end)
    end
end)
RegisterNetEvent('fivemai:jobApply', function(data)
    CreateThread(function()
        local vehicle = NetworkDoesEntityExistWithNetworkId(data.netId) and NetToVeh(data.netId) or 0
        local job = workingJob
        local ok = job and job.token == data.token and job.target and currentNpc and currentNpc.id == data.npcId and DoesEntityExist(vehicle) and job.vehicle == vehicle and entityDistance(GetEntityCoords(PlayerPedId()), GetEntityCoords(vehicle)) <= 12
        if ok then
            local deadline = GetGameTimer() + 1500
            while not NetworkHasControlOfEntity(vehicle) and GetGameTimer() < deadline do NetworkRequestControlOfEntity(vehicle) Wait(50) end
            ok = workingJob == job and currentNpc and currentNpc.id == data.npcId and NetworkHasControlOfEntity(vehicle) and job.vehicle == vehicle and entityDistance(GetEntityCoords(PlayerPedId()), GetEntityCoords(vehicle)) <= 12
        end
        if ok then
            ok = DoesEntityExist(job.ped) and atWorkPosition(job.ped, job.target, 1.6) and entityDistance(GetEntityCoords(vehicle), job.vehicleOrigin) <= 0.5 and GetEntitySpeed(vehicle) <= 0.3
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
        else
            ok = false
        end
        mechanicLog(ok and 'intervention appliquée avec succès' or 'intervention refusée : position, contrôle réseau ou véhicule invalidé')
        TriggerServerEvent('fivemai:jobResult', data.token, ok)
    end)
end)

print('[fivemai] Version npc-capture-2 : commande N chargée, personnalisable dans les paramètres FiveM.')
