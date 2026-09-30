#!/usr/bin/env python3
"""Download woff2 files for the mono-font comparison (offline-safe render)."""
import re, os, subprocess, sys

OUT = "/opt/data/practis/design/mockups-v2/fonts"
os.makedirs(OUT, exist_ok=True)

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

FAMILIES = {
    "Inter": "Inter:wght@400;500;600;700",
    "IBMPlexMono": "IBM+Plex+Mono:wght@400;500;600",
    "GeistMono": "Geist+Mono:wght@400;500;600",
    "RobotoMono": "Roboto+Mono:wght@400;500;600",
    "SplineSansMono": "Spline+Sans+Mono:wght@400;500;600",
    "DMMono": "DM+Mono:wght@400;500",
    "MartianMono": "Martian+Mono:wght@400;500;600",
}

def fetch(url):
    r = subprocess.run(["curl", "-sS", "-A", UA, url], capture_output=True, text=True, timeout=60)
    return r.stdout

faces = []
for key, spec in FAMILIES.items():
    css = fetch(f"https://fonts.googleapis.com/css2?family={spec}&display=swap")
    if not css.strip():
        print(f"  !! no css for {key}")
        continue
    # only keep latin blocks
    blocks = re.findall(r"/\*\s*([\w\-\[\]]+)\s*\*/\s*@font-face\s*\{(.*?)\}", css, re.S)
    n = 0
    for subset, body in blocks:
        if subset != "latin":
            continue
        m_url = re.search(r"url\((https://[^)]+\.woff2)\)", body)
        m_w = re.search(r"font-weight:\s*([\d ]+)", body)
        if not m_url:
            continue
        w = (m_w.group(1).strip() if m_w else "400")
        fn = f"{key}-{w.replace(' ', '_')}.woff2"
        path = os.path.join(OUT, fn)
        if not os.path.exists(path) or os.path.getsize(path) < 1000:
            subprocess.run(["curl", "-sS", "-A", UA, "-o", path, m_url.group(1)], timeout=60)
        if os.path.getsize(path) < 1000:
            print(f"  !! empty {fn}")
            continue
        n += 1
        faces.append(
            "@font-face{font-family:'%s';font-style:normal;font-weight:%s;font-display:swap;"
            "src:url('fonts/%s') format('woff2')}" % (key, w, fn)
        )
    print(f"{key}: {n} face(s)")

with open("/opt/data/practis/design/mockups-v2/fonts-local.css", "w") as f:
    f.write("\n".join(faces) + "\n")
print("wrote fonts-local.css", len(faces), "faces")
