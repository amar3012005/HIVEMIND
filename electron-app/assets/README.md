# Assets Required

Before building, add these files:

| File | Size | Purpose |
|------|------|---------|
| `icon.icns` | Any | Mac app icon (dock + Finder) |
| `icon.png` | 512×512 | Window icon fallback |
| `tray-icon.png` | 16×16 or 32×32 @2x | Menu bar tray icon (use template image style — black on transparent) |
| `dmg-background.png` | 540×380 px | DMG installer background |

## Generating icon.icns from a PNG

```bash
# From a 1024x1024 PNG called source.png:
mkdir icon.iconset
sips -z 16 16     source.png --out icon.iconset/icon_16x16.png
sips -z 32 32     source.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     source.png --out icon.iconset/icon_32x32.png
sips -z 64 64     source.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   source.png --out icon.iconset/icon_128x128.png
sips -z 256 256   source.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   source.png --out icon.iconset/icon_256x256.png
sips -z 512 512   source.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   source.png --out icon.iconset/icon_512x512.png
sips -z 1024 1024 source.png --out icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset
mv icon.icns assets/icon.icns
```
