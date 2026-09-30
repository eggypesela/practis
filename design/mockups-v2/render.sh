#!/bin/bash
# Render PRACTIS mockups (Inter everywhere — option A).
# Hard-won flags on this box:
#   ulimit -c 0                        -> Chrome segfaults otherwise drop a 150M+ `core` in cwd
#   TMPDIR=/opt/data/tmp               -> root overlay is only ~120M free
#   --disable-dev-shm-usage            -> /dev/shm is 64M; crashes without it
#   --run-all-compositor-stages-before-draw -> otherwise screenshot sometimes never writes
# Serialize (never parallel) - 8 zombie Chromiums exhaust the 2G RAM.
ulimit -c 0
export TMPDIR=/opt/data/tmp
S=/opt/hermes/.playwright/chromium_headless_shell-1234/chrome-linux/headless_shell
cd /opt/data/practis/design/mockups-v2
mkdir -p shots
fail=0
for f in 01-design-system 02-dashboard 03-ledger 04-lpb 05-collapsed; do
  for spec in "1440,1150 d" "430,1500 m"; do
    size=${spec%% *}; pre=${spec##* }
    out=shots/$pre-$f.png
    rm -f "$out"
    for try in 1 2 3; do
      timeout 90 $S --no-sandbox --disable-gpu --disable-dev-shm-usage --hide-scrollbars \
        --run-all-compositor-stages-before-draw \
        --window-size="$size" --screenshot="$out" "file://$PWD/$f.html" >/dev/null 2>&1
      [ -s "$out" ] && break
      sleep 2
    done
    if [ -s "$out" ]; then echo "OK   $out $(stat -c%s "$out")"; else echo "FAIL $out"; fail=1; fi
  done
done
exit $fail
