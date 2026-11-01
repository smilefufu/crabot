// A console-dependent tool needs a real console even when its owner is a GUI.
// Create it hidden from the start; retain inherited pipes and the owned PID tree.
#include <windows.h>
#include <string>
#include <iostream>

static std::wstring Quote(const std::wstring& text) {
  std::wstring result = L"\""; size_t slashes = 0;
  for (auto character : text) {
    if (character == L'\\') { slashes++; continue; }
    result.append(character == L'"' ? slashes * 2 + 1 : slashes, L'\\');
    slashes = 0; result += character;
  }
  result.append(slashes * 2, L'\\'); return result + L'"';
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) return 127;
  std::wstring command = Quote(argv[1]);
  for (int index = 2; index < argc; index++) command += L" " + Quote(argv[index]);
  STARTUPINFOW startup{}; startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION child{};
  if (!CreateProcessW(argv[1], command.data(), nullptr, nullptr, TRUE,
      CREATE_NEW_CONSOLE, nullptr, nullptr, &startup, &child)) {
    std::cerr << "Cannot start hidden console tool (Win32 " << GetLastError() << ").\n";
    return 127;
  }
  CloseHandle(child.hThread);
  DWORD code = 1;
  bool exited = WaitForSingleObject(child.hProcess, INFINITE) == WAIT_OBJECT_0
    && GetExitCodeProcess(child.hProcess, &code);
  CloseHandle(child.hProcess);
  return exited ? static_cast<int>(code) : 127;
}
