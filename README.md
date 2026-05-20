# PZ Local Server Mod Manager

Lightweight Windows dashboard for managing a local Project Zomboid Build 42 Host profile. It edits your normal `Zomboid\Server` files, manages Workshop IDs/internal Mod IDs/map folders, and helps test a modded server locally.

## Download And Run

1. Download the latest `PZLocalModManager-*.zip` from GitHub Releases.
2. Extract it anywhere, such as your Desktop.
3. Run `start-manager.bat`.
4. The launcher checks for Node.js 18+, installs app dependencies if needed, starts the dashboard, and opens `http://localhost:8787`.

Runtime state is stored in `%APPDATA%\PZLocalModManager`, not beside the app. You can delete and replace the app folder without losing your manager settings.

## First Launch

The app detects:

- Steam from the Windows registry and common install folders.
- Project Zomboid under `Steam\steamapps\common\ProjectZomboid`.
- Host profiles under `%USERPROFILE%\Zomboid\Server`.

Open **Settings** if any path is wrong. Pick an existing Host profile or create a new one in the sidebar.

## Everyday Workflow

1. Add a Workshop item from the Workshop tab.
2. The manager resolves dependencies, internal Mod IDs, and map folders.
3. Use **Scan Downloaded Mods** after Steam finishes downloading Workshop content.
4. Use **Launch Project Zomboid**, then in-game choose **Host** and the same profile.
5. Use **Test Mods On Server** for a headless dedicated-server smoke test.

## Developer Setup

```powershell
npm install
npm start
```

To build a release zip:

```powershell
.\scripts\package-release.ps1 -Version 1.0.0
```

## Docs

- [Port forwarding](docs/port-forwarding.md)
- [Build 42 setup](docs/build-42.md)
- [SteamCMD fallback](docs/steamcmd.md)
- [Mod troubleshooting](docs/mod-troubleshooting.md)
