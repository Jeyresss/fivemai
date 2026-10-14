-- Every task in this file is assigned by the server to one executor. Client
-- observations describe native outcomes; the server alone authorizes consequences.
local config=json.decode(LoadResourceFile(GetCurrentResourceName(),'config.json')) or {}
local routines, policeTasks, restraint={}, {}, nil
local inventoryTask,inventoryReceipts=nil,{}
local function native(name, ...)
    local fn=_G[name]
    if type(fn)=='function' then return fn(...) end
    return nil
end
local function yes(name,...)
    local value=native(name,...)
    return value==true or value==1
end
local function tokenValid(token) return type(token)=='string' and #token>0 and #token<=100 end
local function finite(n) return type(n)=='number' and n==n and n~=math.huge and n~=-math.huge end
local function validCoords(c)
    return type(c)=='table' and finite(c.x) and finite(c.y) and finite(c.z) and math.abs(c.x)<20000 and math.abs(c.y)<20000 and math.abs(c.z)<3000
end
local function distance(a,b)
    local dx,dy,dz=a.x-b.x,a.y-b.y,a.z-b.z
    return math.sqrt(dx*dx+dy*dy+dz*dz)
end
local function nearGround(ped,c,radius)
    local p=GetEntityCoords(ped)
    return (p.x-c.x)^2+(p.y-c.y)^2<=radius^2 and math.abs(p.z-c.z)<=2.0
end
local function resolvePed(netId)
    if type(netId)~='number' or netId<=0 or not NetworkDoesEntityExistWithNetworkId(netId) then return nil end
    local ped=NetToPed(netId)
    if ped~=0 and DoesEntityExist(ped) and IsPedHuman(ped) and not IsPedAPlayer(ped) then return ped end
end
local function control(entity,deadline)
    if not DoesEntityExist(entity) then return false end
    if not NetworkGetEntityIsNetworked(entity) then return true end
    while DoesEntityExist(entity) and not NetworkHasControlOfEntity(entity) and GetGameTimer()<deadline do NetworkRequestControlOfEntity(entity) Wait(50) end
    return DoesEntityExist(entity) and NetworkHasControlOfEntity(entity)
end
local function taskActive(ped,name)
    local status=native('GetScriptTaskStatus',ped,joaat(name))
    return status==0 or status==1
end
local function canClear(ped)
    return DoesEntityExist(ped) and not IsEntityDead(ped) and (not NetworkGetEntityIsNetworked(ped) or NetworkHasControlOfEntity(ped)) and not yes('IsPedInCombat',ped,0) and not yes('IsPedFleeing',ped) and not yes('IsPedRagdoll',ped)
end
local function cancelRoutine(ped,reason)
    local task=routines[ped]
    if not task then return end
    routines[ped]=nil
    if canClear(ped) then ClearPedTasks(ped) end
    TriggerServerEvent('fivemai:routineResult',task.token,false,reason or 'cancelled',{npcNetId=task.npcNetId})
end
FivemAIWorld={
    busy=function(ped) return policeTasks[ped]~=nil end,
    cancelRoutine=cancelRoutine
}
local function routineBusy(ped)
    return policeTasks[ped]~=nil or (FivemAIClient and FivemAIClient.busy and FivemAIClient.busy(ped)) or yes('IsPedInCombat',ped,0) or yes('IsPedFleeing',ped) or yes('IsPedRagdoll',ped)
end
local function routineResult(task,ok,state)
    local p=DoesEntityExist(task.ped) and GetEntityCoords(task.ped) or nil
    TriggerServerEvent('fivemai:routineResult',task.token,ok,state,{npcNetId=task.npcNetId,coords=p and {x=p.x,y=p.y,z=p.z} or nil})
