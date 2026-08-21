# How Kalamata builds `_ColdClient`

ColdClient setup creates a separate `_ColdClient` folder inside an installed
game. It does not copy, replace, or patch the game's executable or Steam API
DLL.

The process is available only on Windows and uses three dependencies downloaded
from their upstream releases:

- GBE Fork supplies the loader, runtime DLLs, injection DLLs, and interface
  generator.
- GSE Tools generates the game's `steam_settings` directory.
- `7zr.exe` extracts both release archives.

The exact dependency sources and validation policy are documented in
[ColdClient dependency policy](coldclient-dependencies.md).

## 1. Inspect the installed game

Kalamata scans the game directory for `.exe` files and Steam API DLLs. Existing
ColdClient and Kalamata working directories are excluded from the scan.

It then prepares the setup choices:

1. If exactly one executable has `shipping` in its filename, select it.
2. If several executables have `shipping` in their filename, require the user
   to choose between those files.
3. If there is no shipping executable and the game has only one executable,
   select it.
4. If several executables remain, select the first one matched by a Windows
   Steam launch entry.
5. Require the user to choose when no launch entry identifies an executable.

For the Steam API DLL, Kalamata looks for files named `steam_api.dll` and
`steam_api64.dll`. It selects the first candidate inside a `binary` or
`binaries` directory. Without such a candidate, it selects the DLL only when
there is exactly one. Otherwise, the user must choose one.

The selected DLL determines the loader:

- `steam_api.dll` selects `steamclient_loader_x86.exe`.
- `steam_api64.dll` selects `steamclient_loader_x64.exe`.
- No Steam API DLL selects the x64 loader and skips interface generation.

Kalamata also reads the game's Windows Steam launch entries. Their arguments
are shown in the setup review and can be replaced by the user.

## 2. Generate `steam_settings`

After the user confirms the setup, Kalamata runs GSE Tools from its extracted
`generate_emu_config` directory:

```text
generate_emu_config.exe -acw <app-id>
```

GSE Tools uses `generate_emu_config/my_login.txt` and writes the result to:

```text
generate_emu_config/_OUTPUT/<app-id>/steam_settings/
```

Kalamata requires the generated directory to contain:

```text
configs.app.ini
configs.main.ini
configs.overlay.ini
configs.user.ini
steam_appid.txt
```

The value in `steam_appid.txt` must match the game being configured. Kalamata
keeps the complete generated directory, including additional files and
subdirectories produced by GSE Tools.

## 3. Assemble the new folder

Kalamata builds the new folder in a temporary directory beside the game. It
copies this fixed set of files from GBE Fork's
`release/steamclient_experimental` directory:

```text
ColdClientLoader.ini
GameOverlayRenderer.dll
GameOverlayRenderer64.dll
steamclient.dll
steamclient64.dll
extra_dlls/steamclient_extra_x86.dll
extra_dlls/steamclient_extra_x64.dll
```

It also copies exactly one loader executable:

```text
steamclient_loader_x86.exe
```

or:

```text
steamclient_loader_x64.exe
```

The other loader and unrelated files from the GBE release are not copied.

The complete GSE output from step 2 is copied into
`_ColdClient/steam_settings`.

## 4. Generate Steam interfaces

When a Steam API DLL was selected, Kalamata runs GBE Fork's interface generator
with the original DLL as its input:

```text
generate_interfaces_x64.exe <path-to-selected-steam-api-dll>
```

The generated `steam_interfaces.txt` is placed in
`_ColdClient/steam_settings`. The original Steam API DLL is only read and stays
in its original location.

This step is omitted when the game has no Steam API DLL.

## 5. Configure the loader

Kalamata updates four existing values in the copied `ColdClientLoader.ini`:

```ini
Exe=..\<selected-game-executable>
ExeCommandLine=<selected-launch-arguments>
AppId=<app-id>
DllsToInjectFolder=extra_dlls
```

The executable path is relative to `_ColdClient`, which is why it starts with
`..\`. `ExeCommandLine` is empty when no launch arguments were selected.

Both `steamclient_extra` DLLs are placed in `extra_dlls`. The loader injects
the DLL matching the game process architecture when it starts the game.

## 6. Validate and install

Before replacing the live folder, Kalamata checks that:

- every required GBE file exists;
- exactly one loader executable exists;
- all required GSE settings exist;
- `steam_appid.txt` contains the expected AppID;
- `steam_interfaces.txt` exists when a Steam API DLL was selected;
- the four loader values match the reviewed setup.

The completed folder then replaces `<game-install>/_ColdClient`. If an older
`_ColdClient` exists, full setup replaces the whole directory, including files
that were added manually.

## Final folder

An x64 setup with a selected Steam API DLL has this structure:

```text
<game-install>/
└── _ColdClient/
    ├── ColdClientLoader.ini
    ├── GameOverlayRenderer.dll
    ├── GameOverlayRenderer64.dll
    ├── steamclient.dll
    ├── steamclient64.dll
    ├── steamclient_loader_x64.exe
    ├── extra_dlls/
    │   ├── steamclient_extra_x86.dll
    │   └── steamclient_extra_x64.dll
    └── steam_settings/
        ├── configs.app.ini
        ├── configs.main.ini
        ├── configs.overlay.ini
        ├── configs.user.ini
        ├── steam_appid.txt
        ├── steam_interfaces.txt
        └── ... other files generated by GSE Tools
```

An x86 setup contains `steamclient_loader_x86.exe` instead of the x64 loader.
When no Steam API DLL was selected, `steam_interfaces.txt` is absent.

The game is started through the loader executable in `_ColdClient`. Kalamata
builds the folder but does not launch the game.

## Regeneration and core updates

Regenerating the configuration runs GSE Tools again and replaces the complete
`steam_settings` directory. It also regenerates `steam_interfaces.txt`, updates
the loader INI, and switches the loader executable if the reviewed architecture
changed. Files outside `steam_settings` that are not managed by Kalamata remain
in place.

Updating the ColdClient core copies the fixed GBE runtime files from the new GBE
release. It keeps `ColdClientLoader.ini`, `steam_settings`, the selected loader
architecture, and unrelated files unchanged.
