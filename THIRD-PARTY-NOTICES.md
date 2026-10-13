# Third-party notices

## MeltCut source code

MeltCut's own source code is licensed under the MIT License (see `LICENSE`). It is
derived from OpenCut (classic), https://github.com/opencut-app/opencut-classic, which is
also MIT licensed. The original copyright notice is kept in `LICENSE`.

The JavaScript packages MeltCut depends on are listed in `bun.lock`; each carries its own
licence inside its package. Most are MIT, Apache-2.0, ISC or BSD.

## The bundled MLT engine

The MeltCut installer includes a rendering engine in its `resources/engine` folder. MeltCut
runs it as a separate program (`melt`); it is not linked into MeltCut.

The engine is taken, unmodified, from the official Windows release of Shotcut:

- Shotcut 26.9.27, https://github.com/mltframework/shotcut/releases/tag/v26.9.27
- Only files that the Shotcut window itself needs were left out (`shotcut.exe`, its
  interface files and translations, `ffplay.exe`, `gopro2gpx.exe`, `whisper-cli.exe`).

Shotcut and the engine as distributed are licensed under the GNU General Public License,
version 3. The full licence text ships with the engine as `resources/engine/COPYING.txt`,
next to Shotcut's own `LICENSE` file.

The engine is made of many separately licensed components, including:

| Component | Licence | Source |
|---|---|---|
| MLT framework | LGPL-2.1-or-later, with some modules GPL-2.0-or-later / GPL-3.0 | https://github.com/mltframework/mlt |
| FFmpeg (built with `--enable-gpl --enable-version3`) | GPL-3.0-or-later | https://ffmpeg.org |
| Qt 6 | LGPL-3.0 | https://www.qt.io |
| frei0r plugins | GPL-2.0-or-later | https://github.com/dyne/frei0r |
| x264 | GPL-2.0-or-later | https://www.videolan.org/developers/x264.html |
| x265 | GPL-2.0-or-later | https://www.x265.org |
| libvpx, libaom, dav1d, SVT-AV1, Opus, Vorbis, LAME and others | BSD-style, LGPL | see Shotcut's credits |

The complete list, with links to every component, is maintained by the Shotcut project at
https://shotcut.org/credits/.

### Source code for the engine

The corresponding source code for the engine binaries is published by their authors:

- Shotcut and its build scripts, which fetch and build every component above at the
  versions used for this release:
  https://github.com/mltframework/shotcut/tree/v26.9.27 (see `scripts/build-shotcut.sh`
  and `scripts/build-shotcut-msys2.sh`)
- MLT: https://github.com/mltframework/mlt

If you received MeltCut with this engine and cannot obtain that source from the links
above, open an issue in the MeltCut repository and it will be provided.

### Replacing the engine

You may replace the bundled engine with your own build. MeltCut uses, in this order: a
folder chosen with "Locate MLT" in the export panel, the folder named by the `MLT_BIN_DIR`
environment variable, the bundled engine, and a Shotcut or Kdenlive installation.

### Codecs

Some formats the engine can write, such as H.264, HEVC and AAC, are covered by patents in
some countries. Whether you need a licence to use or distribute files in those formats
depends on where you are and what you do with them.

## Not affiliated

MeltCut is an independent project. It is not affiliated with or endorsed by OpenCut,
Shotcut, Meltytech, the MLT project or KDE.
