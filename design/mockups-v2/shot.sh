#!/bin/bash
S=/opt/hermes/.playwright/chromium_headless_shell-1234/chrome-linux/headless_shell
cd /opt/data/practis/design/mockups-v2
for f in 01-design-system 02-dashboard 03-ledger 04-lpb 05-collapsed; do
  timeout 60 $S --no-sandbox --disable-gpu --hide-scrollbars --window-size=1440,1150 \
    --screenshot=shots/d-$f.png "file://$PWD/$f.html" >/dev/null 2>&1
  timeout 60 $S --no-sandbox --disable-gpu --hide-scrollbars --window-size=430,1400 \
    --screenshot=shots/m-$f.png "file://$PWD/$f.html" >/dev/null 2>&1
done
echo DONE
