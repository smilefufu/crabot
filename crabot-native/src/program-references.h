// Bounded OS reference observations only; never stop a process or delete a file.
#include <chrono>
#include <algorithm>
#include <memory>
#include <unordered_set>
#include <map>
#ifdef _WIN32
#include <restartmanager.h>
#endif
struct ProgramReferenceJob {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::vector<std::string> roots, files;
  std::vector<Identity> processes;
  std::set<int> unknown, seen;
  std::map<int, Identity> observed;
  size_t outputBytes = 0, observedBytes = 0;
  bool incomplete = false;
  struct UnknownDetail { int pid; std::string stage; int error; };
  std::vector<UnknownDetail> unknownDetails;
  const char* stage = "process_list";
#ifdef _WIN32
  std::vector<std::wstring> rootIndex;
  std::unordered_set<std::wstring> fileIndex;
#else
  std::unordered_set<std::string> fileIndex;
#endif
  std::chrono::steady_clock::time_point deadline;
  void Budget() { if (std::chrono::steady_clock::now() >= deadline) { incomplete = true; throw std::runtime_error("Reference query budget reached"); } }
#ifdef _WIN32
  static std::wstring Wide(const std::string& value) {
    int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (!size) throw std::runtime_error("Invalid reference path");
    std::wstring wide(size, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), wide.data(), size);
    return wide;
  }
  static std::wstring Normal(const std::string& value) {
    auto result = Wide(value); std::replace(result.begin(), result.end(), L'/', L'\\');
    if (result.rfind(L"\\\\?\\UNC\\", 0) == 0) result = L"\\\\" + result.substr(8);
    else if (result.rfind(L"\\\\?\\", 0) == 0) result = result.substr(4);
    CharLowerBuffW(result.data(), static_cast<DWORD>(result.size())); return result;
  }
#endif
  bool Related(const std::string& value) const {
#ifdef _WIN32
    if (value.empty()) return false;
    const auto name = Normal(value);
    for (const auto& prefix : rootIndex) if (name == prefix || (name.size() > prefix.size() && name.compare(0, prefix.size(), prefix) == 0 && name[prefix.size()] == L'\\')) return true;
    return fileIndex.count(name) != 0;
#else
    if (value.empty()) return false;
    for (const auto& root : roots) if (value == root || (value.size() > root.size() && value.compare(0, root.size(), root) == 0 && value[root.size()] == '/')) return true;
    return fileIndex.count(value) != 0;
#endif
    return false;
  }
  void Unknown(int pid, const char* failureStage, int code) {
    if (unknown.insert(pid).second) unknownDetails.push_back({pid, failureStage, code});
  }
  void Remember(const Identity& value) {
    for (const auto& old : processes) if (old.pid == value.pid) { if (old.started != value.started || old.owner != value.owner) { Unknown(value.pid, "holder_generation", 0); } return; }
    const size_t bytes = value.executable.size() + value.owner.size() + value.started.size();
    if (processes.size() >= 32768 || outputBytes + bytes > 32 * 1024 * 1024) { incomplete = true; throw std::runtime_error("Too many reference holders"); }
    outputBytes += bytes; processes.push_back(value);
  }