end
RegisterNetEvent('fivemai:routine',function(data)
    if type(data)~='table' or not tokenValid(data.token) then return end
    local ped=resolvePed(data.npcNetId)
    if not ped then TriggerServerEvent('fivemai:routineResult',data.token,false,'unstreamed') return end
    local kind=data.task or data.action
    if kind=='cancel' then
        if routines[ped] and routines[ped].token==data.token then cancelRoutine(ped,'cancelled') end
        return
    end
    if routines[ped] and routines[ped].token==data.token then return end
    if routineBusy(ped) or IsEntityDead(ped) then TriggerServerEvent('fivemai:routineResult',data.token,false,'priority') return end
    cancelRoutine(ped,'superseded')
    local task={token=data.token,npcNetId=data.npcNetId,ped=ped,kind=kind,expires=GetGameTimer()+math.max(1,math.min(300,tonumber(data.durationSeconds) or 45))*1000}
    routines[ped]=task
    CreateThread(function()
        local ok,reason=false,'native'
        local success,err=xpcall(function()
            if not control(ped,GetGameTimer()+1500) then reason='control' return end
            if routines[ped]~=task or routineBusy(ped) then reason='priority' return end
            FreezeEntityPosition(ped,false)
            if kind=='walk' or kind=='go_to' then
                if not validCoords(data.destination) then reason='destination' return end
                local c=data.destination
                TaskFollowNavMeshToCoord(ped,c.x,c.y,c.z,math.max(0.5,math.min(2.5,tonumber(data.speed) or 1.0)),30000,1.0,0,tonumber(c.heading) or 0.0)
                task.destination=c
                local deadline=math.min(task.expires,GetGameTimer()+30000)
                while routines[ped]==task and DoesEntityExist(ped) and GetGameTimer()<deadline do
                    if routineBusy(ped) then reason='priority' return end
                    if nearGround(ped,c,1.8) then ok=true reason='arrived' break end
                    Wait(200)
                end
                if not ok then reason='path' end
            elseif kind=='idle' or kind=='wait' or kind=='rest' then
                TaskStandStill(ped,task.expires-GetGameTimer()) Wait(300)
                ok=taskActive(ped,'SCRIPT_TASK_STAND_STILL') reason='standing'
            elseif kind=='wander' then
                TaskWanderStandard(ped,10.0,10) Wait(300)
                ok=taskActive(ped,'SCRIPT_TASK_WANDER_STANDARD') reason='wandering'
            elseif kind=='scenario' or kind=='work' or kind=='eat' then
                -- Scenario names come from the server's bounded schedule configuration.
                local scenario=data.scenario
                if type(scenario)~='string' or #scenario>80 or not scenario:match('^[A-Z0-9_]+$') then reason='scenario' return end
                TaskStartScenarioInPlace(ped,scenario,0,true) Wait(700)
                ok=yes('IsPedUsingScenario',ped,scenario) reason='scenario'
            elseif kind=='drive' then
                if not validCoords(data.destination) then reason='destination' return end
                local vehicle=GetVehiclePedIsIn(ped,false)
                if vehicle==0 or not DoesEntityExist(vehicle) or GetPedInVehicleSeat(vehicle,-1)~=ped or not control(vehicle,GetGameTimer()+1500) then reason='vehicle' return end
                if data.vehicleNetId and NetworkGetNetworkIdFromEntity(vehicle)~=data.vehicleNetId then reason='vehicle' return end
                local c=data.destination
                TaskVehicleDriveToCoordLongrange(ped,vehicle,c.x,c.y,c.z,math.max(2.0,math.min(20.0,tonumber(data.speed) or 12.0)),786603,8.0)
                Wait(500) ok=taskActive(ped,'SCRIPT_TASK_VEHICLE_DRIVE_TO_COORD_LONGRANGE') reason='driving'
                task.vehicle,task.destination=vehicle,c
            else reason='unsupported' end
        end,function(e)return tostring(e)end)
        if not success then print('[fivemai] Routine : '..tostring(err)) ok=false reason='script' end
        if routines[ped]~=task then return end
        routineResult(task,ok,reason)
        if not ok then routines[ped]=nil if canClear(ped) then ClearPedTasks(ped) end
        elseif kind=='walk' or kind=='go_to' then routines[ped]=nil end
    end)
end)
RegisterNetEvent('fivemai:routineCancel',function(data)
    if type(data)~='table' then return end
    for ped,task in pairs(routines) do if task.token==data.token then cancelRoutine(ped,'cancelled') return end end
end)

