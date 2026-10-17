#define NAPI_VERSION 8
#include <node_api.h>
#include <string>
#include <vector>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <cerrno>
#include <cmath>
#ifdef _WIN32
#include <windows.h>
#include <tlhelp32.h>
#include <sddl.h>
#else
#include <unistd.h>
#include <sys/socket.h>
#include <sys/file.h>
#include <fcntl.h>
#ifdef __APPLE__
#include <libproc.h>
#include <sys/un.h>
#else
#include <dirent.h>
#include <sys/stat.h>
#endif
#endif

struct Identity {
  int pid = 0;
  int parent = 0;
  std::string owner, started, executable;
};

static std::string Read(const std::string& path) {
  std::ifstream file(path);
  return std::string(std::istreambuf_iterator<char>(file), {});
}

static std::vector<int> Pids() {
  std::vector<int> result;
#ifdef _WIN32
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot enumerate processes");
  PROCESSENTRY32 entry{}; entry.dwSize = sizeof(entry);
  if (Process32First(snapshot, &entry)) do { result.push_back(entry.th32ProcessID); } while (Process32Next(snapshot, &entry));
  CloseHandle(snapshot);
#elif __APPLE__
  int bytes = proc_listpids(PROC_ALL_PIDS, 0, nullptr, 0);
  if (bytes <= 0) throw std::runtime_error("Cannot enumerate processes");
  result.resize(bytes / sizeof(int) + 1024);
  bytes = proc_listpids(PROC_ALL_PIDS, 0, result.data(), result.size() * sizeof(int));
  if (bytes <= 0) throw std::runtime_error("Cannot enumerate processes");
  result.resize(bytes / sizeof(int));
#else
  DIR* directory = opendir("/proc");
  if (!directory) throw std::runtime_error("Cannot enumerate processes");
  while (auto entry = readdir(directory)) {
    std::string name(entry->d_name);
    if (name.find_first_not_of("0123456789") == std::string::npos) result.push_back(std::stoi(name));
  }
  closedir(directory);
#endif
  return result;
}

static Identity Inspect(int pid) {
  Identity result; result.pid = pid;
#ifdef _WIN32
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) {
    if (GetLastError() == ERROR_INVALID_PARAMETER) return {};
    throw std::runtime_error("Cannot inspect process identity");
  }
  FILETIME created, exited, kernel, user;
  wchar_t path[32768]; DWORD length = 32768;
  HANDLE token = nullptr;
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)
      || !QueryFullProcessImageNameW(process, 0, path, &length)
      || !OpenProcessToken(process, TOKEN_QUERY, &token)) {
    CloseHandle(process); throw std::runtime_error("Cannot inspect process identity");
  }
  DWORD size = 0; GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  std::vector<unsigned char> info(size);
  if (!GetTokenInformation(token, TokenUser, info.data(), size, &size)) {
    CloseHandle(token); CloseHandle(process); throw std::runtime_error("Cannot inspect process owner");
  }
  LPSTR sid = nullptr;
  if (!ConvertSidToStringSidA(reinterpret_cast<TOKEN_USER*>(info.data())->User.Sid, &sid)) {
    CloseHandle(token); CloseHandle(process); throw std::runtime_error("Cannot read process owner");
  }
  result.owner = sid; LocalFree(sid); CloseHandle(token); CloseHandle(process);
  ULARGE_INTEGER ticks; ticks.LowPart = created.dwLowDateTime; ticks.HighPart = created.dwHighDateTime;
  result.started = std::to_string(ticks.QuadPart);
  int count = WideCharToMultiByte(CP_UTF8, 0, path, length, nullptr, 0, nullptr, nullptr);
  result.executable.resize(count);
  WideCharToMultiByte(CP_UTF8, 0, path, length, result.executable.data(), count, nullptr, nullptr);
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot inspect process parent");
  PROCESSENTRY32 entry{}; entry.dwSize = sizeof(entry);
  if (Process32First(snapshot, &entry)) do {
    if (entry.th32ProcessID == static_cast<DWORD>(pid)) { result.parent = entry.th32ParentProcessID; break; }
  } while (Process32Next(snapshot, &entry));
  CloseHandle(snapshot);
