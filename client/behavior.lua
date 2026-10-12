FivemAIBehavior = {held={}, controlAttempts={}}
local function flag(name, ...)
    local fn = _G[name]
    return type(fn) == 'function' and fn(...) or false
end
function FivemAIBehavior.observe(ped, player)
    if flag('IsPedFleeing', ped) or flag('IsPedRagdoll', ped) or flag('IsPedBeingStunned', ped, 0) then return 'afraid' end
    if flag('IsPedInCombat', ped, player) then return 'angry' end
    if flag('IsPedInCombat', ped, 0) or flag('IsPedInMeleeCombat', ped) then return 'combat' end
    return 'calm'
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
    local state = FivemAIBehavior.observe(ped, player)
    if state ~= 'calm' or not close or working then
        FivemAIBehavior.release(ped, not working and state == 'calm', fixed)
        return state
    end
    if NetworkGetEntityIsNetworked(ped) and not flag('NetworkHasControlOfEntity', ped) then
        local now = GetGameTimer()
        if now - (FivemAIBehavior.controlAttempts[ped] or -1000) >= 500 then
            FivemAIBehavior.controlAttempts[ped] = now
            if type(NetworkRequestControlOfEntity) == 'function' then NetworkRequestControlOfEntity(ped) end
        end
        return state
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
    return state
end
