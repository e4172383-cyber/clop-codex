--[[
	Clop Codex — плагин связи Roblox Studio с приложением.

	Плагин сам ходит к приложению на 127.0.0.1: Студия наружу ничего не
	слушает, зато запросы из плагина разрешены. Порт и секрет подставлены при
	установке, руками ничего вводить не нужно.

	Плагин не исполняет произвольный Luau (в плагинах нет loadstring) —
	приложение присылает разобранные действия: создать объект, изменить
	свойства, положить скрипт, показать дерево. Каждое изменение отмечается в
	истории, поэтому Ctrl+Z работает как обычно.

	Имена в коде латиницей не по привычке: Luau не допускает кириллицу в
	именах переменных — такой файл просто не компилируется. Текст, который
	видит человек, при этом остаётся русским.
]]

local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Selection = game:GetService("Selection")
local StudioService = game:GetService("StudioService")

local BASE = "http://127.0.0.1:__CLOP_PORT__"
local TOKEN = "__CLOP_TOKEN__"

local connected = false

local toolbar = plugin:CreateToolbar("Clop Codex")
local button = toolbar:CreateButton("Clop Codex", "Связь с приложением Clop Codex", "rbxasset://textures/ui/common/robux.png")
button.ClickableWhenViewportHidden = true

local function say(text)
	print("[Clop Codex] " .. text)
end

---------------------------------------------------------------- значения

--[[ Свойства приходят простыми значениями либо помеченными списками:
	{"Vector3", 4, 1, 2}, {"Color3", 255, 80, 0}, {"Enum", "Material", "Neon"}.
	Так модель не гадает, какие три числа цвет, а какие размер. ]]
local function toValue(v)
	if typeof(v) == "table" then
		local kind = v[1]
		if kind == "Vector3" then return Vector3.new(v[2] or 0, v[3] or 0, v[4] or 0)
		elseif kind == "Vector2" then return Vector2.new(v[2] or 0, v[3] or 0)
		elseif kind == "Color3" then return Color3.fromRGB(v[2] or 0, v[3] or 0, v[4] or 0)
		elseif kind == "UDim2" then return UDim2.new(v[2] or 0, v[3] or 0, v[4] or 0, v[5] or 0)
		elseif kind == "UDim" then return UDim.new(v[2] or 0, v[3] or 0)
		elseif kind == "CFrame" then return CFrame.new(v[2] or 0, v[3] or 0, v[4] or 0)
		elseif kind == "BrickColor" then return BrickColor.new(v[2])
		elseif kind == "Enum" then
			local family = Enum[v[2]]
			return family and family[v[3]] or nil
		end
	end
	return v
end

local function fromValue(v)
	local t = typeof(v)
	if t == "Vector3" then return string.format("Vector3(%.3g, %.3g, %.3g)", v.X, v.Y, v.Z)
	elseif t == "Color3" then return string.format("Color3(%d, %d, %d)", math.floor(v.R * 255 + 0.5), math.floor(v.G * 255 + 0.5), math.floor(v.B * 255 + 0.5))
	elseif t == "EnumItem" then return tostring(v)
	elseif t == "Instance" then return v:GetFullName()
	elseif t == "CFrame" then
		local p = v.Position
		return string.format("CFrame(%.3g, %.3g, %.3g)", p.X, p.Y, p.Z)
	end
	return tostring(v)
end

---------------------------------------------------------------- пути

--[[ Путь вида "Workspace.Дом.Дверь". Ищем по имени, потому что модель видит
	дерево именно именами; слово game впереди необязательно. ]]
local function locate(path)
	if path == nil or path == "" or path == "game" then return game end
	local node = game
	for piece in string.gmatch(path, "[^%.]+") do
		if piece ~= "game" then
			local nxt = node:FindFirstChild(piece)
			if nxt == nil then
				-- Службы могут быть ещё не в дереве, но доступны по имени
				local ok, service = pcall(function() return game:GetService(piece) end)
				nxt = ok and service or nil
			end
			if nxt == nil then
				return nil, "не найдено: " .. path .. " (нет «" .. piece .. "»)"
			end
			node = nxt
		end
	end
	return node
