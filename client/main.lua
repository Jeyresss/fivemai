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
local function nearestNpc()
    local pos = GetEntityCoords(PlayerPedId())
    local nearest, best = nil, config.interactionDistance
    for _, ped in ipairs(GetGamePool('CPed')) do
        if DoesEntityExist(ped) and not IsPedAPlayer(ped) and IsPedHuman(ped) and not IsEntityDead(ped) then
            local d = #(pos - GetEntityCoords(ped))
            if d < best then
                local fixedId = nil
                for id, fixedPed in pairs(peds) do if fixedPed == ped then fixedId = id break end end
                if fixedId or config.ambientNPCs then nearest, best = {ped=ped, id=fixedId}, d end
            end
        end
    end
    return nearest
end
local function closeConversation()
    talking, pressed, currentNpc, currentPed, candidate = false, false, nil, nil, nil
    SendNUIMessage({type='closed'})
    TriggerServerEvent('fivemai:stop')
end
RegisterCommand('+fivemai_talk', function()
    if pressed then return end
    local nearest = nearestNpc()
    if not nearest then return end
    if currentNpc and currentPed ~= nearest.ped then closeConversation() end
    pressed = true
    if not talking then
        talking, candidate = true, nearest
        CreateThread(function()
            local target = {id=nearest.id}
            if not nearest.id then
                if not NetworkGetEntityIsNetworked(nearest.ped) then NetworkRegisterEntityAsNetworked(nearest.ped) end
                local deadline = GetGameTimer() + 1500
                while DoesEntityExist(nearest.ped) and not NetworkGetEntityIsNetworked(nearest.ped) and GetGameTimer() < deadline do Wait(50) end
                if not DoesEntityExist(nearest.ped) or not NetworkGetEntityIsNetworked(nearest.ped) then
                    print('[fivemai] Ce PNJ ne peut pas être synchronisé avec le serveur.')
                    closeConversation()
                    return
                end
                target.netId = NetworkGetNetworkIdFromEntity(nearest.ped)
            end
            if candidate ~= nearest then return end
            TriggerServerEvent('fivemai:resolve', target)
            SetTimeout(5000, function()
                if candidate == nearest and not currentNpc then
                    print('[fivemai] Résolution du profil expirée.')
                    closeConversation()
                end
            end)
        end)
    else
        SendNUIMessage({type='ptt', held=true})
    end
end, false)
RegisterCommand('-fivemai_talk', function()
    pressed = false
    SendNUIMessage({type='ptt', held=false})
end, false)
RegisterNetEvent('fivemai:profile', function(profile)
    if not talking or not candidate then return end
    currentNpc, currentPed = profile, candidate.ped
    candidate = nil
    SendNUIMessage({type='open', microphone=GetResourceKvpString('fivemai_microphone'), npc={id=profile.id, name=profile.firstName .. ' ' .. profile.lastName}})
    SendNUIMessage({type='ptt', held=pressed})
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
            local distance = #(GetEntityCoords(PlayerPedId()) - coords)
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
    talking, pressed, currentNpc, currentPed, candidate = false, false, nil, nil, nil
    TriggerServerEvent('fivemai:stop')
    cb({ok=true})
end)
RegisterNetEvent('fivemai:answer', function(sdp) SendNUIMessage({type='answer', sdp=sdp}) end)
RegisterNetEvent('fivemai:error', function(message) SendNUIMessage({type='error', message=message}) end)
RegisterNetEvent('fivemai:closed', function()
    talking, pressed, currentNpc, currentPed, candidate = false, false, nil, nil, nil
    SendNUIMessage({type='closed'})
end)
RegisterNUICallback('diagnostic', function(data, cb)
    print('[fivemai] ' .. tostring(data.message))
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
RegisterNUICallback('microphone', function(data, cb)
    if type(data.deviceId) == 'string' and #data.deviceId < 512 then
        SetResourceKvp('fivemai_microphone', data.deviceId)
        closeConversation()
        print('[fivemai] Micro sélectionné : ' .. tostring(data.label) .. '. Relâchez puis maintenez votre touche pour reconnecter.')
    end
    cb({ok=true})
end)

local workingPed = nil
RegisterNetEvent('fivemai:jobStart', function(data)
    local ped = data.npcNetId and NetToPed(data.npcNetId) or peds[data.npcId]
    if not ped or not DoesEntityExist(ped) then return end
    workingPed = ped
    CreateThread(function()
        RequestAnimDict('mini@repair')
        local deadline = GetGameTimer() + 1500
        while not HasAnimDictLoaded('mini@repair') and GetGameTimer() < deadline do Wait(50) end
        if workingPed == ped and HasAnimDictLoaded('mini@repair') and (not NetworkGetEntityIsNetworked(ped) or NetworkHasControlOfEntity(ped)) then
            TaskPlayAnim(ped, 'mini@repair', 'fixing_a_ped', 3.0, -3.0, -1, 1, 0, false, false, false)
        end
    end)
end)
RegisterNetEvent('fivemai:jobEnd', function()
    if workingPed and DoesEntityExist(workingPed) then StopAnimTask(workingPed, 'mini@repair', 'fixing_a_ped', 1.0) end
    workingPed = nil
end)
RegisterNetEvent('fivemai:jobApply', function(data)
    CreateThread(function()
        local vehicle = NetworkDoesEntityExistWithNetworkId(data.netId) and NetToVeh(data.netId) or 0
        local player = PlayerPedId()
        local ok = currentNpc and currentNpc.id == data.npcId and DoesEntityExist(vehicle) and GetPedInVehicleSeat(vehicle, -1) == player
        if ok then
            local deadline = GetGameTimer() + 1500
            while not NetworkHasControlOfEntity(vehicle) and GetGameTimer() < deadline do NetworkRequestControlOfEntity(vehicle) Wait(50) end
            ok = currentNpc and currentNpc.id == data.npcId and NetworkHasControlOfEntity(vehicle) and GetPedInVehicleSeat(vehicle, -1) == player
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
        TriggerServerEvent('fivemai:jobResult', data.token, ok)
    end)
end)