local function targetPed(task)
    local index=GetPlayerFromServerId(task.targetServerId)
    if index==-1 then return nil end
    local ped=GetPlayerPed(index)
    return ped~=0 and DoesEntityExist(ped) and IsPedAPlayer(ped) and ped or nil
end
local function policeEvidence(task,target)
    local data={npcNetId=task.npcNetId,targetServerId=task.targetServerId,evidenceId=task.evidenceId}
    if DoesEntityExist(task.ped) and target and DoesEntityExist(target) then
        local p,t=GetEntityCoords(task.ped),GetEntityCoords(target)
        data.distance=distance(p,t) data.coords={x=p.x,y=p.y,z=p.z} data.targetCoords={x=t.x,y=t.y,z=t.z}
        data.targetSpeed=GetEntitySpeed(target) data.targetInVehicle=yes('IsPedInAnyVehicle',target,false)
    end
    return data
end
local function policeResult(task,ok,state,target)
    TriggerServerEvent('fivemai:policeResult',task.token,ok,state,policeEvidence(task,target))
end
local function stopPolice(task,reason,report)
    if policeTasks[task.ped]~=task then return end
    policeTasks[task.ped]=nil
    if task.vehicle and DoesEntityExist(task.vehicle) and NetworkHasControlOfEntity(task.vehicle) then SetVehicleSiren(task.vehicle,false) end
    if canClear(task.ped) then ClearPedTasks(task.ped) SetBlockingOfNonTemporaryEvents(task.ped,false) end
    if report then policeResult(task,false,reason,targetPed(task)) end
end
local function approach(task,target,range,seconds)
    TaskGoToEntity(task.ped,target,seconds*1000,range,1.7,1073741824,0)
    local deadline=GetGameTimer()+seconds*1000
    while policeTasks[task.ped]==task and DoesEntityExist(task.ped) and DoesEntityExist(target) and GetGameTimer()<deadline do
        if IsEntityDead(task.ped) or IsEntityDead(target) then return false,'dead' end
        if not NetworkHasControlOfEntity(task.ped) then return false,'control' end
        if distance(GetEntityCoords(task.ped),GetEntityCoords(target))<=range+0.25 then return true end
        Wait(100)
    end
    return false,'path'
end
local function play(task,dict,anim,duration)
    RequestAnimDict(dict)
    local deadline=GetGameTimer()+2500
    while not HasAnimDictLoaded(dict) and GetGameTimer()<deadline do Wait(50) end
    if policeTasks[task.ped]~=task or not HasAnimDictLoaded(dict) then return false end
    TaskPlayAnim(task.ped,dict,anim,4.0,-4.0,duration,48,0,false,false,false)
    Wait(300)
    return yes('IsEntityPlayingAnim',task.ped,dict,anim,3)