end

---------------------------------------------------------------- действия

local KEEP = { "Camera", "Terrain" }
local function isKept(name)
	for _, x in ipairs(KEEP) do
		if x == name then return true end
	end
	return false
end

local ops = {}

function ops.tree(cmd)
	local root, trouble = locate(cmd.path or "game")
	if not root then return false, trouble end
	local depth = math.clamp(tonumber(cmd.depth) or 3, 1, 8)
	local lines = { root:GetFullName() .. " (" .. root.ClassName .. ")" }
	local function walk(node, level, pad)
		for _, child in ipairs(node:GetChildren()) do
			table.insert(lines, pad .. child.Name .. " (" .. child.ClassName .. ")")
			if #lines > 400 then return end
			if level < depth then walk(child, level + 1, pad .. "  ") end
		end
	end
	walk(root, 1, "  ")
	return true, table.concat(lines, "\n")
end

function ops.create(cmd)
	local parent, trouble = locate(cmd.parent or "Workspace")
	if not parent then return false, trouble end
	local ok, obj = pcall(Instance.new, cmd.class)
	if not ok or obj == nil then return false, "не удалось создать " .. tostring(cmd.class) end
	if cmd.name then obj.Name = cmd.name end
	local complaints = {}
	for name, value in pairs(cmd.props or {}) do
		local done, err = pcall(function() obj[name] = toValue(value) end)
		if not done then table.insert(complaints, name .. ": " .. tostring(err)) end
	end
	obj.Parent = parent
	local tail = #complaints > 0 and ("\nне вышло задать: " .. table.concat(complaints, "; ")) or ""
	return true, "создано " .. obj:GetFullName() .. " (" .. obj.ClassName .. ")" .. tail
end

