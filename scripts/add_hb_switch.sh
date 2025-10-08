#!/usr/bin/env bash
set -euo pipefail

# Defaults
HB_CONFIG_DEFAULT="/var/lib/homebridge/config.json"
HOST_DEFAULT="127.0.0.1"
PORT_DEFAULT="3000"
WAIT_ON_DEFAULT=800
WAIT_OFF_DEFAULT=500
QUIET_DEFAULT=300
MAX_DEFAULT=2200
CACHE_DEFAULT=800
JITTER_DEFAULT=300
TIMEOUT_DEFAULT=3000
APPLY=0
REPLACE=0
HB_CONFIG_PATH=""
HOST="$HOST_DEFAULT"
PORT="$PORT_DEFAULT"
WAIT_ON="$WAIT_ON_DEFAULT"
WAIT_OFF="$WAIT_OFF_DEFAULT"
QUIET_MS="$QUIET_DEFAULT"
MAX_MS="$MAX_DEFAULT"
CACHE_MS="$CACHE_DEFAULT"
JITTER_MS="$JITTER_DEFAULT"
TIMEOUT_MS="$TIMEOUT_DEFAULT"

usage() {
  cat <<EOF
Usage:
  $0 [options] "<name>" <m> <s> <b>

Options:
  -c, --config PATH   Path to Homebridge config.json (default: ${HB_CONFIG_DEFAULT} or ~/.homebridge/config.json)
  -a, --apply         Write directly into config.json (otherwise prints JSON to stdout)
  -r, --replace       If an accessory with the same name exists, replace it (default: update/insert by name)
  --host HOST         API host for URLs (default: ${HOST_DEFAULT})
  --port PORT         API port for URLs (default: ${PORT_DEFAULT})

  # Timings
  --wait-on N         waitMs for ON (default: ${WAIT_ON_DEFAULT})
  --wait-off N        waitMs for OFF (default: ${WAIT_OFF_DEFAULT})
  --quiet N           quietMs for status (default: ${QUIET_DEFAULT})
  --max N             maxMs for status (default: ${MAX_DEFAULT})
  --cache N           cacheMs for status (default: ${CACHE_DEFAULT})
  --jitter N          jitterMs for status (default: ${JITTER_DEFAULT})
  --timeout N         timeout for the accessory (default: ${TIMEOUT_DEFAULT})

Notes:
- pullInterval is randomized between 3800–4500 ms on each run.
- Requires 'jq'.
- Examples:
    $0 "Hall Eyeball" 2 20 7
    $0 -a -c /var/lib/homebridge/config.json "Dining room" 1 9 48
EOF
}

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing dependency: $1" >&2; exit 1; }; }
need jq

# Parse options
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--config) HB_CONFIG_PATH="$2"; shift 2 ;;
    -a|--apply)  APPLY=1; shift ;;
    -r|--replace) REPLACE=1; shift ;;
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --wait-on)  WAIT_ON="$2"; shift 2 ;;
    --wait-off) WAIT_OFF="$2"; shift 2 ;;
    --quiet)    QUIET_MS="$2"; shift 2 ;;
    --max)      MAX_MS="$2"; shift 2 ;;
    --cache)    CACHE_MS="$2"; shift 2 ;;
    --jitter)   JITTER_MS="$2"; shift 2 ;;
    --timeout)  TIMEOUT_MS="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*)
      echo "Unknown option: $1" >&2
      usage; exit 1
      ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- "${ARGS[@]}"