end
RegisterNetEvent('fivemai:policeTask',function(data)
    if type(data)~='table' or not tokenValid(data.token) or not tonumber(data.targetServerId) then return end
    local ped=resolvePed(data.npcNetId)
    if not ped then TriggerServerEvent('fivemai:policeResult',data.token,false,'unstreamed') return end
    if data.action=='release' or data.action=='cancel' then
        if policeTasks[ped] and policeTasks[ped].token==data.token then stopPolice(policeTasks[ped],'released',true) end
        return
    end
    if policeTasks[ped] and policeTasks[ped].token==data.token then return end
    if FivemAIClient and FivemAIClient.working and FivemAIClient.working(ped) then TriggerServerEvent('fivemai:policeResult',data.token,false,'priority') return end
    cancelRoutine(ped,'police')
    if policeTasks[ped] then stopPolice(policeTasks[ped],'superseded',false) end
    local task={token=data.token,npcNetId=data.npcNetId,ped=ped,targetServerId=tonumber(data.targetServerId),evidenceId=data.evidenceId,action=data.action,expires=GetGameTimer()+math.max(5,math.min(180,tonumber(data.durationSeconds) or 45))*1000}
    policeTasks[ped]=task
    CreateThread(function()
        local ok,state=false,'native'
        local target=targetPed(task)
        local success,err=xpcall(function()
            if not target or IsEntityDead(target) or IsEntityDead(ped) then state='gone' return end
            if not control(ped,GetGameTimer()+1800) then state='control' return end
            if policeTasks[ped]~=task then return end
            FreezeEntityPosition(ped,false) SetBlockingOfNonTemporaryEvents(ped,true)
            if task.action=='challenge' then
                ok,state=approach(task,target,3.0,12)
                if ok then TaskTurnPedToFaceEntity(ped,target,700) TaskLookAtEntity(ped,target,3000,2048,3) state='challenged' end
            elseif task.action=='pursuit' then
                local vehicle=GetVehiclePedIsIn(ped,false)
                if vehicle~=0 and GetPedInVehicleSeat(vehicle,-1)==ped then
                    if not control(vehicle,GetGameTimer()+1500) then state='control' return end
                    TaskVehicleChase(ped,target) SetVehicleSiren(vehicle,true) task.vehicle=vehicle
                    Wait(500) ok=taskActive(ped,'SCRIPT_TASK_VEHICLE_CHASE')
                else
                    TaskGoToEntity(ped,target,-1,2.5,3.0,1073741824,0)
                    Wait(500) ok=taskActive(ped,'SCRIPT_TASK_GO_TO_ENTITY')
                end
                state='pursuing' task.nextRetask=GetGameTimer()+1500
            elseif task.action=='cuff' or task.action=='arrest' then
                if yes('IsPedInAnyVehicle',target,false) or GetEntitySpeed(target)>1.5 then state='resisting' return end
                ok,state=approach(task,target,1.7,12)
                if not ok then return end
                if GetEntitySpeed(target)>1.5 or yes('IsPedRagdoll',target) then ok=false state='resisting' return end
                TaskTurnPedToFaceEntity(ped,target,500) Wait(500)
                ok=play(task,'mp_arrest_paired','cop_p2_back_left',3000)
                if ok then
                    Wait(1800)
                    ok=policeTasks[ped]==task and DoesEntityExist(target) and distance(GetEntityCoords(ped),GetEntityCoords(target))<=2.5 and GetEntitySpeed(target)<=1.5
                end
                -- Target-side restraint is a separate server-authorized event and ack.
                state=ok and 'restraint_ready' or 'resisting'
            elseif task.action=='search' then
                ok,state=approach(task,target,1.7,10)
                if not ok then return end
                if GetEntitySpeed(target)>0.5 or yes('IsPedInAnyVehicle',target,false) then ok=false state='resisting' return end
                TaskTurnPedToFaceEntity(ped,target,400) Wait(400)
                ok=play(task,'anim@gangops@facility@servers@bodysearch@','player_search',3500)
                if ok then Wait(2200) ok=policeTasks[ped]==task and DoesEntityExist(target) and distance(GetEntityCoords(ped),GetEntityCoords(target))<=2.5 and GetEntitySpeed(target)<=0.5 end
                state=ok and 'searched' or 'resisting'
            else state='unsupported' end
        end,function(e)return tostring(e)end)
        if not success then print('[fivemai] Police : '..tostring(err)) ok=false state='script' end
        if policeTasks[ped]~=task then return end
        policeResult(task,ok,state,target)
        if not ok then stopPolice(task,state,false) else task.started=true end
    end)
end)
RegisterNetEvent('fivemai:policeCancel',function(data)
    if type(data)~='table' then return end
    for _,task in pairs(policeTasks) do if task.token==data.token then stopPolice(task,'cancelled',true) return end end
end)

local function removeRestraint(reason,report)
    local active=restraint
    if not active then return end
    restraint=nil
    local ped=PlayerPedId()
    SetEnableHandcuffs(ped,false) native('SetPedCanPlayGestureAnims',ped,true)
    if yes('IsEntityPlayingAnim',ped,'mp_arresting','idle',3) then StopAnimTask(ped,'mp_arresting','idle',-4.0) end
    if report then TriggerServerEvent('fivemai:policeRestraintResult',active.token,true,reason or 'released') end
