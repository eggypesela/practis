#!/bin/bash
# Render one PRACTIS mockup page.
#   usage: ./render1.sh <page-basename> <WxH> <out.png>
#
# Hard-won flags on this 2G-RAM / 7.2G-root box — Chrome silently fails to write
# the screenshot when any of these are missing:
#   ulimit -c 0            -> else a segfault drops a 150M+ `core` in cwd
#   TMPDIR=/opt/data/tmp   -> root overlay has only ~120M free
#   --disable-dev-shm-usage-> /dev/shm is only 64M
#   --user-data-dir on the USB -> DEFAULT profile dir stays locked by leftover
#                                 Chromium zombies and renders fail silently.
#                                 This was the real cause of repeated FAILs.
#   --run-all-compositor-stages-before-draw -> else the shot sometimes never flushes
# Serialize; never run two at once (RAM).
ulimit -c 0
export TMPDIR=/opt/data/tmp
S=/opt/hermes/.playwright/chromium_headless_shell-1234/chrome-linux/headless_shell
cd /opt/data/practis/design/mockups-v2
page="$1"; size="$2"; out="$3"
rm -f "$out"
for try in 1 2 3 4; do
  pkill -9 -f "headless_shel[l]" 2>/dev/null; sleep 1
  prof=$(mktemp -d /opt/data/tmp/chp-XXXXXX)
  timeout 90 $S --no-sandbox --disable-gpu --disable-dev-shm-usage --disable-web-security \
    --single-process --hide-scrollbars \
    --user-data-dir="$prof" --run-all-compositor-stages-before-draw \
    --window-size="$size" --screenshot="$out" "file://$PWD/$page.html" >/dev/null 2>&1
  rm -rf "$prof"
  if [ -s "$out" ]; then echo "OK $out $(stat -c%s "$out")"; exit 0; fi
  sleep 2
done
echo "FAIL $out"; exit 1
