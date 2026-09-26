# Beta audio backend

The `beta` branch is where the real Linux audio backend for MCHOSE headsets is being developed.

The current stable workaround keeps M HUB usable by replacing the failing `cmedia_2025` worker backend with M HUB's built-in fake SDK. That opens the V9 Pro UI, but the fake SDK only stores UI state. It does not process PipeWire audio.

The beta work has two stages:

1. record the exact SDK IPC emitted by M HUB for every V9 Pro control;
2. map those calls to a Linux backend that controls PipeWire and the real USB/HID device where appropriate.

## Capture V9 Pro SDK traffic

Start M HUB normally with `mhub-linux`, but do not open the V9 Pro page yet.

From a clone of this branch:

```bash
git clone -b beta https://github.com/hiworld1231/mhub-linux.git
cd mhub-linux
npm install
node tools/sdk-trace.mjs --output v9-pro-sdk.jsonl
```

Leave the tracer running. Open V9 Pro and change one control at a time. Wait about a second between changes so the resulting trace is easy to read.

Suggested capture order:

- output volume: 80 -> 50 -> 80
- microphone volume: 92 -> 50 -> 92
- AI noise reduction: off -> on -> off
- microphone monitoring: off -> on -> off
- magic voice: cycle every available mode
- Audio Brilliant: off -> on, then min/mid/max intensity
- Dynamic LF / Virtual Bass: off -> on, then min/mid/max intensity and every cutoff option
- Adaptive Volume: off -> on, then min/mid/max and both content modes
- Voice Clarity: off -> on, then min/mid/max for both controls
- EQ: toggle, load one preset, then move one band at a time
- Sound Mode: select each mode
- 7.1: toggle, select each mode and each room size

Stop the tracer with Ctrl+C. The output is JSONL, one IPC message per line.

## What will be implemented first

The first real backend target is the boring but useful stuff:

- output volume and mute
- microphone volume and mute
- microphone monitoring / sidetone if exposed through the device or PipeWire
- EQ

After that:

- bass enhancement
- adaptive volume / compressor
- voice clarity
- virtual surround
- microphone noise reduction
- voice effects

Some controls may turn out to be direct HID/USB commands rather than C-Media DSP calls. Those should be sent to the device directly instead of being approximated in PipeWire.

## Goal

The target user experience is still:

```bash
mhub-linux
```

M HUB remains the UI. The compatibility bridge translates its audio-control calls to Linux in real time, persists state, and restores it on startup.

The project will not claim bit-identical Windows C-Media DSP unless that is actually verified. The practical goal is to make every visible V9 Pro control functional on Linux, using native device commands where possible and PipeWire DSP where necessary.
