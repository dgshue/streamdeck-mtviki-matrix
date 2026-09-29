# Stream Deck — MT-VIKI HDMI Matrix

Control an MT-VIKI 4K HDMI matrix switch (4x4 with audio extraction, and
siblings sharing the same LAN module) from an Elgato Stream Deck.

The headline action is **Swap Pair**: one key exchanges the two sources feeding
a pair of outputs. Put one key on outputs 1/2 and another on outputs 3/4 and you
get "swap left" and "swap right" — each side flips top/bottom independently,
whatever is currently on them. **Layout** applies a whole arrangement at once —
route some screens, blank others — and **Reset to Default** puts everything back.

## Actions

| Action | What it does |
| --- | --- |
| **Swap Pair** | Exchanges the sources on two outputs. Key title shows `input on A / input on B`, refreshed on a timer. |
| **Layout** | Applies a whole arrangement in one press: each screen is routed to an input, blanked, or left alone. Optionally also switches a monitor's own input over DDC/CI. Key title shows the live map, `·` for a blanked screen. |
| **Reset to Default** | Restores the one-to-one map (1→1, 2→2, …) in a single `SWOTO`, and relights any blanked screens. Key title shows the current map, or a tick when already at default. |
| **Set Route** | Sends one input to a fixed set of outputs. |
| **Monitor Input** | Switches a monitor's own input source over DDC/CI. Note the one-way caveat below. |

Connection settings (host, username, password) are **global** — set them once on
any key and every key uses them. Defaults are `192.168.2.200` / `admin` / `admin`.

## Protocol

There is no vendor API document; this was reverse-engineered from the unit's own
web GUI (`/js/comms.js`, served by lighttpd on the MediaTek LAN module) and
verified against the hardware.

All control is one endpoint:

```
POST http://<host>/cgi-bin/matrixs.cgi
Authorization: Basic <base64 user:pass>
Content-Type: application/x-www-form-urlencoded

matrixdata={"COMMAND":"<command>"}
```

The body is **not** url-encoded — the GUI posts raw JSON (`processData: false`)
and the CGI parses it that way.

| Command | Reply | Meaning |
| --- | --- | --- |
| `GETSWS` | `{"SWS":"1 2 3 4"}` | Input feeding output 1..N, in order |
| `SW <in> <out> [out...]` | `{"result":"1"}` | Route one input to one or more outputs |
| `SWALL <in>` | `{"result":"1"}` | That input to every output |
| `SWOTO` | `{"result":"1"}` | Identity map (1→1, 2→2, …) |
| `SetOutput <out> <0\|1>` | `{"result":"1"}` | Disable / enable an output |
| `GETNVRAM` + `FIELD` | `{"<field>":"<value>"}` | Read config, e.g. `MatrixMaxIn` |

Inputs and outputs are 1-based throughout.

### Blanking is separate from routing

`SetOutput <n> 0` blanks a screen without changing what it is routed to, and the
state is readable back as the NVRAM field `Output<n>Enable` (`"1"` lit, `"0"`
dark). It also **survives `SWOTO`** — restoring the default routing does not
relight a blanked screen, so anything calling itself a reset has to enable the
outputs too. `resetIdentity()` does.

### The timing trap

Two behaviours will bite anyone writing against this device:

1. **`result:"1"` is an ack, not a confirmation.** The CGI replies before the
   matrix MCU has acted.
2. **`GETSWS` returns the *previous* routing for a short window after a switch**
   — measured at up to ~190ms on a 4x4, worse under sustained request load. The
   stock web GUI dodges this by waiting 500ms before re-reading.

A swap is read-then-write-twice, so reading inside that window computes the swap
from a stale map and moves the wrong sources. This plugin handles it by never
reading inside the settle window and trusting its own optimistic map instead
(`SETTLE_MS` / `CACHE_TTL_MS` in [`src/matrix.ts`](src/matrix.ts)). Writes are
also serialised per host so two keys pressed together cannot interleave.

## DDC/CI monitor control

