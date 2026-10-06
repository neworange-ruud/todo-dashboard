#!/bin/zsh
set -e

here=${0:A:h}
app="$here/.build/Buddy.app"
contents="$app/Contents"
mkdir -p "$contents/MacOS" "$contents/Resources"

# Command Line Tools work even if the full Xcode license is pending.
DEVELOPER_DIR=/Library/Developer/CommandLineTools swiftc \
  -module-name Buddy -framework AppKit -framework WebKit -framework AVFoundation -framework NaturalLanguage \
  "$here/CalendarService.swift" "$here/ConversationService.swift" \
  "$here/VoiceService.swift" "$here/main.swift" -o "$contents/MacOS/Buddy"
cp -f "$here/Info.plist" "$contents/Info.plist"
cp -f "$here/assets/"portrait-*.png "$here/assets/"iris-*.png "$here/assets/index.html" "$contents/Resources/"
cp -f "$here/assets/Buddy.icns" "$contents/Resources/Buddy.icns"
codesign --force --sign - "$app"

if [[ -z "${BUDDY_GRAPH_ENV_FILE:-}" && -f "$here/../.env" ]]; then
  export BUDDY_GRAPH_ENV_FILE="$here/../.env"
fi
running=$(pgrep -f "$contents/MacOS/Buddy" || true)
if [[ -n "$running" ]]; then
  kill ${=running} 2>/dev/null || true
fi
nohup "$contents/MacOS/Buddy" >/dev/null 2>&1 &
