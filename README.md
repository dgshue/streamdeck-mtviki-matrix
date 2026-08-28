# Stream Deck — MT-VIKI HDMI Matrix

Control an MT-VIKI 4K HDMI matrix switch (4x4 with audio extraction, and
siblings sharing the same LAN module) from an Elgato Stream Deck.

The headline action is **Swap Pair**: one key exchanges the two sources feeding
a pair of outputs. Put one key on outputs 1/2 and another on outputs 3/4 and you
get "swap left" and "swap right" — each side flips top/bottom independently,
whatever is currently on them.

## Actions

| Action | What it does |
| --- | --- |
| **Swap Pair** | Exchanges the sources on two outputs. Key title shows `input on A / input on B`, refreshed on a timer. |
| **Set Route** | Sends one input to a fixed set of outputs. |

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