if [[ $# -lt 4 ]]; then
  echo "Error: need 4 positional args: \"<name>\" <m> <s> <b>" >&2
  usage; exit 1
fi

NAME="$1"; shift
M="$1";   shift
S="$1";   shift
B="$1";   shift

# Random pullInterval (3800–4500)
if command -v shuf >/dev/null 2>&1; then
  PULL_MS="$(shuf -i 3800-4500 -n 1)"
else
  # Fallback if shuf not available
  PULL_MS="$(( 3800 + (RANDOM % 701) ))"
fi

# Resolve config path if applying
if [[ "$APPLY" -eq 1 ]]; then
  if [[ -z "${HB_CONFIG_PATH}" ]]; then
    if [[ -f "$HB_CONFIG_DEFAULT" ]]; then
      HB_CONFIG_PATH="$HB_CONFIG_DEFAULT"
    elif [[ -f "$HOME/.homebridge/config.json" ]]; then
      HB_CONFIG_PATH="$HOME/.homebridge/config.json"
    else
      echo "Could not find Homebridge config.json. Use -c/--config PATH." >&2
      exit 1
    fi
  fi
  if [[ ! -f "$HB_CONFIG_PATH" ]]; then
    echo "Config not found: $HB_CONFIG_PATH" >&2
    exit 1
  fi
fi

# Build accessory JSON with jq to avoid any quoting issues
OBJ_JSON="$(
  jq -n \
    --arg name "$NAME" \
    --arg host "$HOST" \
    --argjson port "$(printf '%d' "$PORT")" \
    --argjson m    "$(printf '%d' "$M")" \
    --argjson s    "$(printf '%d' "$S")" \
    --argjson b    "$(printf '%d' "$B")" \
    --argjson wait_on  "$(printf '%d' "$WAIT_ON")" \
    --argjson wait_off "$(printf '%d' "$WAIT_OFF")" \
    --argjson quiet    "$(printf '%d' "$QUIET_MS")" \
    --argjson max      "$(printf '%d' "$MAX_MS")" \
    --argjson cache    "$(printf '%d' "$CACHE_MS")" \
    --argjson jitter   "$(printf '%d' "$JITTER_MS")" \
    --argjson pull     "$(printf '%d' "$PULL_MS")" \
    --argjson timeout  "$(printf '%d' "$TIMEOUT_MS")" \
  '
  {
    accessory: "HTTP-SWITCH",
    name: $name,
    switchType: "stateful",
    method: "GET",
    onUrl:   ("http://" + $host + ":" + ($port|tostring) + "/test/vsw?m=\($m)&s=\($s)&b=\($b)&state=1&waitMs=\($wait_on)"),
    offUrl:  ("http://" + $host + ":" + ($port|tostring) + "/test/vsw?m=\($m)&s=\($s)&b=\($b)&state=0&waitMs=\($wait_off)"),
    statusUrl: ("http://" + $host + ":" + ($port|tostring) + "/status/vgs?m=\($m)&s=\($s)&b=\($b)&format=bool&quietMs=\($quiet)&maxMs=\($max)&cacheMs=\($cache)&jitterMs=\($jitter)"),
    statusMethod: "GET",
    statusPattern: "^true$",
    pullInterval: $pull,
    timeout: $timeout
  }'
)"

if [[ "$APPLY" -eq 0 ]]; then
  # Just print the accessory JSON
  echo "$OBJ_JSON" | jq .
  exit 0
fi

# APPLY: inject into config.json (top-level .accessories)
TMP="$(mktemp)"
BACKUP="${HB_CONFIG_PATH}.$(date +%Y%m%d-%H%M%S).bak"

cp -a -- "$HB_CONFIG_PATH" "$BACKUP"

# Create .accessories if missing; update by name if present; else append
if [[ "$REPLACE" -eq 1 ]]; then
  # Force replace any same-name entries (remove all then append one)
  jq \
    --argjson obj "$OBJ_JSON" \
    --arg name "$NAME" \
    '
    .accessories = (
      (.accessories // []) 
      | map(select(.name != $name))
      + [$obj]
    )
    ' "$HB_CONFIG_PATH" > "$TMP"
else
  # Update if name exists, otherwise append
  jq \
    --argjson obj "$OBJ_JSON" \
    --arg name "$NAME" \
    '
    .accessories = (
      (.accessories // [])
      | if (any(.[]?; .name == $name)) 
        then map(if .name == $name then $obj else . end)
        else . + [$obj]
        end
    )
    ' "$HB_CONFIG_PATH" > "$TMP"
fi

# Validate output JSON, then atomically move
jq . "$TMP" >/dev/null
mv -- "$TMP" "$HB_CONFIG_PATH"

echo "✅ Added/updated accessory \"$NAME\" in: $HB_CONFIG_PATH"
echo "🔒 Backup saved: $BACKUP"
echo "ℹ️  pullInterval randomized to: ${PULL_MS} ms"

