#!/usr/bin/env sh

target="${1:-node12-linux-x64}"

printf "Building for target %s into ./build\\n" "${target}"

./node_modules/.bin/pkg -t "${target}" -o ./build/proxy --public run.js
