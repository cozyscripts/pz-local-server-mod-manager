# Mod Troubleshooting

Project Zomboid multiplayer needs three separate lines:

- `WorkshopItems=` numeric Steam Workshop IDs
- `Mods=` internal Mod IDs from `mod.info`
- `Map=` map folders, with `Muldraugh, KY` last

The manager scans downloaded Workshop folders to rebuild those lines. It also detects legacy collection/dependency items that contain no loadable `mod.info`; those are kept in manager history but skipped from `WorkshopItems=` so Project Zomboid does not get stuck trying to subscribe to non-loadable dependencies.

If a server test fails, open **Changes**. The diagnostic engine highlights known failures such as corrupt server DBs, duplicate map folders, Steam subscribe failures, and Workshop manifest mismatches.