#elif __APPLE__
  proc_bsdinfo info{};
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) {
    if (errno == ESRCH || errno == ENOENT) return {};
    throw std::runtime_error("Cannot inspect process identity");
  }
  char path[PROC_PIDPATHINFO_MAXSIZE];
  if (proc_pidpath(pid, path, sizeof(path)) <= 0) {
    if (errno == ESRCH || errno == ENOENT) return {};
    throw std::runtime_error("Cannot inspect process executable");
  }
  result.owner = std::to_string(info.pbi_uid); result.parent = info.pbi_ppid;
  result.started = std::to_string(info.pbi_start_tvsec) + ":" + std::to_string(info.pbi_start_tvusec);
  result.executable = path;
#else
  std::string base = "/proc/" + std::to_string(pid);
  struct stat status;
  if (stat(base.c_str(), &status)) {
    if (errno == ENOENT || errno == ESRCH) return {};
    throw std::runtime_error("Cannot inspect process identity");
  }
  std::string line = Read(base + "/stat");
  auto end = line.rfind(')');
  if (end == std::string::npos) return {};
  std::istringstream fields(line.substr(end + 2));
  std::vector<std::string> values; std::string value;
  while (fields >> value) values.push_back(value);
  if (values.size() < 20) throw std::runtime_error("Invalid process identity");
  // Zombies have exited and cannot execute; their executable link is already gone.
  if (values[0] == "Z") return {};
  char path[65536]; auto length = readlink((base + "/exe").c_str(), path, sizeof(path));
  if (length < 0) {
    if (errno == ENOENT || errno == ESRCH) return {};
    throw std::runtime_error("Cannot inspect process executable");
  }
  result.owner = std::to_string(status.st_uid); result.parent = std::stoi(values[1]);
  auto boot = Read("/proc/sys/kernel/random/boot_id");
  if (boot.empty()) throw std::runtime_error("Cannot inspect system boot identity");
  result.started = boot + ":" + values[19];
  result.executable.assign(path, length);
#endif
  return result;
}

static napi_value String(napi_env env, const std::string& text) {
  napi_value value; napi_create_string_utf8(env, text.c_str(), text.size(), &value); return value;
}
static void Property(napi_env env, napi_value object, const char* key, napi_value value) { napi_set_named_property(env, object, key, value); }
static napi_value Number(napi_env env, int number) { napi_value value; napi_create_int32(env, number, &value); return value; }
static napi_value Object(napi_env env, const Identity& identity) {
  napi_value value;
  if (!identity.pid) { napi_get_null(env, &value); return value; }
  napi_create_object(env, &value);
  Property(env, value, "pid", Number(env, identity.pid));
  Property(env, value, "parent", Number(env, identity.parent));
  Property(env, value, "owner", String(env, identity.owner));
  Property(env, value, "started", String(env, identity.started));
  Property(env, value, "executable", String(env, identity.executable));
  return value;
}
static int Argument(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; double value;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 1 || napi_get_value_double(env, args[0], &value) != napi_ok || !std::isfinite(value) || value <= 0 || value > 2147483647 || value != static_cast<int>(value)) {
    throw std::runtime_error("Expected a positive process ID or socket descriptor");
  }
  return static_cast<int>(value);
}
static napi_value InspectCall(napi_env env, napi_callback_info info) {
  try { return Object(env, Inspect(Argument(env, info))); }
  catch (const std::exception& error) { napi_throw_error(env, "CRABOT_PROCESS_IDENTITY", error.what()); return nullptr; }
}
static napi_value PidsCall(napi_env env, napi_callback_info) {
  try {
    auto pids = Pids(); napi_value result; napi_create_array(env, &result);
    unsigned index = 0;
    for (int pid : pids) if (pid > 0) napi_set_element(env, result, index++, Number(env, pid));
    return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_PROCESS_IDENTITY", error.what()); return nullptr; }
}
#ifndef _WIN32
static napi_value PeerCall(napi_env env, napi_callback_info info) {
  try {
    int fd = Argument(env, info), pid; uid_t uid;
#ifdef __APPLE__
    gid_t gid; socklen_t size = sizeof(pid);
    if (getpeereid(fd, &uid, &gid) || getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &size)) throw std::runtime_error("Cannot identify local socket peer");
#else
    struct ucred peer; socklen_t size = sizeof(peer);
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &size)) throw std::runtime_error("Cannot identify local socket peer");
    uid = peer.uid; pid = peer.pid;