#ifdef _WIN32
  static std::wstring ResourceName(const std::string& file) {
    auto name = Wide(file); std::replace(name.begin(), name.end(), L'/', L'\\');
    if (name.size() < MAX_PATH) return name;
    const auto extended = name.rfind(L"\\\\?\\", 0) == 0 ? name
      : name.rfind(L"\\\\", 0) == 0 ? L"\\\\?\\UNC\\" + name.substr(2) : L"\\\\?\\" + name;
    std::vector<WCHAR> buffer(32769);
    const DWORD length = GetShortPathNameW(extended.c_str(), buffer.data(), static_cast<DWORD>(buffer.size()));
    if (!length || length >= buffer.size()) throw std::runtime_error("Reference path alias unavailable");
    std::wstring alias(buffer.data(), length);
    if (alias.rfind(L"\\\\?\\UNC\\", 0) == 0) alias = L"\\\\" + alias.substr(8);
    else if (alias.rfind(L"\\\\?\\", 0) == 0) alias = alias.substr(4);
    if (alias.size() >= MAX_PATH) throw std::runtime_error("Reference path alias unavailable");
    struct File {
      HANDLE handle;
      explicit File(const std::wstring& path) : handle(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)) {}
      ~File() { if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle); }
    } original(extended), shortened(alias);
    BY_HANDLE_FILE_INFORMATION first{}, second{};
    if (original.handle == INVALID_HANDLE_VALUE || shortened.handle == INVALID_HANDLE_VALUE
      || !GetFileInformationByHandle(original.handle, &first) || !GetFileInformationByHandle(shortened.handle, &second)
      || !(first.nFileIndexHigh || first.nFileIndexLow)
      || first.dwVolumeSerialNumber != second.dwVolumeSerialNumber || first.nFileIndexHigh != second.nFileIndexHigh
      || first.nFileIndexLow != second.nFileIndexLow) throw std::runtime_error("Reference path alias changed");
    return alias;
  }
  void WindowsFiles() {
    if (files.empty()) return;
    struct Session {
      DWORD handle = 0; bool open = false;
      void Close() { if (open) { if (RmEndSession(handle) != ERROR_SUCCESS) throw std::runtime_error("Reference session cleanup unverified"); open = false; } }
      ~Session() { if (open) RmEndSession(handle); }
    };
    std::vector<std::wstring> names;
    for (const auto& file : files) { Budget(); names.push_back(ResourceName(file)); }
    std::vector<LPCWSTR> pointers; for (const auto& name : names) pointers.push_back(name.c_str());
    // Restart Manager cannot list an arbitrarily large registered session.
    // Every finite group gets its own session; all holder identities are merged.
    for (size_t offset = 0; offset < pointers.size(); offset += 8192) {
      Budget(); Session session; WCHAR key[CCH_RM_SESSION_KEY + 1] = {};
      if (RmStartSession(&session.handle, 0, key) != ERROR_SUCCESS) throw std::runtime_error("Reference session unavailable");
      session.open = true;
      const auto count = static_cast<UINT>(std::min<size_t>(8192, pointers.size() - offset));
      if (RmRegisterResources(session.handle, count, pointers.data() + offset, 0, nullptr, 0, nullptr) != ERROR_SUCCESS) throw std::runtime_error("Reference resources unavailable");
      bool settled = false;
      for (int attempt = 0; attempt < 4; attempt++) {
        Budget(); UINT needed = 0, count = 0; DWORD reboot = 0;
        DWORD status = RmGetList(session.handle, &needed, &count, nullptr, &reboot);
        if (status == ERROR_SUCCESS && needed == 0) { if (reboot) incomplete = true; settled = true; break; }
        if (status != ERROR_MORE_DATA || needed > 32768) throw std::runtime_error("Reference list unavailable");
        std::vector<RM_PROCESS_INFO> entries(needed); count = needed;
        status = RmGetList(session.handle, &needed, &count, entries.data(), &reboot);
        if (status == ERROR_MORE_DATA) continue;
        if (status != ERROR_SUCCESS || count > entries.size()) throw std::runtime_error("Reference list changed");
        if (reboot) { incomplete = true; }
        for (UINT i = 0; i < count; i++) {
          Budget(); const auto& target = entries[i].Process;
          if (!target.dwProcessId || target.dwProcessId > 2147483647) { incomplete = true; continue; }
          const int pid = static_cast<int>(target.dwProcessId);
          try {
            const auto current = Inspect(pid); if (!current.pid) continue;
            ULARGE_INTEGER birth; birth.LowPart = target.ProcessStartTime.dwLowDateTime; birth.HighPart = target.ProcessStartTime.dwHighDateTime;
            if (current.started == std::to_string(birth.QuadPart)) Remember(current);
          } catch (...) { if (!Exited(pid)) Unknown(pid, "windows_resource_identity", 0); }
        }
        settled = true; break;
      }
      if (!settled) throw std::runtime_error("Reference list did not settle");
      Budget(); session.Close();
    }
  }

