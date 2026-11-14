#!/usr/bin/env bash
# Builds the NEAR contracts to wasm (output: near/target/near/<crate>/<crate>.wasm).
set -euo pipefail
cd "$(dirname "$0")/.."
for c in pool mock-ft; do
  (cd "contracts/$c" && cargo near build non-reproducible-wasm)
done
ls -l target/near/*/*.wasm