A matrix moves sources between screens, but a screen wired to something *else*
as well — a laptop on DP, a console on its second HDMI — also has its own input
to switch. **Layout** can do both in one press, and runs them concurrently
because the matrix and the monitor are independent devices.

Control goes through `scripts/DdcCtl.cs`, a small C# console app that calls
`dxva2.dll` (`GetPhysicalMonitorsFromHMONITOR` / `SetVCPFeature`). It is
compiled on first use by the `csc.exe` that ships with the .NET Framework on
every Windows install, and cached in `%LOCALAPPDATA%\com.dgshue.mtviki\`, keyed
by a hash of the source. No native Node addon — one of those would have to match
the ABI of whichever Node the Stream Deck app bundles, and break on app updates.

### Ask the monitor, don't guess

Input source is VCP feature `0x60`, but the accepted values are per-model. The
monitor will tell you: `ddcctl list` returns its capability string, e.g. for a
Dell U2414H

```
model(U2414H)...vcp(02 04 05 08 10 12 14(...) 16 18 1A 52 60( 0F 10 11 12) ...)
```

`60( 0F 10 11 12)` is the whole answer — DP-1, mDP-2, HDMI-1, HDMI-2, and
nothing else. Offering a value outside that list is how you end up on a dead
input. Some panels also ignore `0x60` entirely and use a vendor code instead.

### Resolve by model, then cache

Monitors are selected by a substring of the capability string (the model), not
by display number, because `EnumDisplayMonitors` order shifts when displays are
replugged and an index would silently drive the wrong panel.

That costs something, though — measured on a U2414H:

| Call | Time |
| --- | --- |
| get/set by index | **~95ms** |
| get/set by model match | **~1450ms** |

The entire difference is reading capability strings, a slow multi-packet I2C
transfer. So the plugin resolves by model once, caches the index, and re-resolves
only when a call fails or the display count changes. First press ~1.5s, every
press after ~95ms.

For reference, doing the same work in PowerShell via `Add-Type` costs ~2.2s per
call — ~0.5s interpreter startup plus ~1.7s recompiling the C# every time. That
is what the cached exe exists to avoid.

### One-way switching, and why

Measured on this setup — a PC driving a U2414H directly on DisplayPort, plus an
MT-VIKI matrix feeding that monitor's HDMI 1:

- **The matrix terminates DDC/EDID.** It appears to Windows as its own display
  ("HDMI Matrix") reporting no capability string, even with real monitors on its
  outputs. Nothing downstream of it is reachable over DDC.
- **The U2414H serves MCCS only on its active input.** The instant it switched to
  HDMI 1, DDC over DisplayPort went silent — and stayed silent, though Windows
  still listed the display as connected.

Together those mean switching a monitor onto a matrix-fed input is a **one-way
trip**: its DDC endpoint moves behind the matrix, so no key can bring it back.
Only the monitor's OSD can. Plan layouts accordingly, or feed the direct output
into the matrix instead and let the matrix do all the switching.

### `result: true` is not proof

`SetVCPFeature` returns success even when the DDC channel is dead — a monitor
already on an unreachable input will "accept" a command it never received. So
`setVcp()` reads the feature back *before* writing: that read is the only honest
test of whether the monitor is reachable, and it makes a no-op press free.

The read cannot come *after* the write, because on a monitor like this one,
switching away is precisely what takes DDC offline.

## Build

```bash
npm install
npm run build
```

Output lands in `com.dgshue.mtviki.sdPlugin/bin/`. Copy or symlink that
`.sdPlugin` directory into:

```
%APPDATA%\Elgato\StreamDeck\Plugins\
```

then restart Stream Deck. Regenerate the icons with `node tools/make-icons.mjs`.

Set `MTVIKI_TRACE=1` to log every command the plugin sends.

To drive the DDC helper by hand:

```bash
C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe /out:ddcctl.exe com.dgshue.mtviki.sdPlugin/scripts/DdcCtl.cs
./ddcctl.exe list
```
