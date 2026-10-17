#ifdef _WIN32
#include <windows.h>
#include <delayimp.h>
#include <cstring>

// Resolve the stable Node-API imports against the loading host. Looking up a
// separate node.exe through PATH would bind an Electron env to another runtime.
// https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules
static FARPROC WINAPI ResolveNodeHost(unsigned event, DelayLoadInfo* information) {
  if (event != dliNotePreLoadLibrary || _stricmp(information->szDll, "node.exe") != 0) return nullptr;
  HMODULE host = GetModuleHandleW(L"libnode.dll");
  if (!host) host = GetModuleHandleW(nullptr);
  return reinterpret_cast<FARPROC>(host);
}

decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = ResolveNodeHost;
#endif