#else
  std::vector<int> OwnedPids() {
    std::vector<int> found;
#ifdef __APPLE__
    const int needed = proc_listpids(PROC_UID_ONLY, getuid(), nullptr, 0);
    if (needed <= 0 || needed > 32768 * static_cast<int>(sizeof(int))) throw std::runtime_error("Reference process list unavailable");
    found.resize(std::min(32768, needed / static_cast<int>(sizeof(int)) + 1024));
    const int bytes = proc_listpids(PROC_UID_ONLY, getuid(), found.data(), static_cast<int>(found.size() * sizeof(int)));
    if (bytes < 0 || bytes >= static_cast<int>(found.size() * sizeof(int)) || bytes % sizeof(int)) throw std::runtime_error("Reference process list truncated");
    found.resize(bytes / sizeof(int));
#else
    for (int pid : Pids()) {
      Budget(); struct stat value; const auto directory = "/proc/" + std::to_string(pid);
      if (!stat(directory.c_str(), &value)) { if (value.st_uid == getuid()) found.push_back(pid); }
      else if (errno != ESRCH && errno != ENOENT) throw std::runtime_error("Reference process owner unavailable");
    }
#endif
    found.erase(std::remove_if(found.begin(), found.end(), [](int pid) { return pid <= 0; }), found.end());
    if (found.size() > 32768) throw std::runtime_error("Too many reference processes"); return found;
  }
#ifdef __APPLE__
  bool MacReferences(int pid, bool& related) {
    stage = "directories";
    proc_vnodepathinfo directories{};
    if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &directories, sizeof(directories)) != sizeof(directories)) throw std::runtime_error("Process directories unavailable");
    if (Related(directories.pvi_cdir.vip_path) || Related(directories.pvi_rdir.vip_path)) related = true;
    stage = "descriptor_list"; errno = 0;
    int needed = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nullptr, 0);
    if ((needed == 0 && errno) || needed < 0 || needed > 262144 * static_cast<int>(sizeof(proc_fdinfo))) throw std::runtime_error("Process descriptors unavailable");
    std::vector<proc_fdinfo> descriptors(needed / sizeof(proc_fdinfo) + 512);
    errno = 0;
    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, descriptors.data(), static_cast<int>(descriptors.size() * sizeof(proc_fdinfo)));
    if ((bytes == 0 && errno) || bytes < 0 || bytes >= static_cast<int>(descriptors.size() * sizeof(proc_fdinfo)) || bytes % sizeof(proc_fdinfo)) throw std::runtime_error("Process descriptor list changed");
    for (int i = 0; i < bytes / static_cast<int>(sizeof(proc_fdinfo)); i++) {
      Budget(); if (descriptors[i].proc_fdtype != PROX_FDTYPE_VNODE) continue;
      stage = "descriptor_details"; vnode_fdinfowithpath value{};
      if (proc_pidfdinfo(pid, descriptors[i].proc_fd, PROC_PIDFDVNODEPATHINFO, &value, sizeof(value)) != sizeof(value)) { if (errno == EBADF || errno == ENOENT) continue; throw std::runtime_error("Process descriptor unavailable"); }
      if (Related(value.pvip.vip_path)) related = true;
    }
    stage = "fileport_list"; errno = 0;
    needed = proc_pidinfo(pid, PROC_PIDLISTFILEPORTS, 0, nullptr, 0);
    // XNU returns ESRCH when the task IPC space is inactive; there are no
    // usable fileports then. Continue FD/mapping and generation checks below.
    if ((needed == 0 && errno && errno != ESRCH) || needed < 0 || needed > 262144 * static_cast<int>(sizeof(proc_fileportinfo))) throw std::runtime_error("Process fileports unavailable");
    if (needed) {
      std::vector<proc_fileportinfo> ports(needed / sizeof(proc_fileportinfo) + 512); errno = 0;
      bytes = proc_pidinfo(pid, PROC_PIDLISTFILEPORTS, 0, ports.data(), static_cast<int>(ports.size() * sizeof(proc_fileportinfo)));
      if ((bytes == 0 && errno && errno != ESRCH) || bytes < 0 || bytes >= static_cast<int>(ports.size() * sizeof(proc_fileportinfo)) || bytes % sizeof(proc_fileportinfo)) throw std::runtime_error("Process fileport list changed");
      for (int i = 0; i < bytes / static_cast<int>(sizeof(proc_fileportinfo)); i++) {
        Budget(); if (ports[i].proc_fdtype != PROX_FDTYPE_VNODE) continue;
        stage = "fileport_details"; vnode_fdinfowithpath value{};
        if (proc_pidfileportinfo(pid, ports[i].proc_fileport, PROC_PIDFILEPORTVNODEPATHINFO, &value, sizeof(value)) != sizeof(value)) { if (errno == ENOENT || errno == EBADF) continue; throw std::runtime_error("Process fileport unavailable"); }
        if (Related(value.pvip.vip_path)) related = true;
      }
    }
    stage = "mappings"; uint64_t address = 0;
    for (int count = 0; count < 65536; count++) {
      Budget(); proc_regionwithpathinfo value{}; errno = 0;
      if (proc_pidinfo(pid, PROC_PIDREGIONPATHINFO, address, &value, sizeof(value)) != sizeof(value)) {
        // EINVAL is also the end marker when the VM map is already empty.
        if (errno == ESRCH || errno == EINVAL) return related;
        throw std::runtime_error("Process mappings unavailable");
      }
      if (Related(value.prp_vip.vip_path)) related = true;
      uint64_t next = value.prp_prinfo.pri_address + value.prp_prinfo.pri_size;
      if (next <= address) throw std::runtime_error("Process mapping range invalid"); address = next;
    }
    throw std::runtime_error("Too many process mappings");
  }
