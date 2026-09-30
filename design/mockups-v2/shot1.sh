#!/bin/bash
# usage: shot1.sh <out.png> <width,height> <page.html>
S=/opt/hermes/.playwright/chromium_headless_shell-1234/chrome-linux/headless_shell
cd /opt/data/practis/design/mockups-v2
out="$1"; size="$2"; page="$3"
for i in $(seq 1 8); do
  rm -f "$out"
  timeout 90 $S --no-sandbox --disable-gpu --hide-scrollbars --virtual-time-budget=9000 \
    --window-size="$size" --screenshot="$out" "file://$PWD/$page" >/dev/null 2>&1
  if [ -s "$out" ]; then echo "OK try$i bytes=$(stat -c%s "$out")"; exit 0; fi
  sleep 2
done
echo "FAILED after 8 tries"
exit 1