end
RegisterNetEvent('fivemai:policeRestraint',function(data)
    if type(data)~='table' or not tokenValid(data.token) then return end
    if data.enabled==false then if restraint and restraint.token==data.token then removeRestraint('released',true) end return end
    if restraint and restraint.token==data.token then return end
    if restraint then removeRestraint('superseded',true) end
    local ped=PlayerPedId()
    if IsEntityDead(ped) or yes('IsPedInAnyVehicle',ped,false) or GetEntitySpeed(ped)>1.5 then TriggerServerEvent('fivemai:policeRestraintResult',data.token,false,'resisting') return end
    restraint={token=data.token,expires=GetGameTimer()+math.max(1,math.min(180,tonumber(data.durationSeconds) or 30))*1000,confirmed=false}
    local active=restraint
    CreateThread(function()
        local success,err=xpcall(function()
            RequestAnimDict('mp_arresting')
            local deadline=GetGameTimer()+2500
            while restraint==active and not HasAnimDictLoaded('mp_arresting') and GetGameTimer()<deadline do Wait(50) end
            if restraint~=active then return end
            if not HasAnimDictLoaded('mp_arresting') then TriggerServerEvent('fivemai:policeRestraintResult',active.token,false,'animation') removeRestraint('failed',false) return end
            SetEnableHandcuffs(ped,true) native('SetPedCanPlayGestureAnims',ped,false)
            TaskPlayAnim(ped,'mp_arresting','idle',4.0,-4.0,-1,49,0,false,false,false) Wait(300)
            if restraint~=active then return end
            active.confirmed=yes('IsPedCuffed',ped) and yes('IsEntityPlayingAnim',ped,'mp_arresting','idle',3)
            TriggerServerEvent('fivemai:policeRestraintResult',active.token,active.confirmed,active.confirmed and 'cuffed' or 'animation')
            if not active.confirmed then removeRestraint('failed',false) end
        end,function(e)return tostring(e)end)
        if not success and restraint==active then print('[fivemai] Menottes : '..tostring(err)) TriggerServerEvent('fivemai:policeRestraintResult',active.token,false,'script') removeRestraint('failed',false) end
    end)
end)

local function inventoryResult(task,ok,evidence)
    if inventoryTask~=task then return end
    inventoryTask=nil
    inventoryReceipts[task.token]={ok=ok,at=GetGameTimer()}
    TriggerServerEvent('fivemai:inventoryResult',task.token,ok,evidence)
