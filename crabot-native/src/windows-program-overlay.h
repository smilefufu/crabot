// Installer-only overlay. All occupancy decisions precede program mutation;
// identical runtime files stay in place even while background tasks use them.
#include <wincrypt.h>
#include <restartmanager.h>
#include <algorithm>
#include <fstream>
#include <map>
#include <set>
#include <memory>
#include <stdexcept>

namespace WindowsOverlay {
using Path = std::filesystem::path;
using Handle = std::unique_ptr<void, decltype(&CloseHandle)>;
struct Failure { DWORD error; Path file; const char* stage; };
static void Fail(const char* stage, const Path& file, DWORD error = GetLastError()) { throw Failure{error, file, stage}; }
static std::wstring Wide(const std::string& value) {
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (!size) Fail("utf8", {}, ERROR_INVALID_DATA);
  std::wstring result(size, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size);
  return result;
}
static std::string Utf8(const std::wstring& value) {
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string result(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
  return result;
}
static std::wstring Key(std::wstring value) {
  std::replace(value.begin(), value.end(), L'/', L'\\');
  CharLowerBuffW(value.data(), static_cast<DWORD>(value.size())); return value;
}
static std::wstring Runtime(const std::wstring& relative) {
  const std::wstring product = L"program\\core\\.product-runtime\\";
  if (relative.rfind(product, 0) == 0) {
    const auto end = relative.find(L'\\', product.size());
    return relative.substr(0, end == std::wstring::npos ? product.size() : end);
  }
  for (const auto& prefix : {L"program\\core\\.scrapling-runtime-", L"program\\core\\.computer-use-runtime\\"}) {
    if (relative.rfind(prefix, 0) == 0) return prefix;
  }
  return L"";
}
struct Target { std::string sha; std::wstring relative; };
static std::map<std::wstring, Target> ReadTargets(const Path& file) {
  std::ifstream input(file, std::ios::binary);
  if (!input) Fail("read-file-table", file, ERROR_READ_FAULT);
  std::map<std::wstring, Target> targets;
  for (std::string line; std::getline(input, line);) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const auto tab = line.find('\t');
    if (tab == std::string::npos) Fail("file-table", file, ERROR_INVALID_DATA);
    const auto sha = line.substr(0, tab); auto name = Key(Wide(line.substr(tab + 1)));
    if (sha != "-" && (sha.size() != 64 || sha.find_first_not_of("0123456789abcdef") != std::string::npos)) Fail("file-table-hash", file, ERROR_INVALID_DATA);
    if (!(name.rfind(L"program\\core\\", 0) == 0 || name.rfind(L"program\\gui\\", 0) == 0
      || name == L"bin\\crabot.exe" || name == L"program\\desktop-payload.json")
      || name.find_first_of(L":*?\t\r\n") != std::wstring::npos) Fail("file-table-path", file, ERROR_INVALID_NAME);
    for (const auto& part : Path(name)) if (part == L"." || part == L"..") Fail("file-table-path", file, ERROR_INVALID_NAME);
    const auto relative = Wide(line.substr(tab + 1));
    if (!Runtime(name).empty() && sha == "-") Fail("runtime-hash", file, ERROR_INVALID_DATA);
    if (!targets.emplace(name, Target{sha, relative}).second) Fail("duplicate-file", file, ERROR_INVALID_DATA);
  }
  if (input.bad() || targets.empty()) Fail("file-table", file, ERROR_INVALID_DATA);
  return targets;
}
struct HashProvider {
  HCRYPTPROV handle = 0;
  HashProvider() { if (!CryptAcquireContextW(&handle, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) Fail("hash-provider", {}); }
  ~HashProvider() { if (handle) CryptReleaseContext(handle, 0); }
  std::string Hash(const Path& file) const {
    Handle input(CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr), CloseHandle);
    if (input.get() == INVALID_HANDLE_VALUE) { input.release(); Fail("read-runtime", file); }
    struct Digest { HCRYPTHASH value = 0; ~Digest() { if (value) CryptDestroyHash(value); } } hash;
    if (!CryptCreateHash(handle, CALG_SHA_256, 0, 0, &hash.value)) Fail("hash-runtime", file);
    std::vector<BYTE> buffer(256 * 1024); DWORD bytes = 0;
    do {
      if (!ReadFile(input.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &bytes, nullptr)) Fail("read-runtime", file);
      if (bytes && !CryptHashData(hash.value, buffer.data(), bytes, 0)) Fail("hash-runtime", file);
    } while (bytes);
    BYTE digest[32]; DWORD size = sizeof(digest);
    if (!CryptGetHashParam(hash.value, HP_HASHVAL, digest, &size, 0) || size != 32) Fail("hash-runtime", file);
    const char* hex = "0123456789abcdef"; std::string result;
    for (BYTE byte : digest) { result += hex[byte >> 4]; result += hex[byte & 15]; } return result;
  }
};
static DWORD WriteError(const Path& file) {
  const HANDLE handle = CreateFileW(file.c_str(), GENERIC_WRITE | DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (handle != INVALID_HANDLE_VALUE) { CloseHandle(handle); return ERROR_SUCCESS; }
  return GetLastError();
}
static bool Busy(DWORD error) { return error == ERROR_SHARING_VIOLATION || error == ERROR_LOCK_VIOLATION; }
struct Process { RM_UNIQUE_PROCESS identity; std::wstring name, executable; };
static std::vector<Process> Users(const std::vector<Path>& files) {
  std::map<DWORD, Process> processes;
  // Only files that actually deny replacement are registered; no system-wide
  // process/handle scan or large registration of unchanged packages is needed.
  for (size_t offset = 0; offset < files.size(); offset += 8192) {
    struct Session { DWORD id = 0; bool open = false; ~Session() { if (open) RmEndSession(id); } } session;
    WCHAR key[CCH_RM_SESSION_KEY + 1]{}; DWORD status = RmStartSession(&session.id, 0, key);
    if (status != ERROR_SUCCESS) Fail("restart-manager-start", {}, status);
    session.open = true;
    const auto end = std::min(files.size(), offset + 8192);
    std::vector<std::wstring> names;
    for (size_t i = offset; i < end; i++) {
      auto name = files[i].wstring();
      if (name.rfind(L"\\\\?\\", 0) == 0) name = name.substr(4);
      names.push_back(name);
    }
    std::vector<LPCWSTR> pointers; for (const auto& name : names) pointers.push_back(name.c_str());
    status = RmRegisterResources(session.id, static_cast<UINT>(pointers.size()), pointers.data(), 0, nullptr, 0, nullptr);
    if (status != ERROR_SUCCESS) Fail("restart-manager-files", files[offset], status);
    std::vector<RM_PROCESS_INFO> entries; bool complete = false;
    for (int attempt = 0; attempt < 4; attempt++) {
      UINT needed = 0, count = static_cast<UINT>(entries.size()); DWORD reboot = 0;
      status = RmGetList(session.id, &needed, &count, entries.empty() ? nullptr : entries.data(), &reboot);
      if (status == ERROR_MORE_DATA) { entries.resize(needed); continue; }
      if (status != ERROR_SUCCESS) Fail("restart-manager-list", {}, status);
      entries.resize(count); complete = true; break;
    }
    if (!complete) Fail("restart-manager-list-changing", {}, ERROR_MORE_DATA);
    for (const auto& entry : entries) {
      const auto pid = entry.Process.dwProcessId;
      Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid), CloseHandle);
      if (!process) { if (GetLastError() == ERROR_INVALID_PARAMETER) continue; Fail("inspect-process", {}, GetLastError()); }
      if (WaitForSingleObject(process.get(), 0) == WAIT_OBJECT_0) continue;
      FILETIME birth{}, exit{}, kernel{}, user{};
      if (!GetProcessTimes(process.get(), &birth, &exit, &kernel, &user)) Fail("process-birth", {});
      if (CompareFileTime(&birth, &entry.Process.ProcessStartTime) != 0) continue;
      std::vector<wchar_t> executable(32768); DWORD length = static_cast<DWORD>(executable.size());
      if (!QueryFullProcessImageNameW(process.get(), 0, executable.data(), &length)) Fail("process-executable", {});
      processes[pid] = Process{entry.Process, entry.strAppName, std::wstring(executable.data(), length)};
    }
  }
  std::vector<Process> result; for (const auto& item : processes) result.push_back(item.second); return result;
}
static void Terminate(const Process& expected) {
  Handle process(OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, expected.identity.dwProcessId), CloseHandle);
  if (!process) { if (GetLastError() == ERROR_INVALID_PARAMETER) return; Fail("open-process-for-stop", expected.executable); }
  if (WaitForSingleObject(process.get(), 0) == WAIT_OBJECT_0) return;
  FILETIME birth{}, exit{}, kernel{}, user{};
  if (!GetProcessTimes(process.get(), &birth, &exit, &kernel, &user)) Fail("process-birth", expected.executable);
  // Keep this handle through termination: a recycled PID cannot inherit consent.
  if (CompareFileTime(&birth, &expected.identity.ProcessStartTime) != 0) return;
  if (!TerminateProcess(process.get(), ERROR_PROCESS_ABORTED)) {
    if (WaitForSingleObject(process.get(), 0) == WAIT_OBJECT_0) return;
    Fail("terminate-process", expected.executable);
  }
  const auto result = WaitForSingleObject(process.get(), 5000);
  if (result != WAIT_OBJECT_0) Fail("wait-process-exit", expected.executable, result == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError());
}
static int ReleaseRuntime(const std::vector<Path>& resources, bool silent, HWND parent) {
  for (;;) {
    std::vector<Path> blocked;
    for (const auto& file : resources) {
      const DWORD error = WriteError(file);
      if (Busy(error)) blocked.push_back(file);
      else if (error != ERROR_SUCCESS && error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) Fail("runtime-access", file, error);
    }
    if (blocked.empty()) return 0;
    const auto processes = Users(blocked);
    std::wstring message = L"以下进程正在使用本次需要更新的运行环境：\n\n";
    for (const auto& process : processes) {
      message += process.name + L"  PID " + std::to_wstring(process.identity.dwProcessId) + L"\n" + process.executable + L"\n\n";
      std::printf("RUNTIME_IN_USE pid=%lu executable=%s\n", process.identity.dwProcessId, Utf8(process.executable).c_str());
    }
    for (const auto& file : blocked) std::printf("RUNTIME_FILE_IN_USE %s\n", Utf8(file.wstring()).c_str());
    std::fflush(stdout);
    if (silent) return 2;
    if (processes.empty()) {
      const auto answer = MessageBoxW(parent, (L"运行环境文件仍被占用，请关闭使用该文件的程序后重试。\n" + blocked.front().wstring()).c_str(),
        L"Crabot 运行环境升级", MB_RETRYCANCEL | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND);
      if (answer != IDRETRY) return 3;
      continue;
    }
    message += L"结束这些进程会中断相关后台任务，可能丢失未保存的工作。\n\n是：允许结束所列进程并继续。\n否：我已自行关闭，重新检查。\n取消：退出安装，保留现有程序。";
    const auto answer = MessageBoxW(parent, message.c_str(), L"Crabot 运行环境升级", MB_YESNOCANCEL | MB_ICONWARNING | MB_DEFBUTTON3 | MB_SETFOREGROUND);
    if (answer == IDCANCEL || answer == 0) return 3;
    if (answer == IDYES) for (const auto& process : processes) Terminate(process);
    // New or respawned processes require a new list and a new explicit consent.
  }
}
static int Prepare(const Path& root, const Path& table, const Path& exclusions, bool silent, HWND parent) {
  const auto targets = ReadTargets(table); HashProvider hash;
  for (const auto& part : {L"program", L"program\\gui", L"program\\core", L"bin"}) {
    const auto directory = root / part; const DWORD attributes = GetFileAttributesW(directory.c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES && (!(attributes & FILE_ATTRIBUTE_DIRECTORY) || attributes & FILE_ATTRIBUTE_REPARSE_POINT)) Fail("program-directory", directory, ERROR_REPARSE_TAG_INVALID);
    if (attributes == INVALID_FILE_ATTRIBUTES && GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND) Fail("inspect-program-directory", directory);
  }
  std::vector<Path> actual, directories; std::set<std::wstring> preserved, changed;
  for (const auto& part : {L"program\\gui", L"program\\core"}) {
    const auto directory = root / part;
    if (!std::filesystem::exists(directory)) continue;
    if (!std::filesystem::is_directory(directory) || GetFileAttributesW(directory.c_str()) & FILE_ATTRIBUTE_REPARSE_POINT) Fail("program-directory", directory, ERROR_REPARSE_TAG_INVALID);
    for (const auto& item : std::filesystem::recursive_directory_iterator(directory)) {
      const DWORD attributes = GetFileAttributesW(item.path().c_str());
      if (attributes == INVALID_FILE_ATTRIBUTES) Fail("inspect-program", item.path());
      if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) Fail("program-link", item.path(), ERROR_REPARSE_TAG_INVALID);
      if (item.is_directory()) directories.push_back(item.path());
      else if (item.is_regular_file()) actual.push_back(item.path());
      else Fail("program-file", item.path(), ERROR_INVALID_DATA);
    }
    directories.push_back(directory);
  }
  for (const auto& relative : {L"bin\\crabot.exe", L"program\\desktop-payload.json"}) {
    const auto file = root / relative; const DWORD attributes = GetFileAttributesW(file.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
      if (GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND) Fail("inspect-program-file", file);
    } else if (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) Fail("program-file", file, ERROR_REPARSE_TAG_INVALID);
    else actual.push_back(file);
  }
  for (const auto& file : actual) {
    const auto relative = Key(file.lexically_relative(root).wstring()), group = Runtime(relative);
    if (group.empty()) continue;
    const auto expected = targets.find(relative);
    if (expected != targets.end() && hash.Hash(file) == expected->second.sha) preserved.insert(relative);
    else changed.insert(group);
  }
  std::vector<Path> resources;
  for (const auto& file : actual) {
    const auto relative = Key(file.lexically_relative(root).wstring()), group = Runtime(relative);
    if (changed.count(group)) resources.push_back(file);
    if (preserved.count(relative) || !group.empty()) continue;
    const DWORD error = WriteError(file);
    if (Busy(error)) { std::printf("PROGRAM_IN_USE %s win32=%lu\n", Utf8(file.wstring()).c_str(), error); return 2; }
    if (error != ERROR_SUCCESS) Fail("program-access", file, error);
  }
  const int released = ReleaseRuntime(resources, silent, parent); if (released) return released;
  // Everything above is read-only unless the user explicitly allowed shutdown.
  // Verify write access before the first deletion; cancellation leaves GUI/core intact.
  for (const auto& file : actual) if (!preserved.count(Key(file.lexically_relative(root).wstring()))) {
    const DWORD error = WriteError(file);
    if (error != ERROR_SUCCESS) Fail("program-access-after-check", file, error);
  }
  std::ofstream output(exclusions, std::ios::binary | std::ios::trunc);
  if (!output) Fail("write-exclusions", exclusions, ERROR_WRITE_FAULT);
  for (const auto& relative : preserved) output << Utf8(targets.at(relative).relative) << '\n';
  output.close(); if (!output) Fail("write-exclusions", exclusions, ERROR_WRITE_FAULT);
  for (const auto& file : actual) if (!preserved.count(Key(file.lexically_relative(root).wstring()))) {
    if (!DeleteFileW(file.c_str())) Fail("replace-program-file", file);
  }
  // Empty obsolete directories are harmless to the inventory but can be removed.
  std::sort(directories.begin(), directories.end(), [](const Path& a, const Path& b) { return a.native().size() > b.native().size(); });
  for (const auto& directory : directories) {
    if (!RemoveDirectoryW(directory.c_str()) && GetLastError() != ERROR_DIR_NOT_EMPTY) Fail("remove-empty-program-directory", directory);
  }
  std::printf("RUNTIME_PRESERVED files=%zu changed_components=%zu\n", preserved.size(), changed.size());
  return 0;
}
static int Run(const Path& root, const Path& table, const Path& exclusions, bool silent, HWND parent) {
  try { return Prepare(root, table, exclusions, silent, parent); }
  catch (const Failure& failure) {
    std::fprintf(stderr, "CRABOT_PROGRAM_OVERLAY stage=%s win32=%lu file=%s\n", failure.stage, failure.error, Utf8(failure.file.wstring()).c_str());
  } catch (const std::exception& error) { std::fprintf(stderr, "CRABOT_PROGRAM_OVERLAY %s\n", error.what()); }
  return 1;
}
} // namespace WindowsOverlay
