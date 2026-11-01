// Console-dependent tools run in a private Windows pseudoconsole. The caller's
// stdin/stdout/stderr stay redirected; only terminal capability queries use PTY.
#define _WIN32_WINNT 0x0A00
#define NTDDI_VERSION 0x0A000006
#include <windows.h>
#include <string>
#include <vector>
#include <thread>
#include <iostream>
#include <stdexcept>
#include <cstring>

struct Handle {
  HANDLE value = nullptr;
  void close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = nullptr; }
  ~Handle() { close(); }
};
static std::wstring Quote(const std::wstring& text) {
  std::wstring result = L"\""; size_t slashes = 0;
  for (auto character : text) {
    if (character == L'\\') { slashes++; continue; }
    result.append(character == L'"' ? slashes * 2 + 1 : slashes, L'\\');
    slashes = 0; result += character;
  }
  result.append(slashes * 2, L'\\'); return result + L'"';
}
static void Require(bool success, const char* operation) {
  if (!success) throw std::runtime_error(std::string(operation) + " (Win32 " + std::to_string(GetLastError()) + ")");
}
static void DrainTerminal(HANDLE output, HANDLE input) {
  // The fixed CLI queries its background before parsing --no-color. Respond as
  // a dark VT terminal; these are capability replies, never human input.
  std::string tail; char bytes[4096]; DWORD count;
  auto ends = [&](const std::string& value) {
    return tail.size() >= value.size() && tail.compare(tail.size() - value.size(), value.size(), value) == 0;
  };
  while (ReadFile(output, bytes, sizeof(bytes), &count, nullptr) && count) {
    for (DWORD index = 0; index < count; index++) {
      tail += bytes[index];
      const char* reply = nullptr;
      if (ends("\x1b]11;?\a") || ends("\x1b]11;?\x1b\\")) reply = "\x1b]11;rgb:0000/0000/0000\x1b\\";
      else if (ends("\x1b[c") || ends("\x1b[0c")) reply = "\x1b[?1;2c";
      else if (ends("\x1b[6n")) reply = "\x1b[1;1R";
      if (reply) { DWORD written; WriteFile(input, reply, static_cast<DWORD>(strlen(reply)), &written, nullptr); }
      if (tail.size() > 64) tail.erase(0, 32);
    }
  }
}
int wmain(int argc, wchar_t** argv) {
  if (argc < 2) return 127;
  Handle inputRead, inputWrite, outputRead, outputWrite, job, process, thread;
  HPCON console = nullptr;
  std::thread reader;
  std::vector<unsigned char> attributes;
  LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
  DWORD code = 127;
  try {
    Require(CreatePipe(&inputRead.value, &inputWrite.value, nullptr, 65536), "Create terminal input");
    Require(CreatePipe(&outputRead.value, &outputWrite.value, nullptr, 65536), "Create terminal output");
    HRESULT created = CreatePseudoConsole({4096, 32}, inputRead.value, outputWrite.value, 0, &console);
    if (FAILED(created)) throw std::runtime_error("Cannot create private tool terminal");
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    attributes.resize(size);
    auto candidate = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
    Require(InitializeProcThreadAttributeList(candidate, 1, 0, &size), "Initialize terminal attributes");
    list = candidate;
    Require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, console, sizeof(console), nullptr, nullptr), "Select private terminal");
    job.value = CreateJobObjectW(nullptr, nullptr);
    Require(job.value != nullptr, "Create tool job");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    Require(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "Bind tool lifetime");
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    startup.lpAttributeList = list;
    std::wstring command = Quote(argv[1]);
    for (int index = 2; index < argc; index++) command += L" " + Quote(argv[index]);
    PROCESS_INFORMATION child{};
    Require(CreateProcessW(argv[1], command.data(), nullptr, nullptr, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED, nullptr, nullptr, &startup.StartupInfo, &child), "Start terminal tool");
    process.value = child.hProcess; thread.value = child.hThread;
    if (!AssignProcessToJobObject(job.value, process.value)) {
      TerminateProcess(process.value, 127);
      throw std::runtime_error("Cannot own terminal tool job");
    }
    inputRead.close(); outputWrite.close();
    reader = std::thread(DrainTerminal, outputRead.value, inputWrite.value);
    Require(ResumeThread(thread.value) != static_cast<DWORD>(-1), "Start tool execution");
    thread.close();
    Require(WaitForSingleObject(process.value, INFINITE) == WAIT_OBJECT_0, "Wait for tool exit");
    Require(GetExitCodeProcess(process.value, &code), "Read tool exit");
  } catch (const std::exception& error) {
    std::cerr << "[crabot tool] " << error.what() << ".\n";
  }
  // Kill/join owned descendants, keep draining during PTY close, then release IO.
  job.close();
  inputRead.close(); outputWrite.close();
  if (console) ClosePseudoConsole(console);
  if (reader.joinable()) reader.join();
  if (list) DeleteProcThreadAttributeList(list);
  return static_cast<int>(code);
}