#else
  static std::string ProcLink(const std::string& file) {
    char bytes[32769]; ssize_t count = readlink(file.c_str(), bytes, sizeof(bytes));
    if (count < 0 || count >= static_cast<ssize_t>(sizeof(bytes))) throw std::runtime_error("Process reference unavailable");
    return std::string(bytes, count);
  }
  static std::string MapPath(const std::string& text) {
    std::string result;
    for (size_t i = 0; i < text.size(); i++) {
      if (text[i] == '\\' && i + 3 < text.size() && text[i+1] >= '0' && text[i+1] <= '7' && text[i+2] >= '0' && text[i+2] <= '7' && text[i+3] >= '0' && text[i+3] <= '7') {
        result += static_cast<char>((text[i+1]-'0')*64+(text[i+2]-'0')*8+text[i+3]-'0'); i += 3;
      } else result += text[i];
    }
    return result;
  }
  bool LinuxReferences(int pid) {
    stage = "directories"; const auto base = "/proc/" + std::to_string(pid); bool related = Related(ProcLink(base + "/cwd"));
    stage = "descriptor_details"; DIR* directory = opendir((base + "/fd").c_str()); if (!directory) throw std::runtime_error("Process descriptors unavailable");
    try {
      int count = 0; errno = 0;
      while (auto entry = readdir(directory)) {
        Budget(); if (++count > 262144) throw std::runtime_error("Too many process descriptors");
        const std::string name(entry->d_name); if (name == "." || name == "..") continue;
        try { if (Related(ProcLink(base + "/fd/" + name))) related = true; }
        catch (...) { if (errno != ENOENT && errno != EBADF) throw; }
        errno = 0;
      }
      if (errno) throw std::runtime_error("Process descriptor list unavailable");
    } catch (...) { closedir(directory); throw; }
    closedir(directory);
    stage = "mappings"; std::ifstream maps(base + "/maps"); if (!maps) throw std::runtime_error("Process mappings unavailable");
    std::string line; size_t bytes = 0;
    while (std::getline(maps, line)) {
      Budget(); bytes += line.size(); if (bytes > 64 * 1024 * 1024) throw std::runtime_error("Process mappings too large");
      const auto start = line.find('/'); if (start != std::string::npos && Related(MapPath(line.substr(start)))) related = true;
    }
    if (!maps.eof()) throw std::runtime_error("Process mapping read incomplete"); return related;
  }
