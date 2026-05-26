# BotPE

Minecraft Bedrock Edition bot on Node.js using `bedrock-protocol`.

## Install

```powershell
npm.cmd install
```

## Run

```powershell
npm.cmd start
```

or:

```powershell
node index.js
```

## Settings

Main settings are at the top of `index.js`:

| Constant | What it does |
| --- | --- |
| `HOST` | Server address. |
| `PORT` | Server port. |
| `USERNAME` | Bot nickname. |
| `VERSION` | Bedrock protocol version used by `bedrock-protocol`. |
| `AUTH_PASSWORD` | Password for automatic login/register UI forms. Leave empty to type it manually in console. |
| `OFFLINE_MODE` | Uses offline login when `true`; set to `false` for Microsoft/Xbox auth. |
| `RECONNECT_DELAY_MS` | Delay before reconnect after kick/disconnect. |
| `CHUNK_RADIUS` | Requested chunk radius. |

## Console Commands

Type commands into the same console where the bot is running.

| Command | What it does |
| --- | --- |
| Any text without `/` | Sends this text to Minecraft chat. Example: `hello everyone`. |
| `/help` | Prints the available console commands. |
| `/chat on` | Enables incoming chat output in the console. |
| `/chaton` | Same as `/chat on`. |
| `/chat off` | Disables incoming chat output in the console. The bot can still send chat messages. |
| `/chatoff` | Same as `/chat off`. |
| `/chat toggle` | Switches incoming chat output on/off. |
| `/chattoggle` | Same as `/chat toggle`. |
| `/actionkey <keys>` | Starts one active keyboard action for the bot. Replaces the previous action. |
| `/actionkey stop` | Stops the active keyboard action. |
| `/quit` | Stops the bot process. |
| `/exit` | Same as `/quit`. |
| `//<command>` | Sends a Minecraft server command. Example: `//spawn` sends `/spawn`. |

## ActionKey

`/actionkey` can hold one action at a time. If you run another `/actionkey`, the previous one is replaced.

Supported keys:

| Key | Meaning |
| --- | --- |
| `W` | Move forward. |
| `A` | Move left. |
| `S` | Move backward. |
| `D` | Move right. |
| `Space` | Jump. |
| `LShift` | Sneak. |
| `RShift` | Sneak. |
| `Shift` | Sneak. |
| `Ctrl` | Sprint. |
| `LCtrl` | Sprint. |
| `RCtrl` | Sprint. |

Examples:

```text
/actionkey W
/actionkey A + LShift
/actionkey W + Ctrl
/actionkey W + Space
/actionkey Space
/actionkey stop
```

`/actionkey Space` makes the bot jump in place. `/actionkey W + Space` makes it move forward while jumping.

## Camera With ActionKey

You can also set camera rotation in the same command:

| Option | What it does |
| --- | --- |
| `yaw=<number>` | Horizontal camera angle in degrees. |
| `pitch=<number>` | Vertical camera angle in degrees, clamped from `-89` to `89`. |
| `camera=<number>` | Alias for `yaw=<number>`. |
| `cam=<number>` | Alias for `yaw=<number>`. |

Examples:

```text
/actionkey W + yaw=90
/actionkey A + RShift + yaw=180
/actionkey W + yaw=270 + pitch=-10
/actionkey yaw=0 + pitch=20
```

## Auth Forms

When a server sends a login/register UI form, the bot prints the form JSON and asks for a password in the console. The answer is sent back as `modal_form_response` with the same form id.

If `AUTH_PASSWORD` in `index.js` is not empty, the bot sends that password automatically and does not ask in the console.
