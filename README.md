# mhub-linux

Run the Windows MCHOSE M HUB desktop client on Linux with Wine, including the renderer fixes needed for missing fonts/icons and an optional compatibility shim for C-Media audio devices.

> [!IMPORTANT]
> **The audio compatibility shim does not implement MCHOSE/C-Media DSP effects.** It replaces the failing `cmedia_2025` backend with M HUB's built-in `FakeSDKService`, which makes supported headset pages open and keeps the UI usable, but EQ, virtual bass, surround, voice clarity, noise reduction, etc. do not process Linux audio yet.

MCHOSE does not officially support the desktop client on Linux. This project is an unofficial compatibility layer.

## Status

| Feature | Status |
| --- | --- |
| M HUB desktop client under Wine | Working |
| M HUB web/remote renderer | Working |
| Missing MiSans font | Fixed |
| Missing icon font | Fixed |
| Mouse/keyboard pages | Works when Wine can access the device |
| C-Media 2025 headset page | Opens with compatibility shim |
| C-Media APO/DSP audio effects | **Not implemented** |
| Firmware updates through Wine | **Not recommended** |

The compatibility shim was tested with an **MCHOSE V9 Pro** (`VID_291D&PID_385D`) and the current M HUB desktop client. Other `cmedia_2025` devices may benefit from the same shim, but have not all been tested.

## Quick install

### One command

```bash
curl -fsSL https://raw.githubusercontent.com/hiworld1231/mhub-linux/main/install.sh | bash
```

The installer:

1. installs missing runtime packages on Arch/CachyOS/Manjaro, Debian/Ubuntu, or Fedora;
2. creates an isolated Wine prefix under `~/.local/share/mhub-linux/prefix`;
3. downloads the latest M HUB installer from the official MCHOSE CDN;
4. installs M HUB silently with Wine;
5. downloads the MCHOSE icon font and MiSans files from MCHOSE's CDN;
6. installs the runtime bridge and a `mhub-linux` launcher;
7. creates a desktop entry.

### From a clone

```bash
git clone https://github.com/hiworld1231/mhub-linux.git
cd mhub-linux
./install.sh
```

## Run

```bash
mhub-linux
```

The launcher starts M HUB with two local-only Chromium/Node inspector ports. The bridge attaches immediately, installs the audio compatibility hook before the Electron main process continues, then injects the local font files into M HUB renderer targets.

Logs are written to:

```text
~/.local/state/mhub-linux/bridge.log
~/.local/state/mhub-linux/wine.log
```

### Run without the audio shim

If you only want the renderer/font fixes and want M HUB to try its original Windows audio backend:

```bash
mhub-linux --no-audio-shim
```

On normal Wine this usually ends with C-Media device discovery failing because the Windows kernel/KS audio driver stack is not present.

### Stop M HUB

```bash
mhub-linux --stop
```

### Diagnostics

```bash
mhub-linux --doctor
```

## What the audio shim actually does

M HUB starts an SDK worker and sends an initialization message similar to:

```json
{
  "type": "init",
  "sdkType": "cmedia_2025",
  "productKey": "MCHOSE V9 PRO PID14429"
}
```

Under Wine, the C-Media configuration library can initialize, but its Windows audio-device discovery cannot build a usable device list. The bridge intercepts that worker initialization message before it is sent and changes only:

```text
cmedia_2025 -> fake
```

M HUB already ships `FakeSDKService`, so the UI can initialize without emulating a Windows kernel audio driver.

This is deliberately **not described as an audio-effects fix**. The fake service stores UI state; it does not run the proprietary C-Media APO/DSP chain against PipeWire audio.

## Font/icon fix

The renderer can load M HUB's CSS under Wine while Chromium fails to fetch/decode the referenced WOFF2 resources. Typical symptoms are blank icons and fallback fonts.

The installer downloads these resources directly from MCHOSE's CDN:

- `iconfont.woff2`
- `MiSans-Regular.woff2`
- `MiSans-Semibold.woff2`
- `MiSans-Bold.woff2`

The runtime bridge registers them with the renderer using `FontFace` under their original family names (`iconfont` and `MiSans`) and applies a small CSS override. No font files are redistributed by this repository.

## Official M HUB download

MCHOSE's current official download page is:

https://www.mchose.store/pages/mchose-hub

The page currently points the Windows desktop driver at:

https://cdn.mchose.com.cn/MCHOSE_HUB_installer.zip

`install.sh` uses that official CDN URL by default. Override it if MCHOSE changes the download location:

```bash
MHUB_INSTALLER_URL='https://example.invalid/new-installer.zip' ./install.sh
```

## Network fallback page

M HUB occasionally opens its own "load failed" page under Wine after Chromium TLS errors. In testing, restarting M HUB is usually enough:

```bash
mhub-linux --stop
mhub-linux
```

The launcher disables QUIC and HTTP/2 by default because that was more reliable in Wine. To also bypass the system proxy for M HUB:

```bash
MHUB_NO_PROXY=1 mhub-linux
```

## Device permissions

If a keyboard or mouse is not visible to Wine, first check the Linux side:

```bash
lsusb
ls -l /dev/hidraw*
```

Modern desktop distributions normally grant active users access through udev/logind. Avoid blanket `MODE=0666` hidraw rules. Add a device-specific udev rule only if your distribution actually needs one.

## Firmware updates

Do not use this project as a reason to flash device firmware through Wine. Firmware update paths may depend on Windows USB/HID behavior and a failed update can leave hardware unusable. Use a supported Windows installation for firmware updates.

## Requirements

- x86_64 Linux
- Wine
- Node.js 18+
- npm
- curl
- unzip

The install script can install these automatically on several common distributions.

## Files

```text
install.sh             installer/bootstrap
scripts/mhub-linux     launcher and diagnostics
src/bridge.mjs         Electron inspector bridge
package.json           runtime dependency (`ws`)
docs/technical-notes.md reverse-engineering notes and current limitations
uninstall.sh           removes the local installation
```

## Roadmap

The missing piece is a real Linux audio backend. A useful implementation would map M HUB's existing audio-control calls to PipeWire filters (or another Linux DSP host) instead of `FakeSDKService`. That would preserve the M HUB UI while making EQ/surround/bass/voice controls affect real audio.

## Disclaimer

This project is not affiliated with or endorsed by MCHOSE or C-Media. MCHOSE, M HUB, product names, driver files, fonts, and other vendor assets belong to their respective owners. The installer downloads vendor files directly from vendor-controlled URLs instead of redistributing them.

## License

MIT. See [LICENSE](LICENSE).