#endif
  void UnixProcess(int pid, const std::string& owner) {
    Budget(); Identity original; bool related = false;
    try {
      stage = "identity"; original = Inspect(pid); if (!original.pid) return;
      if (original.owner != owner) { Unknown(pid, "process_generation", 0); return; }
      const size_t bytes = original.executable.size() + original.owner.size() + original.started.size();
      if (observedBytes + bytes > 32 * 1024 * 1024) { incomplete = true; throw std::runtime_error("Too many observed identities"); }
      observedBytes += bytes; observed.emplace(pid, original);
      related = Related(original.executable);
#ifdef __APPLE__
      related = MacReferences(pid, related) || related;
#else
      related = LinuxReferences(pid) || related;
#endif
      stage = "identity_recheck"; const auto current = Inspect(pid);
      if (!current.pid) return;
      if (current.started != original.started || current.owner != original.owner || current.executable != original.executable) { Unknown(pid, "process_generation", 0); return; }
      if (related) Remember(current);
    } catch (const std::bad_alloc&) { incomplete = true; throw; }
    catch (...) {
      const int code = errno;
      if (!Exited(pid)) { if (related) Remember(original); Unknown(pid, stage, code); }
    }
  }
#endif
  void Run() {
    deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    try {
      if (roots.empty() && files.empty()) return;
#ifdef _WIN32
      for (const auto& root : roots) rootIndex.push_back(Normal(root));
      for (const auto& file : files) fileIndex.insert(Normal(file));
      WindowsFiles();
      for (int pid : Pids()) {
        Budget(); Identity value;
        try { value = Inspect(pid); } catch (...) { continue; } // Resource-query failures stay unknown above.
        if (value.pid && Related(value.executable)) Remember(value);
      }
#else
      fileIndex.insert(files.begin(), files.end());
      const auto self = Inspect(static_cast<int>(getpid())); if (!self.pid) throw std::runtime_error("Reference observer unavailable");
      for (int pass = 0; pass < 2; pass++) for (int pid : OwnedPids()) if (seen.insert(pid).second) UnixProcess(pid, self.owner);
      for (int pid : OwnedPids()) {
        Budget();
        if (seen.insert(pid).second) { UnixProcess(pid, self.owner); continue; }
        const auto original = observed.find(pid);
        if (original == observed.end()) continue;
        try {
          const auto current = Inspect(pid);
          if (current.pid && (current.started != original->second.started || current.owner != original->second.owner || current.executable != original->second.executable)) Unknown(pid, "process_generation", 0);
        } catch (...) { if (!Exited(pid)) Unknown(pid, "identity_recheck", errno); }
      }
#endif
      Budget();
    } catch (...) { incomplete = true; }
  }
};
static std::string ReferenceText(napi_env env, napi_value value) {
  size_t size = 0; if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok || size == 0 || size > 32768) throw std::runtime_error("Invalid reference path");
  std::vector<char> text(size + 1); napi_get_value_string_utf8(env, value, text.data(), text.size(), &size);
  std::string result(text.data(), size); if (result.find('\0') != std::string::npos) throw std::runtime_error("Invalid reference path");
#ifdef _WIN32
  const auto wide = ProgramReferenceJob::Normal(result);
  if (!(wide.size() > 3 && wide[1] == L':' && wide[2] == L'\\') && wide.rfind(L"\\\\", 0) != 0) throw std::runtime_error("Reference path must be absolute");
#else
  if (result.size() <= 1 || result[0] != '/') throw std::runtime_error("Reference path must be absolute");
#endif
  std::string parts = result;
#ifdef _WIN32
  std::replace(parts.begin(), parts.end(), '\\', '/');
