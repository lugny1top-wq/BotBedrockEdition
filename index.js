const bedrock = require('bedrock-protocol')
const readline = require('readline')

// Basic connection settings.
const HOST = 'frizmine.net'
const PORT = 19133
const USERNAME = 'BotBE' //qwerty
const VERSION = '1.26.0'
const AUTH_PASSWORD = 'qwerty'

// Most PE servers that use nick/password forms allow offline auth.
// Set this to false only if the server requires a real Xbox/Microsoft login.
const OFFLINE_MODE = true
const RECONNECT_DELAY_MS = 5_000
const CHUNK_RADIUS = 2
const CONSOLE_COMMAND_PREFIX = '/'
const ACTION_TICK_MS = 50
const WALK_SPEED_PER_TICK = 0.11
const SPRINT_SPEED_PER_TICK = 0.16
const SNEAK_SPEED_PER_TICK = 0.04
const JUMP_VELOCITY_PER_TICK = 0.42
const GRAVITY_PER_TICK = 0.08
const TERMINAL_FALL_SPEED_PER_TICK = -0.9

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

let client = null
let reconnectTimer = null
let reconnecting = false
let runtimeEntityId = null
let initializedSent = false
let activeQuestion = Promise.resolve()
let pendingConsoleQuestion = null
let chatOutputEnabled = true
let actionTimer = null
let actionTick = 0n
let currentAction = null
let playerState = {
  position: { x: 0, y: 0, z: 0 },
  groundY: 0,
  yaw: 0,
  pitch: 0,
  onGround: true,
  verticalVelocity: 0
}

const ACTION_KEY_ALIASES = new Map([
  ['W', 'W'],
  ['UP', 'W'],
  ['FORWARD', 'W'],
  ['S', 'S'],
  ['DOWN', 'S'],
  ['BACK', 'S'],
  ['BACKWARD', 'S'],
  ['A', 'A'],
  ['LEFT', 'A'],
  ['D', 'D'],
  ['RIGHT', 'D'],
  ['SPACE', 'SPACE'],
  ['JUMP', 'SPACE'],
  ['LSHIFT', 'SHIFT'],
  ['RSHIFT', 'SHIFT'],
  ['SHIFT', 'SHIFT'],
  ['SNEAK', 'SHIFT'],
  ['CTRL', 'CTRL'],
  ['LCTRL', 'CTRL'],
  ['RCTRL', 'CTRL'],
  ['SPRINT', 'CTRL']
])

