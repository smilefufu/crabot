# Crabot native host foundation

This module supplies OS facts and narrow native operations through Node-API, plus the native `crabot` launcher. It contains no Agent, configuration migration, Electron UI or service coordinator. JavaScript callers remain responsible for authorization, ownership scope and lifecycle policy; observing or submitting an operation is not proof that a whole business operation completed.

Build with Node 22.22.3 and the platform C++ compiler:

```sh
node scripts/build-native.mjs
```

The build verifies pinned Node headers (and the Windows import library) by SHA-256. Runtime users do not need a compiler. Outputs are `crabot-native/build/Release/crabot-native.node` and `crabot` (`crabot.exe` on Windows). The launcher resolves only a complete selected bundled installation and preserves command arguments and process exit status.

The `Native foundation` workflow independently builds and tests this branch on Ubuntu, macOS ARM/Intel and Windows without installing SDK, UI or business-module dependencies. Its exact test command is in `.github/workflows/native-foundation.yml`. File metadata in this boundary is read-only; workspace relocation orchestration and Shared contracts are delivered separately.
