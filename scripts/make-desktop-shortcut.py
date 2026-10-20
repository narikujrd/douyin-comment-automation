# -*- coding: utf-8 -*-
"""
Make a desktop shortcut for the local console (3-控制台.bat).

Why this lives in the repo instead of being a one-off:
  desktop shortcuts pointing at this project HAVE been wiped before
  (app upgrades clean up custom .lnk files, and moving the project
  breaks the target). When the icon on the desktop stops working,
  re-run this file:

      <venv python> scripts/make-desktop-shortcut.py

  It is idempotent: overwrites the .lnk and the icon, touches nothing
  else. Uses win32com (WScript.Shell) because the PowerShell route to
  build .lnk files is blocked by the local security policy.

Run with the isolated venv python (needs pywin32 + pillow):
  <your-venv>/Scripts/python.exe   (needs pywin32 + pillow)
"""

import os
import sys
import ctypes

from PIL import Image, ImageDraw
import win32com.client

# ---- paths (self-locating: script may be re-run from anywhere) ----
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BAT = os.path.join(PROJ, "3-控制台.bat")
ASSETS = os.path.join(PROJ, "assets")
ICON = os.path.join(ASSETS, "console.ico")

LNK_NAME = "抖音回复控制台.lnk"
DESC = "双击打开控制台：选择要自动回复的作品、配置机器人人设。窗口开着=控制台在跑，关掉即停止。页面仅本机可访问。"


def find_desktop():
    """Real desktop (handles the OneDrive-redirect case)."""
    home = os.path.expanduser("~")
    for cand in (
        os.path.join(home, "Desktop"),
        os.path.join(home, "OneDrive", "Desktop"),
        os.path.join(home, "OneDrive", "桌面"),
        os.path.join(home, "桌面"),
    ):
        if os.path.isdir(cand):
            return cand
    return None


def draw_icon(size):
    """Dark squircle + white speech bubble + cyan/rose dots (douyin-ish)."""
    ss = 4  # supersample for clean edges
    s = size * ss
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle(
        [0, 0, s - 1, s - 1], radius=int(s * 0.225), fill=(26, 29, 41, 255)
    )

    bx0, by0 = s * 0.155, s * 0.175
    bx1, by1 = s - s * 0.155, s - s * 0.335
    d.rounded_rectangle(
        [bx0, by0, bx1, by1], radius=int((bx1 - bx0) * 0.24), fill=(255, 255, 255, 255)
    )

    # bubble tail (bottom-left)
    tw = (bx1 - bx0) * 0.17
    th = (by1 - by0) * 0.40
    tx = bx0 + (bx1 - bx0) * 0.17
    d.polygon(
        [(tx, by1 - 1), (tx + tw, by1 - 1), (tx + tw * 0.1, by1 + th)],
        fill=(255, 255, 255, 255),
    )

    # three dots
    cy = (by0 + by1) / 2
    rd = (by1 - by0) * 0.112
    gap = (bx1 - bx0) * 0.24
    cx = (bx0 + bx1) / 2
    for i, col in enumerate(
        [(37, 244, 238, 255), (254, 44, 85, 255), (37, 244, 238, 255)]
    ):
        x = cx + (i - 1) * gap
        d.ellipse([x - rd, cy - rd, x + rd, cy + rd], fill=col)

    return img.resize((size, size), Image.LANCZOS)


def build_icon():
    sizes = [256, 128, 64, 48, 32, 24, 16]
    os.makedirs(ASSETS, exist_ok=True)
    imgs = [draw_icon(sz) for sz in sizes]
    try:
        imgs[0].save(
            ICON,
            format="ICO",
            sizes=[(sz, sz) for sz in sizes],
            append_images=imgs[1:],
        )
    except Exception as exc:  # older Pillow: single-image fallback
        print("    (append_images unsupported, resize-only fallback: %s)" % exc)
        imgs[0].save(ICON, format="ICO", sizes=[(sz, sz) for sz in sizes])
    got = sorted(Image.open(ICON).info.get("sizes", []))
    return got


def main():
    if not os.path.isfile(BAT):
        print("[X] target bat not found: %s" % BAT)
        return 1
    print("[1] target  OK : %s" % BAT)

    desktop = find_desktop()
    if not desktop:
        print("[X] could not locate the desktop folder")
        return 1
    lnk_path = os.path.join(desktop, LNK_NAME)
    print("[2] desktop OK : %s" % desktop)

    got = build_icon()
    print("[3] icon saved : %s  (sizes: %s)" % (ICON, got))

    shell = win32com.client.Dispatch("WScript.Shell")
    sc = shell.CreateShortCut(lnk_path)
    sc.TargetPath = BAT
    sc.WorkingDirectory = PROJ
    sc.IconLocation = ICON + ",0"
    sc.Description = DESC
    sc.Save()
    print("[4] shortcut   : %s" % lnk_path)

    # read back and verify everything resolves
    v = shell.CreateShortCut(lnk_path)
    ok = True
    checks = [
        ("TargetPath      ", v.TargetPath, os.path.isfile(v.TargetPath)),
        ("WorkingDirectory", v.WorkingDirectory, os.path.isdir(v.WorkingDirectory)),
        ("IconLocation    ", v.IconLocation, os.path.isfile(v.IconLocation.split(",")[0])),
    ]
    print("[5] verify:")
    for label, val, good in checks:
        print("      %s : %s  [%s]" % (label, val, "OK" if good else "MISSING"))
        ok = ok and good

    # ask Explorer to refresh so the icon shows up immediately
    try:
        ctypes.windll.shell32.SHChangeNotify(0x08000000, 0x0000, None, None)  # SHCNE_ASSOCCHANGED
        print("[6] explorer notified (icon should appear without F5)")
    except Exception as exc:
        print("[6] explorer notify skipped: %s" % exc)

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
