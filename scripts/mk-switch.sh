#!/usr/bin/env bash
# mk-switch-json.sh  — usage: ./mk-switch-json.sh "<name>" <m> <s> <b>
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "usage: $0 <name> <m> <s> <b>" >&2
  exit 1
fi

name="$1"
m="$2"
s="$3"
b="$4"

# random integer in [3800, 4500]
pullInterval=$(( 3800 + RANDOM % (4500 - 3800 + 1) ))

onUrl="http://127.0.0.1:3000/test/vsw?m=${m}&s=${s}&b=${b}&state=1&waitMs=800"
offUrl="http://127.0.0.1:3000/test/vsw?m=${m}&s=${s}&b=${b}&state=0&waitMs=500"
statusUrl="http://127.0.0.1:3000/status/vgs?m=${m}&s=${s}&b=${b}&format=bool&quietMs=180&maxMs=3500&cacheMs=4000&jitterMs=0"

jq -n \
  --arg name "$name" \
  --arg onUrl "$onUrl" \
  --arg offUrl "$offUrl" \
  --arg statusUrl "$statusUrl" \
  --argjson pullInterval "$pullInterval" \
  --argjson timeout 3000 \
  '{
    accessory: "HTTP-SWITCH",
    name: $name,
    switchType: "stateful",
    method: "GET",
    onUrl: $onUrl,
    offUrl: $offUrl,
    statusUrl: $statusUrl,
    statusMethod: "GET",
    statusPattern: "^true$",
    pullInterval: $pullInterval,
    timeout: $timeout
  }'