#endif
  if (parts.back() == '/') throw std::runtime_error("Invalid reference path");
  std::istringstream components(parts); std::string part;
  while (std::getline(components, part, '/')) if (part == "." || part == "..") throw std::runtime_error("Invalid reference path");
  return result;
}
static void ReferenceWork(napi_env, void* data) { static_cast<ProgramReferenceJob*>(data)->Run(); }
static void ReferenceComplete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<ProgramReferenceJob> job(static_cast<ProgramReferenceJob*>(data));
  napi_value result, complete, processes, unknown; napi_create_object(env, &result);
  napi_get_boolean(env, status == napi_ok && !job->incomplete && job->unknown.empty(), &complete); Property(env, result, "complete", complete);
  napi_create_array_with_length(env, job->processes.size(), &processes);
  for (size_t i = 0; i < job->processes.size(); i++) napi_set_element(env, processes, i, Object(env, job->processes[i]));
  napi_create_array_with_length(env, job->unknown.size(), &unknown); uint32_t index = 0;
  for (int pid : job->unknown) napi_set_element(env, unknown, index++, Number(env, pid));
  Property(env, result, "processes", processes); Property(env, result, "unknown_pids", unknown);
  std::map<std::string, int> counts;
  napi_value details, incomplete; napi_create_array_with_length(env, job->unknownDetails.size(), &details);
  for (size_t i = 0; i < job->unknownDetails.size(); i++) {
    const auto& detail = job->unknownDetails[i]; counts[detail.stage + ":" + std::to_string(detail.error)]++;
    napi_value item; napi_create_object(env, &item);
    Property(env, item, "pid", Number(env, job->unknownDetails[i].pid));
    Property(env, item, "stage", String(env, job->unknownDetails[i].stage)); Property(env, item, "os_error", Number(env, job->unknownDetails[i].error));
    napi_set_element(env, details, i, item);
  }
  Property(env, result, "unknown_details", details);
  napi_value stages; napi_create_object(env, &stages);
  for (const auto& item : counts) Property(env, stages, item.first.c_str(), Number(env, item.second));
  Property(env, result, "unknown_stages", stages);
  napi_get_boolean(env, status != napi_ok || job->incomplete, &incomplete); Property(env, result, "incomplete", incomplete);
  napi_resolve_deferred(env, job->deferred, result); napi_delete_async_work(env, job->work);
}
static napi_value ProgramReferencesCall(napi_env env, napi_callback_info info) {
  auto job = std::make_unique<ProgramReferenceJob>(); napi_value promise = nullptr;
  try {
    size_t argc = 1; napi_value args[1], names; bool array = false; uint32_t keys = 0;
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1 || napi_is_array(env, args[0], &array) != napi_ok || array || napi_get_property_names(env, args[0], &names) != napi_ok || napi_get_array_length(env, names, &keys) != napi_ok || keys != 2) throw std::runtime_error("Invalid reference input");
    size_t bytes = 0;
    for (const auto& field : { std::string("roots"), std::string("files") }) {
      napi_value list; uint32_t count = 0;
      if (napi_get_named_property(env, args[0], field.c_str(), &list) != napi_ok || napi_is_array(env, list, &array) != napi_ok || !array || napi_get_array_length(env, list, &count) != napi_ok || count > (field == "roots" ? 8u : 100000u)) throw std::runtime_error("Invalid reference list");
      auto& target = field == "roots" ? job->roots : job->files;
      for (uint32_t i = 0; i < count; i++) { napi_value value; napi_get_element(env, list, i, &value); auto text = ReferenceText(env, value); bytes += text.size(); if (bytes > 32 * 1024 * 1024) throw std::runtime_error("Reference input too large"); target.push_back(text); }
    }
    napi_value label = String(env, "crabot:program-references");
    if (napi_create_promise(env, &job->deferred, &promise) != napi_ok || napi_create_async_work(env, nullptr, label, ReferenceWork, ReferenceComplete, job.get(), &job->work) != napi_ok) throw std::runtime_error("Reference worker unavailable");
    if (napi_queue_async_work(env, job->work) != napi_ok) { throw std::runtime_error("Reference worker unavailable"); }
    job.release(); return promise;
  } catch (const std::exception&) {
    if (job->work) napi_delete_async_work(env, job->work);
    if (job->deferred) {
      napi_value error; napi_create_error(env, String(env, "CRABOT_PROGRAM_REFERENCES"), String(env, "Program reference worker is unavailable"), &error);
      napi_reject_deferred(env, job->deferred, error); return promise;
    }
    napi_throw_error(env, "CRABOT_PROGRAM_REFERENCES", "Program reference query input is invalid"); return nullptr;
  }
}
