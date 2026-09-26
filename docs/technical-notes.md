# Technical notes

These notes describe the current compatibility layer and the failure modes observed while bringing MCHOSE M HUB up under Wine.

## Renderer

The desktop client is Electron. The main M HUB renderer is exposed through a custom `mchose-renderer://` scheme and loads current UI assets from MCHOSE infrastructure.

Under Wine, the CSS could load while the referenced web fonts did not. The affected families were:

- `iconfont`
- `MiSans` 400
- `MiSans` 600
- `MiSans` 700

The icon-font request could appear in Chromium resource timing with zero transferred/decoded bytes. Registering the same WOFF2 files locally with `FontFace` under their original family names fixes both normal text and pseudo-element icons.

The bridge uses Chromium remote debugging for this because it avoids modifying MCHOSE's packaged renderer files and survives app updates better than patching generated CSS/JS bundles.

## C-Media 2025 audio path

For the tested V9 Pro, M HUB creates an SDK worker with an initialization message containing:

```text
sdkType: cmedia_2025
productKey: MCHOSE V9 PRO PID14429
guid: {19A9EEE1-2AE3-44C2-98A1-019324BC0608}
```

The Windows library involved is `libs/osConfLib.dll`. Relevant exported functions include:

```text
ConfLibInitWithGUID
ConfLibUnInit
CreateDeviceList
GetDeviceCount
GetDeviceById
PropertyControl
PlayTestSound
StopTestSound
```

On Wine, `ConfLibInitWithGUID` and `CreateDeviceList` can return success while `GetDeviceCount` still returns zero for both render and capture flows. Registry-only attempts to reproduce the Windows SetupAPI device interface can make the interface enumerable, but there is no real Windows KS device object behind the symbolic link, so the native library still cannot construct a usable device list.

The current bridge therefore does not emulate that driver stack. It intercepts the child-process IPC initialization message and changes:

```text
cmedia_2025 -> fake
```

M HUB already contains a `FakeSDKService` implementing the same high-level service surface, so the device page can initialize.

## Why effects do not work

The fake SDK only provides application-side state and method responses. It does not run the C-Media Windows audio-processing objects.

On a real Windows installation, the headset uses C-Media APO components and device/endpoint properties. Those effects are software processing in the Windows audio stack rather than settings permanently stored in the headset. That is why moving the headset back to Linux does not preserve the Windows-only effects.

A real Linux implementation needs a DSP backend. The most practical direction is to translate M HUB's high-level controls to PipeWire filters rather than trying to recreate a Windows kernel audio driver inside Wine.

## Why `--inspect-brk`

Attaching after M HUB starts introduces a race: the SDK worker may be created before the hook is installed. The launcher starts Electron with a local Node inspector in break mode, installs the hook before the application main bundle continues, then sends `Runtime.runIfWaitingForDebugger`.

The debugging endpoints are bound to the local machine and are used only as a runtime injection mechanism.

## Current boundaries

This repository intentionally does not ship:

- MCHOSE installers;
- MCHOSE fonts;
- Windows system DLLs;
- C-Media driver binaries;
- modified M HUB application bundles.

Vendor assets are fetched from their official URLs during installation.
