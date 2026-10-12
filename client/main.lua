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
local currentNpc = nil
local pressed = false
local function nearestNpc()
    local pos = GetEntityCoords(PlayerPedId())
    local nearest, best = nil, config.interactionDistance
    for _, npc in ipairs(config.npcs) do
        local ped = peds[npc.id]
        if ped and DoesEntityExist(ped) then
            local d = #(pos - GetEntityCoords(ped))
            if d < best then nearest, best = npc, d end
        end
    end
    return nearest
end
RegisterCommand('+fivemai_talk', function()
    if pressed then return end
    local nearest = nearestNpc()
    if not nearest then return end
    if currentNpc and currentNpc.id ~= nearest.id then return end
    pressed = true
    if not talking then
        talking = true
        currentNpc = nearest
        SendNUIMessage({type='open', npc={id=nearest.id, name=nearest.firstName .. ' ' .. nearest.lastName}})
    end
    SendNUIMessage({type='ptt', held=true})
end, false)
RegisterCommand('-fivemai_talk', function()
    pressed = false
    SendNUIMessage({type='ptt', held=false})
end, false)
RegisterKeyMapping('+fivemai_talk', 'Maintenir pour parler au PNJ (IA)', 'keyboard', 'N')
CreateThread(function()
    while true do
        Wait(500)
        if currentNpc then
            local ped = peds[currentNpc.id]
            if not ped or not DoesEntityExist(ped) or #(GetEntityCoords(PlayerPedId()) - GetEntityCoords(ped)) > config.interactionDistance + 1 then
                talking, pressed, currentNpc = false, false, nil
                SendNUIMessage({type='closed'})
                TriggerServerEvent('fivemai:stop')
            end
        end
    end
end)
RegisterNUICallback('offer', function(data, cb)
    TriggerServerEvent('fivemai:offer', data.npcId, data.sdp)
    cb({ok=true})
end)
RegisterNUICallback('close', function(_, cb)
    talking, pressed, currentNpc = false, false, nil
    TriggerServerEvent('fivemai:stop')
    cb({ok=true})
end)
RegisterNetEvent('fivemai:answer', function(sdp) SendNUIMessage({type='answer', sdp=sdp}) end)
RegisterNetEvent('fivemai:error', function(message) SendNUIMessage({type='error', message=message}) end)
RegisterNetEvent('fivemai:closed', function()
    talking, pressed, currentNpc = false, false, nil
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