function ops.set(cmd)
	local obj, trouble = locate(cmd.path)
	if not obj then return false, trouble end
	local done, complaints = {}, {}
	for name, value in pairs(cmd.props or {}) do
		local ok, err = pcall(function() obj[name] = toValue(value) end)
		if ok then table.insert(done, name) else table.insert(complaints, name .. ": " .. tostring(err)) end
	end
	local text = "изменено " .. obj:GetFullName() .. ": " .. (#done > 0 and table.concat(done, ", ") or "ничего")
	if #complaints > 0 then text = text .. "\nне вышло: " .. table.concat(complaints, "; ") end
	return #complaints == 0, text
end

function ops.delete(cmd)
	local obj, trouble = locate(cmd.path)
	if not obj then return false, trouble end
	if obj == game or obj == workspace then return false, "это удалять нельзя" end
	local name = obj:GetFullName()
	obj:Destroy()
	return true, "удалено " .. name
end

--[[ Скрипт: если по этому пути он уже есть — заменяем исходник, иначе
	создаём. Так модель правит написанное, а не плодит копии. ]]
function ops.script(cmd)
	local parent, trouble = locate(cmd.parent or "ServerScriptService")
	if not parent then return false, trouble end
	local class = cmd.class or "Script"
	local name = cmd.name or "Скрипт"
	local obj = parent:FindFirstChild(name)
	local created = false
	if obj == nil or not obj:IsA("LuaSourceContainer") then
		local ok, fresh = pcall(Instance.new, class)
		if not ok or fresh == nil then return false, "не удалось создать " .. class end
		fresh.Name = name
		fresh.Parent = parent
		obj = fresh
		created = true
	end
	obj.Source = cmd.source or ""
	local lines = select(2, string.gsub(obj.Source, "\n", "")) + 1
	return true, (created and "создан " or "переписан ") .. obj:GetFullName() .. " (" .. obj.ClassName .. ", строк: " .. lines .. ")"
end

function ops.read(cmd)
	local obj, trouble = locate(cmd.path)
	if not obj then return false, trouble end
	if obj:IsA("LuaSourceContainer") then
		local source = obj.Source
		if #source > 12000 then source = string.sub(source, 1, 12000) .. "\n…обрезано" end
		return true, obj:GetFullName() .. ":\n" .. source
	end
	local lines = { obj:GetFullName() .. " (" .. obj.ClassName .. ")" }
	for _, name in ipairs(cmd.props or {}) do
		local ok, value = pcall(function() return obj[name] end)
		table.insert(lines, "  " .. name .. " = " .. (ok and fromValue(value) or "нет такого свойства"))
	end
	return true, table.concat(lines, "\n")
end

--[[ Расчистка перед новой игрой: убираем содержимое Workspace, но не трогаем
	камеру и рельеф — без них Студия ведёт себя странно. ]]
function ops.clear(cmd)
	local where, trouble = locate(cmd.path or "Workspace")
	if not where then return false, trouble end
	local removed = 0
	for _, child in ipairs(where:GetChildren()) do
		if not isKept(child.Name) then
			pcall(function() child:Destroy() end)
			removed = removed + 1
		end
	end
	return true, "очищено " .. where:GetFullName() .. ", убрано объектов: " .. removed
end

function ops.select(cmd)
	local obj, trouble = locate(cmd.path)
	if not obj then return false, trouble end
	Selection:Set({ obj })
	return true, "выделено " .. obj:GetFullName()
end

---------------------------------------------------------------- связь

local READONLY = { tree = true, read = true, select = true }

local function execute(cmd)
	local op = ops[cmd.op]
	if not op then return false, "неизвестное действие: " .. tostring(cmd.op) end

	-- Всё, что меняет плейс, отмечаем в истории: Ctrl+Z должен работать
	local changes = not READONLY[cmd.op]
	if changes then ChangeHistoryService:SetWaypoint("Clop Codex: " .. cmd.op) end
	local ok, success, text = pcall(op, cmd)
	if changes then ChangeHistoryService:SetWaypoint("Clop Codex: " .. cmd.op .. " — готово") end

	if not ok then return false, "ошибка плагина: " .. tostring(success) end
	return success, text
end

local function request(path, body)
	return HttpService:RequestAsync({
		Url = BASE .. path,
		Method = body and "POST" or "GET",
		Headers = { ["x-clop-token"] = TOKEN, ["Content-Type"] = "application/json" },
		Body = body and HttpService:JSONEncode(body) or nil,
	})
end

local function hello()
	local ok, res = pcall(request, "/hello", {
		place = game.Name,
		placeId = game.PlaceId,
		user = StudioService:GetUserId(),
		studio = version(),
	})
	return ok and res.Success
end

local function loop()
	while connected do
		local ok, res = pcall(request, "/poll")
		if not ok or not res.Success then
			-- Приложение закрыто или ещё не подняло сервер: ждём и пробуем снова
			task.wait(3)
		else
			local parsed
			local decoded = pcall(function() parsed = HttpService:JSONDecode(res.Body) end)
			if decoded and parsed and parsed.command then
				local cmd = parsed.command
				local success, text = execute(cmd)
				say(cmd.op .. ": " .. tostring(text))
				pcall(request, "/result", { id = cmd.id, ok = success, output = text })
			end
			task.wait(0.2)
		end
	end
end

local function connect()
	connected = true
	button:SetActive(true)
	if hello() then
		say("связь с приложением есть, плейс: " .. game.Name)
	else
		say("приложение не отвечает — оно запущено? связь включится сама, как только появится")
	end
	task.spawn(loop)
end

local function disconnect()
	connected = false
	button:SetActive(false)
	say("связь выключена")
end

button.Click:Connect(function()
	if connected then disconnect() else connect() end
end)

plugin.Unloading:Connect(function() connected = false end)

-- Включаемся сами: человек уже нажал кнопку в приложении, второй раз просить
-- нажимать здесь незачем
connect()
