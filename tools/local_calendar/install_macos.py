"""Install a dedicated launcher and append only its own Dock entry."""

import json
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import sys
from urllib.parse import unquote, urlparse

APP_ID = "de.beg.kalender.local-test"


def install(root, state):
    target = Path.home() / "Applications" / "BEG Testkalender.app"
    if target.exists():
        info = plistlib.loads((target / "Contents/Info.plist").read_bytes())
        if info.get("CFBundleIdentifier") != APP_ID:
            raise RuntimeError("Eine fremde App heißt bereits BEG Testkalender. Nicht überschrieben.")
        print(f"Dock-App bereits installiert: {target}")
    else:
        command = shlex.join([sys.executable, str(root / "tools/local_calendar/manage.py"), "start", "--open"])
        command += " >> " + shlex.quote(str(state / "launcher.log")) + " 2>&1"
        source = state / "launcher.applescript"
        source.write_text(
            "on run\n"
            "  with timeout of 3600 seconds\n"
            "    try\n"
            '      display notification "Wird gestartet. Beim ersten Start oder nach Änderungen kann dies etwas dauern." with title "BEG Testkalender"\n'
            f"      do shell script {json.dumps(command)}\n"
            "    on error\n"
            '      display dialog "Der Testkalender konnte nicht gestartet werden. Bitte Docker Desktop prüfen. Details stehen in .local-calendar/launcher.log im Kalender-Projekt." buttons {"OK"} default button "OK" with title "BEG Testkalender"\n'
            "    end try\n"
            "  end timeout\n"
            "end run\n"
            "on reopen\n  run\nend reopen\n"
        )
        built = state / "BEG Testkalender.app"
        subprocess.run(["/usr/bin/osacompile", "-o", str(built), str(source)], check=True)
        info_path = built / "Contents/Info.plist"
        info = plistlib.loads(info_path.read_bytes())
        info.update(CFBundleIdentifier=APP_ID, CFBundleName="BEG Testkalender", CFBundleDisplayName="BEG Testkalender")
        info_path.write_bytes(plistlib.dumps(info))
        iconset = state / "test-calendar.iconset"
        iconset.mkdir(exist_ok=True)
        original = state / "test-calendar.png"
        subprocess.run([
            "/usr/bin/swift", "-module-cache-path", str(state / "swift-cache"),
            str(root / "tools/local_calendar/Icon.swift"), str(original),
        ], check=True)
        for size in [16, 32, 128, 256, 512]:
            for factor, suffix in [(1, ""), (2, "@2x")]:
                subprocess.run([
                    "/usr/bin/sips", "-z", str(size * factor), str(size * factor),
                    str(original), "--out", str(iconset / f"icon_{size}x{size}{suffix}.png"),
                ], check=True, stdout=subprocess.DEVNULL)
        subprocess.run([
            "/usr/bin/iconutil", "-c", "icns", str(iconset), "-o",
            str(built / "Contents/Resources/applet.icns"),
        ], check=True)
        # osacompile may add Finder metadata incompatible with codesign. Remove
        # only that build detritus on our generated app, never quarantine flags.
        for path in [built, *built.rglob("*")]:
            attributes = subprocess.run(
                ["/usr/bin/xattr", str(path)], check=True, capture_output=True, text=True,
            ).stdout.splitlines()
            for attribute in ("com.apple.FinderInfo", "com.apple.ResourceFork"):
                if attribute in attributes:
                    subprocess.run(["/usr/bin/xattr", "-d", attribute, str(path)], check=True)
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(built)], check=True)
        target.parent.mkdir(exist_ok=True)
        shutil.copytree(built, target)

    before = subprocess.run(["/usr/bin/defaults", "export", "com.apple.dock", "-"], check=True, capture_output=True).stdout
    preferences = plistlib.loads(before)
    entries = preferences.get("persistent-apps", [])
    present = any(
        unquote(urlparse(entry.get("tile-data", {}).get("file-data", {}).get("_CFURLString", "")).path).rstrip("/") == str(target)
        for entry in entries
    )
    if not present:
        backup = state / "dock-before.plist"
        if not backup.exists():
            backup.write_bytes(before)
            backup.chmod(0o600)
        entry = {"tile-type": "file-tile", "tile-data": {"file-data": {"_CFURLString": target.as_uri() + "/", "_CFURLStringType": 15}}}
        # Append atomically; do not rewrite or reorder the user's Dock.
        xml = plistlib.dumps(entry).decode()
        subprocess.run(["/usr/bin/defaults", "write", "com.apple.dock", "persistent-apps", "-array-add", xml], check=True)
        subprocess.run(["/usr/bin/killall", "Dock"], check=True)
    print(f"Dock-Schnellstarter bereit: {target}")
