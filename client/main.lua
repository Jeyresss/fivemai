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
RegisterCommand('parlerpnj', function()
    if talking then return end
    local pos = GetEntityCoords(PlayerPedId())
    local nearest, best = nil, config.interactionDistance
    for _, npc in ipairs(config.npcs) do
        local ped = peds[npc.id]
        if ped and DoesEntityExist(ped) then
            local d = #(pos - GetEntityCoords(ped))
            if d < best then nearest, best = npc, d end
        end
    end
    if not nearest then
        TriggerEvent('chat:addMessage', { args = {'PNJ', 'Approchez-vous d’un PNJ configuré.'} })
        return
    end
    talking = true
    SetNuiFocus(true, true)
    SendNUIMessage({type='open', npc={id=nearest.id, name=nearest.firstName .. ' ' .. nearest.lastName, job=nearest.job}})
end, false)
RegisterKeyMapping('parlerpnj', 'Parler au PNJ proche', 'keyboard', 'E')
RegisterNUICallback('offer', function(data, cb)
    TriggerServerEvent('fivemai:offer', data.npcId, data.sdp)
    cb({ok=true})
end)
RegisterNUICallback('close', function(_, cb)
    talking = false
    SetNuiFocus(false, false)
    TriggerServerEvent('fivemai:stop')
    cb({ok=true})
end)
RegisterNetEvent('fivemai:answer', function(sdp) SendNUIMessage({type='answer', sdp=sdp}) end)
RegisterNetEvent('fivemai:error', function(message) SendNUIMessage({type='error', message=message}) end)
RegisterNetEvent('fivemai:closed', function()
    talking = false
    SetNuiFocus(false, false)
    SendNUIMessage({type='closed'})
end)
AddEventHandler('onResourceStop', function(name)
    if name ~= GetCurrentResourceName() then return end
    SetNuiFocus(false, false)
    for _, ped in pairs(peds) do DeleteEntity(ped) end
end)