end
RegisterNetEvent('fivemai:inventoryEffect',function(data)
    if type(data)~='table' or not tokenValid(data.token) then return end
    if inventoryReceipts[data.token] then TriggerServerEvent('fivemai:inventoryResult',data.token,inventoryReceipts[data.token].ok) return end
    if inventoryTask then
        if inventoryTask.token~=data.token then TriggerServerEvent('fivemai:inventoryResult',data.token,false) end
        return
    end
    local task={token=data.token,expires=GetGameTimer()+8000,ped=PlayerPedId()}
    inventoryTask=task
    CreateThread(function()
        local success,err=xpcall(function()
            local ped=task.ped
            if IsEntityDead(ped) or yes('IsPedRagdoll',ped) or restraint then inventoryResult(task,false) return end
            if data.effect=='heal' then
                local target=tonumber(data.targetHealth)
                local maximum=math.min(200,tonumber(native('GetEntityMaxHealth',ped)) or 200)
                if not finite(target) or target~=math.floor(target) or target<=0 or target>maximum then inventoryResult(task,false) return end
                RequestAnimDict('mp_player_intdrink')
                local deadline=GetGameTimer()+2000
                while inventoryTask==task and not HasAnimDictLoaded('mp_player_intdrink') and GetGameTimer()<deadline do Wait(50) end
                if inventoryTask~=task then return end
                if not HasAnimDictLoaded('mp_player_intdrink') then inventoryResult(task,false) return end
                TaskPlayAnim(ped,'mp_player_intdrink','loop_bottle',4.0,-4.0,1300,49,0,false,false,false)
                Wait(250)
                if inventoryTask~=task then return end
                if not yes('IsEntityPlayingAnim',ped,'mp_player_intdrink','loop_bottle',3) then inventoryResult(task,false) return end
                Wait(800)
                if inventoryTask~=task then return end
                if GetGameTimer()>=task.expires or IsEntityDead(ped) or PlayerPedId()~=ped then inventoryResult(task,false) return end
                SetEntityHealth(ped,math.max(GetEntityHealth(ped),target))
                inventoryResult(task,GetEntityHealth(ped)>=target,{health=GetEntityHealth(ped)})
            elseif data.effect=='repair' then
                local vehicle=GetVehiclePedIsIn(ped,false)
                local minimum=tonumber(data.minimumEngineHealth) or 900
                if not finite(minimum) or minimum<0 or minimum>1000 or vehicle==0 or not DoesEntityExist(vehicle) or not data.vehicleNetId or NetworkGetNetworkIdFromEntity(vehicle)~=data.vehicleNetId or GetEntitySpeed(vehicle)>0.5 then inventoryResult(task,false) return end
                if not control(vehicle,GetGameTimer()+2000) then inventoryResult(task,false) return end
                if inventoryTask~=task then return end
                if GetGameTimer()>=task.expires or GetVehiclePedIsIn(PlayerPedId(),false)~=vehicle or PlayerPedId()~=ped or GetEntitySpeed(vehicle)>0.5 then inventoryResult(task,false) return end
                SetVehicleEngineHealth(vehicle,math.max(GetVehicleEngineHealth(vehicle),minimum))
                SetVehicleBodyHealth(vehicle,math.max(GetVehicleBodyHealth(vehicle),math.min(900,minimum)))
                inventoryResult(task,GetVehicleEngineHealth(vehicle)>=minimum,{vehicleNetId=data.vehicleNetId,engineHealth=GetVehicleEngineHealth(vehicle)})
            else inventoryResult(task,false) end
        end,function(e)return tostring(e)end)
        if not success and inventoryTask==task then print('[fivemai] Objet : '..tostring(err)) inventoryResult(task,false) end
    end)
end)
RegisterNetEvent('fivemai:inventoryCancel',function(data)
    local token=type(data)=='table' and data.token or data
    if inventoryTask and inventoryTask.token==token then
        local ped=inventoryTask.ped
        inventoryTask=nil
        if yes('IsEntityPlayingAnim',ped,'mp_player_intdrink','loop_bottle',3) then StopAnimTask(ped,'mp_player_intdrink','loop_bottle',-4.0) end
    end
end)

-- Damage telemetry is bounded and explicitly untrusted; it cannot establish an
-- arrest, confiscation or fine. Server adapters must corroborate every allegation.
local incidentCredits,incidentAt,incidentSeen=6,0,{}
AddEventHandler('gameEventTriggered',function(name,args)
    if name~='CEventNetworkEntityDamage' or type(args)~='table' then return end
    local victim,actor=args[1],args[2]
    if type(victim)~='number' or type(actor)~='number' or not DoesEntityExist(victim) or not DoesEntityExist(actor) then return end
    if not yes('IsEntityAPed',victim) or not NetworkGetEntityIsNetworked(victim) then return end
    local now=GetGameTimer()
    incidentCredits=math.min(6,incidentCredits+math.max(0,now-incidentAt)/5000) incidentAt=now
    local key=tostring(victim)..':'..tostring(actor)
    if incidentCredits<1 or now-(incidentSeen[key] or -2000)<2000 then return end
    local vehicle=yes('IsEntityAVehicle',actor) and actor or nil
    if vehicle then actor=GetPedInVehicleSeat(vehicle,-1) end
    if actor==0 or not DoesEntityExist(actor) then return end
    local source=IsPedAPlayer(actor) and native('NetworkGetPlayerIndexFromPed',actor) or nil
    local actorServerId=source and source~=-1 and GetPlayerServerId(source) or nil
    if distance(GetEntityCoords(PlayerPedId()),GetEntityCoords(victim))>60 then return end
    incidentCredits=incidentCredits-1 incidentSeen[key]=now
    TriggerServerEvent('fivemai:perception',{kind=vehicle and 'collision' or 'injury',victimNetId=NetworkGetNetworkIdFromEntity(victim),actorNetId=NetworkGetEntityIsNetworked(actor) and NetworkGetNetworkIdFromEntity(actor) or nil,actorServerId=actorServerId,vehicleNetId=vehicle and NetworkGetNetworkIdFromEntity(vehicle) or nil,health=GetEntityHealth(victim),fatal=IsEntityDead(victim)})
    for stored,at in pairs(incidentSeen) do if now-at>15000 then incidentSeen[stored]=nil end end
end)