function log(level, message, meta) {
  const ts = new Date().toISOString()
  const suffix = meta === undefined ? '' : ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`
  console.log(`[${ts}] [${level}] ${message}${suffix}`)
}

function askHiddenEnough(question) {
  // readline in the standard library does not hide input. Keep it simple and
  // immediately move on after the answer so password handling stays local.
  activeQuestion = activeQuestion.then(() => new Promise((resolve) => {
    pendingConsoleQuestion = resolve
    process.stdout.write(question)
  }))

  return activeQuestion
}

function printConsoleHelp() {
  log('INFO', 'Console input: type a message and press Enter to send it to Minecraft chat')
  log('INFO', 'Commands: /chat on, /chat off, /chatoff, /chaton, /chattoggle, /actionkey W + LShift, /actionkey stop, /help, /quit')
}

function sendChatMessage(message) {
  if (!client) {
    log('WARN', 'Cannot send chat message: client is not created yet')
    return
  }

  const trimmed = message.trim()
  if (!trimmed) return

  safeQueue('text', {
    needs_translation: false,
    category: 'authored',
    type: 'chat',
    source_name: USERNAME,
    message: trimmed,
    xuid: '',
    platform_chat_id: '',
    has_filtered_message: true,
    filtered_message: ''
  })

  log('CHAT_OUT', `<${USERNAME}> ${trimmed}`)
}

function handleConsoleLine(line) {
  if (pendingConsoleQuestion) {
    const resolve = pendingConsoleQuestion
    pendingConsoleQuestion = null
    resolve(line.trim())
    return
  }

  const input = line.trim()
  if (!input) return

  if (!input.startsWith(CONSOLE_COMMAND_PREFIX)) {
    sendChatMessage(input)
    return
  }

  const [command, ...args] = input.slice(CONSOLE_COMMAND_PREFIX.length).trim().split(/\s+/)
  const normalizedCommand = String(command || '').toLowerCase()
  const arg = String(args[0] || '').toLowerCase()

  if (normalizedCommand === 'chatoff') {
    chatOutputEnabled = false
    log('INFO', 'Incoming chat output disabled')
    return
  }

  if (normalizedCommand === 'chaton') {
    chatOutputEnabled = true
    log('INFO', 'Incoming chat output enabled')
    return
  }

  if (normalizedCommand === 'chattoggle') {
    chatOutputEnabled = !chatOutputEnabled
    log('INFO', `Incoming chat output ${chatOutputEnabled ? 'enabled' : 'disabled'}`)
    return
  }

  if (normalizedCommand === 'chat') {
    if (arg === 'off') {
      chatOutputEnabled = false
      log('INFO', 'Incoming chat output disabled')
      return
    }

    if (arg === 'on') {
      chatOutputEnabled = true
      log('INFO', 'Incoming chat output enabled')
      return
    }

    if (arg === 'toggle') {
      chatOutputEnabled = !chatOutputEnabled
      log('INFO', `Incoming chat output ${chatOutputEnabled ? 'enabled' : 'disabled'}`)
      return
    }

    log('INFO', `Incoming chat output is ${chatOutputEnabled ? 'enabled' : 'disabled'}. Use /chat on, /chat off or /chat toggle`)
    return
  }

  if (normalizedCommand === 'actionkey') {
    handleActionKeyCommand(args.join(' '))
    return
  }

  if (normalizedCommand === 'help') {
    printConsoleHelp()
    return
  }

  if (normalizedCommand === 'quit' || normalizedCommand === 'exit') {
    process.emit('SIGINT')
    return
  }

  // To send a Minecraft command, type it with double slash, for example:
  // //spawn -> sends /spawn to the server.
  if (input.startsWith(`${CONSOLE_COMMAND_PREFIX}${CONSOLE_COMMAND_PREFIX}`)) {
    sendChatMessage(input.slice(1))
    return
  }

  log('WARN', `Unknown console command: ${input}. Type /help for available commands`)
}

function normalizeActionKey(token) {
  const normalized = token.trim().toUpperCase()
  return ACTION_KEY_ALIASES.get(normalized) || null
}

function parseNumberOption(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeDegrees(value) {
  let angle = Number(value) || 0
  angle %= 360
  if (angle < 0) angle += 360
  return angle
}

function clampPitch(value) {
  return Math.max(-89, Math.min(89, Number(value) || 0))
}

function parseActionKeyExpression(expression) {
  const raw = expression.trim()
  if (!raw || /^stop|off|none|clear$/i.test(raw)) return null

  const keys = new Set()
  let yaw = playerState.yaw
  let pitch = playerState.pitch

  for (const part of raw.split('+')) {
    const token = part.trim()
    if (!token) continue

    const optionMatch = token.match(/^(yaw|pitch|camera|cam)\s*=\s*(-?\d+(?:\.\d+)?)$/i)
    if (optionMatch) {
      const option = optionMatch[1].toLowerCase()
      const value = parseNumberOption(optionMatch[2], option === 'pitch' ? pitch : yaw)
      if (option === 'pitch') pitch = clampPitch(value)
      else yaw = normalizeDegrees(value)
      continue
    }

    const key = normalizeActionKey(token)
    if (!key) {
      throw new Error(`unknown key "${token}"`)
    }

    keys.add(key)
  }

  if (keys.size === 0) {
    return {
      keys,
      yaw,
      pitch,
      label: `camera yaw=${yaw}, pitch=${pitch}`
    }
  }

  return {
    keys,
    yaw,
    pitch,
    label: [...keys].join(' + ') + `, yaw=${yaw}, pitch=${pitch}`
  }
}

function handleActionKeyCommand(expression) {
  try {
    const action = parseActionKeyExpression(expression)
    if (!action) {
      stopActionKey('manual stop')
      return
    }

    currentAction = action
    playerState.yaw = action.yaw
    playerState.pitch = action.pitch
    startActionLoop()
    log('INFO', `Action key enabled: ${action.label}`)
  } catch (err) {
    log('WARN', `${err.message}. Example: /actionkey W + LShift or /actionkey A + RShift + yaw=90`)
  }
}

function stopActionKey(reason) {
  if (actionTimer) {
    clearInterval(actionTimer)
    actionTimer = null
  }

  if (currentAction) {
    currentAction = null
    sendPlayerAuthInput(new Set())
    log('INFO', `Action key stopped${reason ? `: ${reason}` : ''}`)
  }
}

function startActionLoop() {
  if (actionTimer) return

  actionTimer = setInterval(() => {
    if (!currentAction) {
      stopActionKey()
      return
    }

    sendPlayerAuthInput(currentAction.keys, currentAction)
  }, ACTION_TICK_MS)
}

function movementVectorForKeys(keys) {
  let x = 0
  let z = 0

  if (keys.has('A')) x -= 1
  if (keys.has('D')) x += 1
  if (keys.has('W')) z += 1
  if (keys.has('S')) z -= 1

  if (x !== 0 && z !== 0) {
    const normalizer = Math.SQRT1_2
    x *= normalizer
    z *= normalizer
  }

  return { x, z }
}

function inputFlagsForKeys(keys, moveVector) {
  const flags = []

  if (keys.has('W')) flags.push('up', 'want_up')
  if (keys.has('S')) flags.push('down', 'want_down')
  if (keys.has('A')) flags.push('left')
  if (keys.has('D')) flags.push('right')
  if (keys.has('SPACE')) flags.push('jumping', 'jump_down', 'start_jumping', 'jump_pressed_raw', 'jump_current_raw')
  if (keys.has('SHIFT')) flags.push('sneaking', 'sneak_down', 'start_sneaking', 'sneak_pressed_raw', 'sneak_current_raw')
  if (keys.has('CTRL')) flags.push('sprinting', 'sprint_down', 'start_sprinting')

  if (keys.has('W') && keys.has('A')) flags.push('up_left')
  if (keys.has('W') && keys.has('D')) flags.push('up_right')
  if (keys.has('S') && keys.has('A')) flags.push('down_left')
  if (keys.has('S') && keys.has('D')) flags.push('down_right')
  if (moveVector.x !== 0 || moveVector.z !== 0) flags.push('camera_relative_movement_enabled')

  return flags
}

function advanceLocalPosition(keys, moveVector, action) {
  let dx = 0
  let dz = 0

  if (moveVector.x !== 0 || moveVector.z !== 0) {
    const speed = keys.has('SHIFT')
      ? SNEAK_SPEED_PER_TICK
      : keys.has('CTRL')
        ? SPRINT_SPEED_PER_TICK
        : WALK_SPEED_PER_TICK

    const yawRad = normalizeDegrees(action?.yaw ?? playerState.yaw) * Math.PI / 180
    const sin = Math.sin(yawRad)
    const cos = Math.cos(yawRad)

    dx = (moveVector.x * cos - moveVector.z * sin) * speed
    dz = (moveVector.z * cos + moveVector.x * sin) * speed
  }

  if (keys.has('SPACE') && playerState.onGround) {
    playerState.verticalVelocity = JUMP_VELOCITY_PER_TICK
    playerState.onGround = false
  }

  let dy = 0
  if (!playerState.onGround || playerState.verticalVelocity !== 0) {
    dy = playerState.verticalVelocity
    playerState.verticalVelocity = Math.max(
      TERMINAL_FALL_SPEED_PER_TICK,
      playerState.verticalVelocity - GRAVITY_PER_TICK
    )
  }

  playerState.position.x += dx
  playerState.position.y += dy
  playerState.position.z += dz

  if (playerState.position.y <= playerState.groundY && playerState.verticalVelocity <= 0) {
    const correctedDy = playerState.groundY - (playerState.position.y - dy)
    playerState.position.y = playerState.groundY
    playerState.verticalVelocity = 0
    playerState.onGround = true
    return { x: dx, y: correctedDy, z: dz }
  }

  return { x: dx, y: dy, z: dz }
}

function cameraForwardVector(yaw, pitch) {
  const yawRad = normalizeDegrees(yaw) * Math.PI / 180
  const pitchRad = clampPitch(pitch) * Math.PI / 180
  const horizontal = Math.cos(pitchRad)

  return {
    x: -Math.sin(yawRad) * horizontal,
    y: -Math.sin(pitchRad),
    z: Math.cos(yawRad) * horizontal
  }
}

function runtimeIdAsNumber() {
  return typeof runtimeEntityId === 'bigint' ? Number(runtimeEntityId) : runtimeEntityId
}

function sendPlayerAuthInput(keys, action = currentAction) {
  if (!client || runtimeEntityId === null || runtimeEntityId === undefined) return

  const moveVector = movementVectorForKeys(keys)
  const delta = advanceLocalPosition(keys, moveVector, action)
  const yaw = normalizeDegrees(action?.yaw ?? playerState.yaw)
  const pitch = clampPitch(action?.pitch ?? playerState.pitch)
  const cameraOrientation = cameraForwardVector(yaw, pitch)
  actionTick += 1n

  playerState.yaw = yaw
  playerState.pitch = pitch

  const position = { ...playerState.position }

  safeQueue('player_auth_input', {
    pitch,
    yaw,
    position,
    move_vector: { x: moveVector.x, z: moveVector.z },
    head_yaw: yaw,
    input_data: inputFlagsForKeys(keys, moveVector),
    input_mode: 'mouse',
    play_mode: 'normal',
    interaction_model: 'classic',
    interact_rotation: { x: pitch, z: yaw },
    tick: actionTick,
    delta,
    analogue_move_vector: { x: moveVector.x, z: moveVector.z },
    camera_orientation: cameraOrientation,
    raw_move_vector: { x: moveVector.x, z: moveVector.z }
  })

  safeQueue('move_player', {
    runtime_id: runtimeIdAsNumber(),
    position,
    pitch,
    yaw,
    head_yaw: yaw,
    mode: 'normal',
    on_ground: playerState.onGround,
    ridden_runtime_id: 0,
    tick: actionTick
  })
}

function scheduleReconnect(reason) {
  if (reconnecting || reconnectTimer) return

  reconnecting = true
  stopActionKey('disconnect')
  log('WARN', `Disconnected: ${reason || 'unknown reason'}`)
  log('INFO', `Reconnecting in ${RECONNECT_DELAY_MS / 1000} seconds...`)

  try {
    if (client) client.removeAllListeners()
  } catch (err) {
    log('WARN', 'Failed to clean old client listeners', err.message)
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnecting = false
    connect()
  }, RECONNECT_DELAY_MS)
}

function isVarIntReadError(err) {
  return /Unexpected buffer end while reading VarInt/i.test(String(err?.message || err))
}

function safeQueue(packetName, payload) {
  try {
    client.queue(packetName, payload)
    return true
  } catch (err) {
    log('WARN', `Could not queue ${packetName}`, err.message)
    return false
  }
}

function safeWrite(packetName, payload) {
  try {
    client.write(packetName, payload)
    return true
  } catch (err) {
    log('WARN', `Could not write ${packetName}`, err.message)
    return false
  }
}

function patchParserGuard(currentClient) {
  if (typeof currentClient.readPacket !== 'function') return

  const originalReadPacket = currentClient.readPacket.bind(currentClient)
  currentClient.readPacket = (buffer) => {
    try {
      return originalReadPacket(buffer)
    } catch (err) {
      if (isVarIntReadError(err)) {
        log('WARN', 'Ignored broken server packet: Unexpected buffer end while reading VarInt')
        return undefined
      }

      throw err
    }
  }
}

function extractFormId(packet) {
  return packet.form_id ?? packet.formId ?? packet.formid
}

function parseFormData(rawData) {
  if (typeof rawData !== 'string') return rawData

  try {
    return JSON.parse(rawData)
  } catch {
    return { type: 'unknown', raw: rawData }
  }
}

function textOf(value) {
  return String(value ?? '').toLowerCase()
}

function isAuthForm(form) {
  const source = [
    form?.title,
    form?.content,
    form?.body,
    ...(Array.isArray(form?.content) ? form.content.map((item) => [
      item?.text,
      item?.placeholder,
      item?.default
    ].join(' ')) : [])
  ].join(' ')

  return /(auth|login|register|password|pass|\u043f\u0430\u0440\u043e\u043b|\u0430\u0432\u0442\u043e\u0440\u0438\u0437\u0430\u0446|\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446|\u0432\u0445\u043e\u0434|\u043b\u043e\u0433\u0438\u043d)/i.test(source)
}

function controlText(control) {
  return textOf([control?.text, control?.placeholder, control?.default].join(' '))
}

function responseForCustomForm(form, password) {
  const controls = Array.isArray(form.content) ? form.content : []
  const singleInputAuthForm = controls.filter((item) => item?.type === 'input').length === 1 && isAuthForm(form)

  return controls.map((control) => {
    const type = control?.type
    const label = controlText(control)

    if (type === 'label') return null
    if (type === 'toggle') return Boolean(control.default)

    if (type === 'input') {
      if (singleInputAuthForm || /pass|\u043f\u0430\u0440\u043e\u043b|\u043f\u043e\u0432\u0442\u043e\u0440|repeat|confirm/.test(label)) return password
      if (/nick|\u043d\u0438\u043a|name|user|login|\u043b\u043e\u0433\u0438\u043d/.test(label)) return USERNAME
      return typeof control.default === 'string' ? control.default : ''
    }

    // Non-auth controls are uncommon in login/register forms. Use protocol
    // defaults so the JSON stays valid if the server adds an optional control.
    if (type === 'dropdown' || type === 'step_slider') return Number(control.default ?? 0)
    if (type === 'slider') return Number(control.default ?? control.min ?? 0)

    return null
  })
}

function buildFormResponse(form, password) {
  if (form?.type === 'custom_form') {
    return JSON.stringify(responseForCustomForm(form, password))
  }

  if (form?.type === 'modal') {
    return JSON.stringify(true)
  }

  if (form?.type === 'form') {
    // Button/menu forms expect a selected button index, not an array.
    return JSON.stringify(0)
  }

  return JSON.stringify(null)
}

async function handleModalFormRequest(packet) {
  const formId = extractFormId(packet)
  const form = parseFormData(packet.data)

  log('INFO', `Modal form request received. form_id=${formId}`)
  console.log(JSON.stringify(form, null, 2))

  if (formId === undefined || formId === null) {
    log('ERROR', 'Form id is missing; cannot send modal_form_response')
    return
  }

  let password = ''
  if (isAuthForm(form)) {
    if (AUTH_PASSWORD) {
      password = AUTH_PASSWORD
      log('INFO', 'Auth form detected; using AUTH_PASSWORD from config')
    } else {
      password = await askHiddenEnough('Enter server password for login/register form: ')
    }
  } else {
    log('INFO', 'Form does not look like auth/register; sending a neutral protocol response')
  }

  const responseData = buildFormResponse(form, password)
  const payload = {
    form_id: formId,
    has_response_data: true,
    data: responseData,
    has_cancel_reason: false,
    // Some old bedrock-protocol builds used this typo in proto field names.
    // Keeping it false is harmless on builds that ignore unknown fields.
    has_cancal_reason: false
  }

  log('INFO', `Sending modal_form_response. form_id=${formId}, data=${responseData}`)
  safeWrite('modal_form_response', payload)
}

function handleResourcePacksInfo(packet) {
  const behaviorPacks = packet.behaviour_packs ?? packet.behavior_packs ?? []
  const texturePacks = packet.texture_packs ?? []
  const totalPacks = behaviorPacks.length + texturePacks.length

  log('INFO', `Resource packs info received. packs=${totalPacks}, must_accept=${Boolean(packet.must_accept)}`)

  // A headless bot cannot render/load packs. Tell the server we already have
  // every pack, then complete the next stack stage below.
  safeWrite('resource_pack_client_response', {
    response_status: 'have_all_packs',
    resourcepackids: []
  })

  safeQueue('client_cache_status', { enabled: false })
  safeQueue('request_chunk_radius', { chunk_radius: CHUNK_RADIUS })
}

function handleResourcePackStack(packet) {
  const resourcePacks = packet.resource_packs ?? []
  const behaviorPacks = packet.behavior_packs ?? packet.behaviour_packs ?? []

  log('INFO', `Resource pack stack received. resource=${resourcePacks.length}, behavior=${behaviorPacks.length}`)

  safeWrite('resource_pack_client_response', {
    response_status: 'completed',
    resourcepackids: []
  })
}

function sendSpawnInitializationPackets(source) {
  if (initializedSent || runtimeEntityId === null || runtimeEntityId === undefined) return

  initializedSent = true
  log('INFO', `Sending spawn initialization packets after ${source}. runtime_entity_id=${runtimeEntityId}`)

  safeQueue('serverbound_loading_screen', { type: 1 })
  safeQueue('serverbound_loading_screen', { type: 2 })
  safeQueue('set_local_player_as_initialized', {
    runtime_entity_id: runtimeEntityId
  })
}

function connect() {
  runtimeEntityId = null
  initializedSent = false
  actionTick = 0n

  log('INFO', `Connecting to ${HOST}:${PORT} as ${USERNAME}, version=${VERSION}, offline=${OFFLINE_MODE}`)

  client = bedrock.createClient({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: VERSION,
    offline: OFFLINE_MODE,
    profilesFolder: './auth-cache',
    connectTimeout: 15_000,
    onMsaCode: (data) => {
      log('INFO', `Microsoft auth required: open ${data.verification_uri} and enter code ${data.user_code}`)
    }
  })

  patchParserGuard(client)

  client.on('connect', () => log('INFO', 'RakNet connected'))
  client.on('login', () => log('INFO', 'Login accepted by server'))
  client.on('join', () => log('INFO', 'Joined game session'))
  client.on('spawn', () => {
    log('INFO', 'Spawn event received')
    sendSpawnInitializationPackets('spawn event')
  })

  client.on('start_game', (packet) => {
    runtimeEntityId = packet.runtime_entity_id
    playerState.position = packet.player_position ?? packet.spawn_position ?? playerState.position
    playerState.groundY = playerState.position.y
    playerState.yaw = normalizeDegrees(packet.rotation?.z ?? packet.yaw ?? playerState.yaw)
    playerState.pitch = clampPitch(packet.rotation?.x ?? packet.pitch ?? playerState.pitch)
    playerState.verticalVelocity = 0
    log('INFO', `Start game received. runtime_entity_id=${runtimeEntityId}`)
  })

  client.on('move_player', (packet) => {
    if (packet.runtime_id !== runtimeEntityId) return

    playerState.position = packet.position ?? playerState.position
    playerState.yaw = normalizeDegrees(packet.yaw ?? playerState.yaw)
    playerState.pitch = clampPitch(packet.pitch ?? playerState.pitch)
    playerState.onGround = Boolean(packet.on_ground)
    if (playerState.onGround) {
      playerState.groundY = playerState.position.y
      playerState.verticalVelocity = 0
    }
  })

  client.on('correct_player_move_prediction', (packet) => {
    if (packet.prediction_type !== 'player' && packet.prediction_type !== 0) return

    playerState.position = packet.position ?? playerState.position
    playerState.onGround = Boolean(packet.on_ground)
    if (playerState.onGround) {
      playerState.groundY = playerState.position.y
      playerState.verticalVelocity = 0
    }
    if (packet.rotation) {
      playerState.pitch = clampPitch(packet.rotation.x ?? playerState.pitch)
      playerState.yaw = normalizeDegrees(packet.rotation.z ?? playerState.yaw)
    }
  })

  client.on('play_status', (packet) => {
    log('INFO', 'Play status', packet)
    if (packet.status === 'player_spawn' || packet.status === 3) {
      sendSpawnInitializationPackets('play_status=player_spawn')
    }
  })

  client.on('resource_packs_info', handleResourcePacksInfo)
  client.on('resource_pack_stack', handleResourcePackStack)
  client.on('modal_form_request', (packet) => {
    handleModalFormRequest(packet).catch((err) => {
      log('ERROR', 'Failed to handle modal form request', err.message)
    })
  })

  client.on('text', (packet) => {
    if (!chatOutputEnabled) return

    const message = packet.message ?? ''
    const sourceName = packet.source_name ? `<${packet.source_name}> ` : ''
    log('CHAT', `${sourceName}${message}`)
  })

  client.on('kick', (reason) => {
    log('ERROR', 'Kicked by server', reason)
    scheduleReconnect(`kick: ${reason}`)
  })

  client.on('disconnect', (packet) => {
    log('WARN', 'Disconnect packet received', packet)
  })

  client.on('close', (reason) => {
    scheduleReconnect(`close: ${reason || 'connection closed'}`)
  })

  client.on('error', (err) => {
    if (isVarIntReadError(err)) {
      log('WARN', 'Recoverable protocol parser error ignored', err.message)
      return
    }

    log('ERROR', 'Client error', err?.stack || err?.message || err)
    scheduleReconnect(`error: ${err?.message || err}`)
  })
}

process.on('uncaughtException', (err) => {
  if (isVarIntReadError(err)) {
    log('WARN', 'Ignored uncaught VarInt parser error', err.message)
    return
  }

  log('ERROR', 'Uncaught exception', err?.stack || err)
  scheduleReconnect(`uncaughtException: ${err?.message || err}`)
})

process.on('unhandledRejection', (reason) => {
  log('ERROR', 'Unhandled promise rejection', reason?.stack || reason)
})

process.on('SIGINT', () => {
  log('INFO', 'Stopping bot...')
  stopActionKey('shutdown')
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (client) client.close()
  rl.close()
  process.exit(0)
})

rl.on('line', handleConsoleLine)

connect()
