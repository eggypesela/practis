#!/bin/bash
# Screenshot the live PRACTIS dev server page (authed via a cookie set by caller).
# usage: appshot.sh <url> <out.png> <W,H>
# Chrome flags are the hard-won set for this 2G-RAM / 7.2G-root box (see
# design/mockups-v2/render1.sh): --single-process avoids renderer OOM at 1440px.
ulimit -c 0
export TMPDIR=/opt/data/tmp
S=/opt/hermes/.playwright/chromium_headless_shell-1234/chrome-linux/headless_shell
URL="$1"; OUT="$2"; SIZE="$3"
rm -f "$OUT"
prof=$(mktemp -d /opt/data/tmp/ap-XXXXXX)
timeout 90 "$S" --no-sandbox --disable-gpu --disable-dev-shm-usage --single-process \
  --allow-file-access-from-files --hide-scrollbars --user-data-dir="$prof" \
  --run-all-compositor-stages-before-draw --window-size="$SIZE" \
  --screenshot="$OUT" "$URL" 2>&1 | grep -viE "dbus|DevTools|Fontconfig|bus\.cc|dns_config|audio_manager|vaapi" | head -3
rm -rf "$prof"
if [ -s "$OUT" ]; then echo "OK $OUT $(stat -c%s "$OUT")"; else echo "FAIL $OUT"; fi