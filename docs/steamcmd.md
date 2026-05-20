# SteamCMD Fallback

Steam can rate-limit Workshop page/API requests or fail to download an item during Host startup. The dashboard caches Workshop metadata in `%APPDATA%\PZLocalModManager\workshop-cache.sqlite` and can use SteamCMD to pre-sync Workshop folders.

Use **Install SteamCMD** once, then **Test Mods On Server** or **Scan Downloaded Mods**. If Steam returns 429, the manager falls back to cached metadata and local/SteamCMD Workshop files where possible.

Some Workshop items cannot be downloaded anonymously through SteamCMD. In that case, subscribe/update them in Steam, let the game download them, then scan again.