CreateThread(function()
    while true do
        Wait(200)
        local now=GetGameTimer()
        if inventoryTask and now>=inventoryTask.expires then inventoryResult(inventoryTask,false) end
        for token,receipt in pairs(inventoryReceipts) do if now-receipt.at>60000 then inventoryReceipts[token]=nil end end
        for ped,task in pairs(routines) do
            if not DoesEntityExist(ped) or IsEntityDead(ped) then cancelRoutine(ped,'gone')
            elseif routineBusy(ped) then cancelRoutine(ped,'priority')
            elseif NetworkGetEntityIsNetworked(ped) and not NetworkHasControlOfEntity(ped) then cancelRoutine(ped,'control')
            elseif now>=task.expires then
                routines[ped]=nil if canClear(ped) then ClearPedTasks(ped) end routineResult(task,true,'completed')
            elseif task.vehicle and (not DoesEntityExist(task.vehicle) or GetPedInVehicleSeat(task.vehicle,-1)~=ped) then cancelRoutine(ped,'vehicle')
            elseif task.vehicle and task.destination and distance(GetEntityCoords(task.vehicle),task.destination)<=8 and GetEntitySpeed(task.vehicle)<=1.0 then routines[ped]=nil TaskVehicleTempAction(ped,task.vehicle,27,1500) routineResult(task,true,'arrived') end
        end
        for _,task in pairs(policeTasks) do
            local target=targetPed(task)
            if not target or not DoesEntityExist(task.ped) or IsEntityDead(task.ped) or IsEntityDead(target) then stopPolice(task,'gone',true)
            elseif now>=task.expires then stopPolice(task,'expired',true)
            elseif NetworkGetEntityIsNetworked(task.ped) and not NetworkHasControlOfEntity(task.ped) then stopPolice(task,'control',true)
            elseif task.started and task.action=='pursuit' and now>=(task.nextRetask or 0) then
                task.nextRetask=now+1500
                if not task.vehicle then TaskGoToEntity(task.ped,target,-1,2.5,3.0,1073741824,0) end
                TriggerServerEvent('fivemai:policeProgress',task.token,distance(GetEntityCoords(task.ped),GetEntityCoords(target))<=3 and 'caught_up' or 'pursuing',policeEvidence(task,target))
            end
        end
        if restraint then
            if IsEntityDead(PlayerPedId()) then removeRestraint('dead',true)
            elseif now>=restraint.expires then removeRestraint('expired',true)
            elseif restraint.confirmed and not yes('IsPedCuffed',PlayerPedId()) then removeRestraint('interrupted',true) end
        end
    end
end)
CreateThread(function()
    while true do
        Wait(restraint and 0 or 200)
        if restraint and restraint.confirmed then
            -- The native handcuff state and animation are observable; controls are
            -- blocked locally only for the bounded server-authorized restraint.
            for _,controlId in ipairs({21,22,24,25,37,44,45,75,140,141,142,143,257,263,264}) do DisableControlAction(0,controlId,true) end
            DisablePlayerFiring(PlayerId(),true)
            if not yes('IsPedRagdoll',PlayerPedId()) and not yes('IsEntityPlayingAnim',PlayerPedId(),'mp_arresting','idle',3) then TaskPlayAnim(PlayerPedId(),'mp_arresting','idle',4.0,-4.0,-1,49,0,false,false,false) end
        end
    end
end)
AddEventHandler('onResourceStop',function(name)
    if name~=GetCurrentResourceName() then return end
    for ped in pairs(routines) do cancelRoutine(ped,'resource_stopped') end
    for _,task in pairs(policeTasks) do stopPolice(task,'resource_stopped',false) end
    removeRestraint('resource_stopped',false)
    inventoryTask=nil inventoryReceipts={}
end)