#endif
    auto identity = Inspect(pid);
    if (!identity.pid || identity.owner != std::to_string(uid)) throw std::runtime_error("Local peer identity changed");
    return Object(env, identity);
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_PEER_IDENTITY", error.what()); return nullptr; }
}
#endif
struct FileLock {
#ifdef _WIN32
  HANDLE handle = INVALID_HANDLE_VALUE;
#else
  int handle = -1;
#endif
  void Close() {
#ifdef _WIN32
    if (handle != INVALID_HANDLE_VALUE) { CloseHandle(handle); handle = INVALID_HANDLE_VALUE; }
#else
    if (handle >= 0) { close(handle); handle = -1; }
#endif
  }
};
static void FinalizeLock(napi_env, void* data, void*) { auto lock = static_cast<FileLock*>(data); lock->Close(); delete lock; }
static std::string Text(napi_env env, napi_value value) {
  size_t size;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok) throw std::runtime_error("Expected string");
  std::vector<char> buffer(size + 1); napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &size);
  return std::string(buffer.data(), size);
}
static napi_value TryLock(napi_env env, napi_callback_info info) {
  FileLock* lock = nullptr;
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) throw std::runtime_error("Expected lock path and metadata");
    auto path = Text(env, args[0]), text = Text(env, args[1]);
    if (path.find('\0') != std::string::npos || text.size() > 4096) throw std::runtime_error("Invalid file lock arguments");
    lock = new FileLock;
    bool busy = false;
#ifdef _WIN32
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.c_str(), -1, nullptr, 0);
    std::vector<wchar_t> wide(count);
    if (!count || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.c_str(), -1, wide.data(), count)) throw std::runtime_error("Invalid file path");
    lock->handle = CreateFileW(wide.data(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (lock->handle == INVALID_HANDLE_VALUE) {
      busy = GetLastError() == ERROR_SHARING_VIOLATION || GetLastError() == ERROR_LOCK_VIOLATION;
      if (!busy) throw std::runtime_error("Cannot open lifecycle lock");
    } else {
      DWORD written;
      if (!SetFilePointerEx(lock->handle, {}, nullptr, FILE_BEGIN) || !SetEndOfFile(lock->handle)
        || !WriteFile(lock->handle, text.data(), static_cast<DWORD>(text.size()), &written, nullptr) || written != text.size()) throw std::runtime_error("Cannot write lifecycle lock");
    }
#else
    lock->handle = open(path.c_str(), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (lock->handle < 0) throw std::runtime_error("Cannot open lifecycle lock");
    if (flock(lock->handle, LOCK_EX | LOCK_NB)) {
      busy = errno == EWOULDBLOCK || errno == EAGAIN;
      if (!busy) throw std::runtime_error("Cannot acquire lifecycle lock");
    } else if (ftruncate(lock->handle, 0) || write(lock->handle, text.data(), text.size()) != static_cast<ssize_t>(text.size())) throw std::runtime_error("Cannot write lifecycle lock");
#endif
    napi_value result;
    if (busy) { lock->Close(); delete lock; napi_get_null(env, &result); }
    else napi_create_external(env, lock, FinalizeLock, nullptr, &result);
    return result;
  } catch (const std::exception& error) {
    if (lock) { lock->Close(); delete lock; }
    napi_throw_error(env, "CRABOT_CLI_LOCK", error.what()); return nullptr;
  }
}
static napi_value ReleaseLock(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; void* data = nullptr;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 1 || napi_get_value_external(env, args[0], &data) != napi_ok || !data) {
    napi_throw_error(env, "CRABOT_CLI_LOCK", "Invalid lock handle"); return nullptr;
  }
  static_cast<FileLock*>(data)->Close();
  napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"inspectProcess", nullptr, InspectCall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"listProcessIds", nullptr, PidsCall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"tryFileLock", nullptr, TryLock, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"releaseFileLock", nullptr, ReleaseLock, nullptr, nullptr, nullptr, napi_default, nullptr},
#ifndef _WIN32
    {"inspectPeer", nullptr, PeerCall, nullptr, nullptr, nullptr, napi_default, nullptr},
#endif
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
