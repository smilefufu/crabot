#ifdef _WIN32
#include <map>
#include <memory>

// A synchronous observation owns its process handles until every returned fact is assembled.
// An exited process object keeps its PID reserved while this handle remains open.
using ObservedProcessHandle = std::unique_ptr<void, decltype(&CloseHandle)>;
struct ObservedProcessGeneration {
  ObservedProcessHandle handle{nullptr, CloseHandle};
  Identity identity;
  ULONGLONG created = 0;
  bool enumeratedAfterExit = false;
};
static bool ObservedProcessExited(const ObservedProcessGeneration& process) {
  const DWORD state = WaitForSingleObject(process.handle.get(), 0);
  if (state != WAIT_TIMEOUT && state != WAIT_OBJECT_0) throw std::runtime_error("Cannot observe held process exit");
  return state == WAIT_OBJECT_0;
}
static std::unique_ptr<ObservedProcessGeneration> OpenObservedProcess(int pid, const char*& stage) {
  auto process = std::make_unique<ObservedProcessGeneration>();
  stage = "pinned-open-handle";
  process->handle.reset(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  if (!process->handle) {
    stage = "pinned-open-absence";
    if (Exited(pid)) return nullptr;
    throw std::runtime_error("Cannot hold process observation");
  }
  stage = "pinned-open-identity";
  try { process->identity = Inspect(pid); }
  catch (...) { if (ObservedProcessExited(*process)) return nullptr; throw; }
  stage = "pinned-open-identity-present";
  if (!process->identity.pid) {
    if (ObservedProcessExited(*process)) return nullptr;
    throw std::runtime_error("Cannot identify held process");
  }
  stage = "pinned-open-birth";
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(process->handle.get(), &created, &exited, &kernel, &user)) throw std::runtime_error("Cannot identify held process birth");
  ULARGE_INTEGER ticks; ticks.LowPart = created.dwLowDateTime; ticks.HighPart = created.dwHighDateTime;
  process->created = ticks.QuadPart;
  stage = "pinned-open-birth-binding";
  if (process->identity.started != std::to_string(process->created)) throw std::runtime_error("Held process birth changed");
  return process;
}
static std::vector<int> ObservedProcessChildren(const ObservedProcessGeneration& parent, const char*& stage) {
  stage = "pinned-children-snapshot";
  HANDLE raw = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (raw == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot enumerate held process children");
  ObservedProcessHandle snapshot(raw, CloseHandle);
  std::vector<int> children;
  PROCESSENTRY32 entry{}; entry.dwSize = sizeof(entry);
  stage = "pinned-children-iteration";
  BOOL found = Process32First(raw, &entry);
  while (found) {
    if (entry.th32ParentProcessID == static_cast<DWORD>(parent.identity.pid) && entry.th32ProcessID > 0) {
      if (entry.th32ProcessID > 2147483647 || children.size() >= 32768) throw std::runtime_error("Held process scope exceeds limit");
      children.push_back(static_cast<int>(entry.th32ProcessID));
    }
    found = Process32Next(raw, &entry);
  }
  stage = "pinned-children-complete";
  if (GetLastError() != ERROR_NO_MORE_FILES) throw std::runtime_error("Incomplete held process child snapshot");
  return children;
}
static napi_value CaptureProcessTreeGeneration(napi_env env, napi_callback_info info) {
  const char* stage = "pinned-input";
  try {
    size_t argc = 4; napi_value args[4]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    double rawPid = 0;
    if (argc != 3 || napi_get_value_double(env, args[0], &rawPid) != napi_ok || !std::isfinite(rawPid)
      || rawPid < 1 || rawPid > 2147483647 || rawPid != std::floor(rawPid) || rawPid == GetCurrentProcessId()) throw std::runtime_error("Expected an original child generation");
    const auto started = Text(env, args[1]), owner = Text(env, args[2]);
    const auto self = Inspect(GetCurrentProcessId());
    stage = "pinned-root";
    auto root = OpenObservedProcess(static_cast<int>(rawPid), stage);
    stage = "pinned-root-binding";
    if (!root || root->identity.started != started || root->identity.owner != owner || owner != self.owner || ObservedProcessExited(*root)) throw std::runtime_error("Original process root changed");
    std::vector<std::unique_ptr<ObservedProcessGeneration>> processes;
    std::map<int, ObservedProcessGeneration*> byPid;
    byPid.emplace(root->identity.pid, root.get()); processes.push_back(std::move(root));
    const auto enumerate = [&](ObservedProcessGeneration& parent) {
      stage = "pinned-parent-exit";
      const bool wasExited = ObservedProcessExited(parent);
      for (int pid : ObservedProcessChildren(parent, stage)) {
        auto existing = byPid.find(pid);
        stage = "pinned-child-existing-parent";
        if (existing != byPid.end()) {
          if (existing->second->identity.parent != parent.identity.pid) throw std::runtime_error("Held process ancestry cycle");
          continue;
        }
        auto child = OpenObservedProcess(pid, stage);
        if (!child) continue; // Independently observed kernel exit before an identity was acquired.
        stage = "pinned-child-birth-order";
        if (child->created < parent.created) continue; // A stale creator PID from an older generation.
        stage = "pinned-child-ownership";
        if (child->identity.pid == self.pid || child->identity.owner != owner || child->identity.parent != parent.identity.pid) throw std::runtime_error("Held process child ownership changed");
        stage = "pinned-child-scope-size";
        if (processes.size() >= 32768) throw std::runtime_error("Held process scope exceeds limit");
        byPid.emplace(pid, child.get()); processes.push_back(std::move(child));
      }
      // If exit happened during enumeration, the driver makes one final pass after exit.
      if (wasExited) parent.enumeratedAfterExit = true;
    };
    size_t offset = 0;
    for (;;) {
      stage = "pinned-enumeration";
      while (offset < processes.size()) enumerate(*processes[offset++]);
      bool anotherPass = false;
      stage = "pinned-refresh";
      for (size_t i = 0; i < processes.size(); i++) {
        auto& process = *processes[i];
        if (ObservedProcessExited(process)) {
          if (i == 0) throw std::runtime_error("Original process root exited");
          if (!process.enumeratedAfterExit) { enumerate(process); anotherPass = true; }
          continue;
        }
        Identity current;
        try { current = Inspect(process.identity.pid); }
        catch (...) {
          if (i != 0 && ObservedProcessExited(process)) { anotherPass = true; continue; }
          throw;
        }
        if (!current.pid) {
          if (ObservedProcessExited(process)) { anotherPass = true; continue; }
          throw std::runtime_error("Live held process identity unavailable");
        }
        if (current.owner != owner || current.started != process.identity.started || current.parent != process.identity.parent) throw std::runtime_error("Live held process generation changed");
        process.identity.executable = current.executable;
      }
      if (!anotherPass && offset == processes.size()) break;
    }
    stage = "pinned-final-root-exit";
    if (ObservedProcessExited(*processes[0])) throw std::runtime_error("Original process root exited");
    stage = "pinned-result";
    napi_value result; napi_create_array_with_length(env, processes.size(), &result);
    for (size_t i = 0; i < processes.size(); i++) napi_set_element(env, result, i, Object(env, processes[i]->identity));
    return result;
  } catch (const std::exception& error) {
    napi_value result; napi_create_error(env, String(env, "CRABOT_PROCESS_SCOPE"), String(env, error.what()), &result);
    napi_set_named_property(env, result, "stage", String(env, stage)); napi_throw(env, result); return nullptr;
  }
}
#endif
