#ifdef _WIN32
#include <memory>

// A single fixed system copier, atomically attached to its own job before any thread runs.
struct WorkspaceCopyJob {
  HANDLE job = nullptr, process = nullptr, thread = nullptr, output = nullptr;
  std::string diagnostic;
  std::vector<HANDLE> pins;
  Identity identity;
  std::wstring target;
  bool resumed = false;
  void Drain() {
    char bytes[4096];
    for (size_t i = 0; output && i < 16; i++) {
      DWORD available = 0, read = 0;
      if (!PeekNamedPipe(output, nullptr, 0, nullptr, &available, nullptr)) {
        if (GetLastError() == ERROR_BROKEN_PIPE) return;
        throw std::runtime_error("Cannot observe workspace copy output");
      }
      if (!available) return;
      if (!ReadFile(output, bytes, available < sizeof(bytes) ? available : sizeof(bytes), &read, nullptr)) throw std::runtime_error("Cannot read workspace copy output");
      diagnostic.append(bytes, read);
      if (diagnostic.size() > 32768) diagnostic.erase(0, diagnostic.size() - 32768);
    }
  }
  void Close() {
    if (job) TerminateJobObject(job, 1);
    if (process) WaitForSingleObject(process, 5000);
    if (job) CloseHandle(job);
    if (thread) CloseHandle(thread);
    if (process) CloseHandle(process);
    if (output) CloseHandle(output);
    job = process = thread = output = nullptr;
    for (auto it = pins.rbegin(); it != pins.rend(); ++it) CloseHandle(*it);
    pins.clear();
  }
  ~WorkspaceCopyJob() { Close(); }
};
static const napi_type_tag WorkspaceCopyJobTag = { 0x435241424f54434fULL, 0x50594a4f42303031ULL };
static std::runtime_error WorkspaceCopyError(const char* operation) {
  return std::runtime_error(std::string(operation) + " (Windows " + std::to_string(GetLastError()) + ")");
}
static std::wstring WorkspaceCopyQuote(const std::wstring& text) {
  std::wstring result = L"\""; size_t slashes = 0;
  for (auto character : text) {
    if (character == L'\\') { slashes++; continue; }
    result.append(character == L'"' ? slashes * 2 + 1 : slashes, L'\\');
    slashes = 0; result += character;
  }
  result.append(slashes * 2, L'\\'); return result + L'"';
}
struct WorkspaceCopyStartup {
  std::vector<unsigned char> storage;
  LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
  HANDLE input = INVALID_HANDLE_VALUE, output = INVALID_HANDLE_VALUE;
  bool initialized = false;
  ~WorkspaceCopyStartup() {
    if (initialized) DeleteProcThreadAttributeList(list);
    if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
    if (output != INVALID_HANDLE_VALUE) CloseHandle(output);
  }
};
static WorkspaceCopyJob* OwnedWorkspaceCopyJob(napi_env env, napi_value value, bool allowClosed = false) {
  bool tagged = false; void* data = nullptr; napi_valuetype type = napi_undefined;
  napi_typeof(env, value, &type);
  if (type != napi_object || napi_check_object_type_tag(env, value, &WorkspaceCopyJobTag, &tagged) != napi_ok || !tagged
    || napi_unwrap(env, value, &data) != napi_ok || !data) throw std::runtime_error("Expected an owned workspace copy job");
  auto job = static_cast<WorkspaceCopyJob*>(data);
  if (!allowClosed && !job->process) throw std::runtime_error("Workspace copy job has been closed");
  return job;
}
static bool WorkspaceCopyPrivateTarget(HANDLE file) {
  const auto currentOwner = Inspect(GetCurrentProcessId()).owner;
  PSECURITY_DESCRIPTOR descriptor = nullptr; PSID owner = nullptr, current = nullptr; PACL acl = nullptr;
  SECURITY_DESCRIPTOR_CONTROL control = 0; DWORD revision = 0;
  bool valid = GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS
    && ConvertStringSidToSidA(currentOwner.c_str(), &current)
    && owner && acl && acl->AceCount && EqualSid(owner, current)
    && GetSecurityDescriptorControl(descriptor, &control, &revision) && (control & SE_DACL_PROTECTED);
  if (valid) for (DWORD i = 0; i < acl->AceCount; i++) {
    void* entry = nullptr;
    if (!GetAce(acl, i, &entry) || static_cast<ACE_HEADER*>(entry)->AceType != ACCESS_ALLOWED_ACE_TYPE
      || !EqualSid(reinterpret_cast<PSID>(&static_cast<ACCESS_ALLOWED_ACE*>(entry)->SidStart), current)) { valid = false; break; }
  }
  if (current) LocalFree(current);
  if (descriptor) LocalFree(descriptor);
  return valid;
}
static bool WorkspaceCopyEmptyTarget(const std::wstring& path) {
  WIN32_FIND_DATAW entry{};
  HANDLE search = FindFirstFileW((path + L"\\*").c_str(), &entry);
  if (search == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND;
  bool empty = true;
  do { if (wcscmp(entry.cFileName, L".") != 0 && wcscmp(entry.cFileName, L"..") != 0) { empty = false; break; } }
  while (FindNextFileW(search, &entry));
  const DWORD error = GetLastError(); FindClose(search);
  return empty && error == ERROR_NO_MORE_FILES;
}
static napi_value CreateWorkspaceCopyJob(napi_env env, napi_callback_info info) {
  auto job = std::make_unique<WorkspaceCopyJob>();
  try {
    size_t argc = 3; napi_value args[3]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) throw std::runtime_error("Expected two pinned workspace copy directories");
    auto source = OwnedDirectoryPin(env, args[0]), target = OwnedDirectoryPin(env, args[1]);
    const auto inside = [](const std::wstring& parent, const std::wstring& child) {
      return parent.size() <= child.size() && CompareStringOrdinal(parent.data(), static_cast<int>(parent.size()), child.data(), static_cast<int>(parent.size()), TRUE) == CSTR_EQUAL
        && (parent.size() == child.size() || child[parent.size()] == L'\\');
    };
    if (source->identity == target->identity || inside(source->path, target->path) || inside(target->path, source->path)) throw std::runtime_error("Workspace copy directories overlap");
    if (!WorkspaceCopyPrivateTarget(target->handles.back()) || !WorkspaceCopyEmptyTarget(target->path)) throw std::runtime_error("Workspace copy target must be empty and private");
    job->target = target->path;
    job->pins.reserve(source->handles.size() + target->handles.size());
    for (auto pin : {source, target}) for (auto handle : pin->handles) {
      HANDLE duplicate = nullptr;
      if (!DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS)) throw WorkspaceCopyError("Cannot retain copy directory pin");
      job->pins.push_back(duplicate);
    }
    std::vector<wchar_t> system(32768), windows(32768), temporary(32768);
    const UINT systemSize = GetSystemDirectoryW(system.data(), static_cast<UINT>(system.size()));
    const UINT windowsSize = GetWindowsDirectoryW(windows.data(), static_cast<UINT>(windows.size()));
    const DWORD tempSize = GetTempPathW(static_cast<DWORD>(temporary.size()), temporary.data());
    if (!systemSize || systemSize >= system.size() || !windowsSize || windowsSize >= windows.size() || !tempSize || tempSize >= temporary.size()) throw WorkspaceCopyError("Cannot resolve Windows copy environment");
    const std::wstring directory(system.data()), executable = directory + L"\\robocopy.exe";
    // Robocopy parses the extended-length prefix as a network path; local DOS pins retain their original native paths.
    std::wstring command = WorkspaceCopyQuote(executable) + L" " + WorkspaceCopyQuote(source->path.substr(4)) + L" " + WorkspaceCopyQuote(target->path.substr(4))
      + L" /E /COPY:DATS /DCOPY:DATE /SL /SJ /R:0 /W:0 /NFL /NDL /NJH /NJS /NP";
    if (command.size() >= 32767) throw std::runtime_error("Workspace copy command is too long");
    std::vector<wchar_t> commandLine(command.begin(), command.end()); commandLine.push_back(0);
    std::wstring environment;
    const auto add = [&environment](const std::wstring& key, const std::wstring& value) { environment += key + L"=" + value; environment.push_back(0); };
    add(L"PATH", directory); add(L"SYSTEMROOT", windows.data()); add(L"TEMP", temporary.data()); add(L"TMP", temporary.data()); add(L"WINDIR", windows.data()); environment.push_back(0);
    job->job = CreateJobObjectW(nullptr, nullptr);
    if (!job->job) throw WorkspaceCopyError("Cannot create workspace copy job");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    if (!SetInformationJobObject(job->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) throw WorkspaceCopyError("Cannot confine workspace copy process");
    WorkspaceCopyStartup startup;
    SIZE_T size = 0; InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
    if (!size || size > 1024 * 1024) throw std::runtime_error("Workspace copy startup size is unavailable");
    startup.storage.resize(size); startup.list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(startup.storage.data());
    if (!InitializeProcThreadAttributeList(startup.list, 2, 0, &size)) throw WorkspaceCopyError("Cannot initialize workspace copy startup");
    startup.initialized = true;
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    startup.input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    HANDLE pipe = nullptr;
    if (!CreatePipe(&pipe, &startup.output, &security, 0)) throw WorkspaceCopyError("Cannot isolate workspace copy output");
    job->output = pipe;
    if (startup.input == INVALID_HANDLE_VALUE || !SetHandleInformation(job->output, HANDLE_FLAG_INHERIT, 0)) throw WorkspaceCopyError("Cannot isolate workspace copy stdio");
    HANDLE inherited[] = {startup.input, startup.output};
    if (!UpdateProcThreadAttribute(startup.list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr)
      || !UpdateProcThreadAttribute(startup.list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job->job, sizeof(job->job), nullptr, nullptr)) throw WorkspaceCopyError("Cannot bind workspace copy at creation");
    STARTUPINFOEXW start{}; start.StartupInfo.cb = sizeof(start); start.lpAttributeList = startup.list;
    start.StartupInfo.dwFlags = STARTF_USESTDHANDLES; start.StartupInfo.hStdInput = startup.input; start.StartupInfo.hStdOutput = startup.output; start.StartupInfo.hStdError = startup.output;
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(executable.c_str(), commandLine.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
      const_cast<wchar_t*>(environment.c_str()), directory.c_str(), &start.StartupInfo, &process)) throw WorkspaceCopyError("Cannot create suspended workspace copy");
    job->process = process.hProcess; job->thread = process.hThread; job->identity = Inspect(static_cast<int>(process.dwProcessId));
    if (!job->identity.pid || job->identity.parent != static_cast<int>(GetCurrentProcessId()) || job->identity.owner != Inspect(GetCurrentProcessId()).owner) throw std::runtime_error("Workspace copy process identity is unavailable");
    napi_value result; napi_create_object(env, &result);
    if (napi_type_tag_object(env, result, &WorkspaceCopyJobTag) != napi_ok
      || napi_wrap(env, result, job.get(), [](napi_env, void* data, void*) { delete static_cast<WorkspaceCopyJob*>(data); }, nullptr, nullptr) != napi_ok) throw std::runtime_error("Cannot own workspace copy job");
    job.release(); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_WINDOWS_COPY_ACTOR", error.what()); return nullptr; }
}
static napi_value InspectWorkspaceCopyJob(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected an owned workspace copy job");
    auto job = OwnedWorkspaceCopyJob(env, args[0]);
    job->Drain();
    const DWORD wait = WaitForSingleObject(job->process, 0);
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (wait == WAIT_FAILED || !QueryInformationJobObject(job->job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) throw WorkspaceCopyError("Cannot observe workspace copy job");
    const bool exited = wait == WAIT_OBJECT_0 && accounting.ActiveProcesses == 0;
    napi_value result; napi_create_object(env, &result);
    Property(env, result, "process", Object(env, job->identity));
    Property(env, result, "state", String(env, exited ? "exited" : job->resumed ? "running" : "suspended"));
    napi_value code; napi_get_null(env, &code);
    if (exited) { DWORD exitCode = 0; if (!GetExitCodeProcess(job->process, &exitCode)) throw WorkspaceCopyError("Cannot inspect workspace copy exit"); napi_create_uint32(env, exitCode, &code); }
    Property(env, result, "exit_code", code);
    napi_value diagnostic; napi_create_string_latin1(env, job->diagnostic.data(), job->diagnostic.size(), &diagnostic);
    Property(env, result, "diagnostic", diagnostic); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_WINDOWS_COPY_ACTOR", error.what()); return nullptr; }
}
static napi_value ResumeWorkspaceCopyJob(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected an owned workspace copy job");
    auto job = OwnedWorkspaceCopyJob(env, args[0]);
    if (job->resumed || WaitForSingleObject(job->process, 0) != WAIT_TIMEOUT) throw std::runtime_error("Workspace copy process cannot be resumed again");
    if (!WorkspaceCopyPrivateTarget(job->pins.back()) || !WorkspaceCopyEmptyTarget(job->target)) throw std::runtime_error("Workspace copy target changed before permission");
    job->resumed = true;
    if (ResumeThread(job->thread) == static_cast<DWORD>(-1)) throw WorkspaceCopyError("Cannot resume workspace copy process");
    napi_value result; napi_get_undefined(env, &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_WINDOWS_COPY_ACTOR", error.what()); return nullptr; }
}
static napi_value CloseWorkspaceCopyJob(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected an owned workspace copy job");
    auto job = OwnedWorkspaceCopyJob(env, args[0], true);
    if (job->process && WaitForSingleObject(job->process, 0) != WAIT_OBJECT_0) {
      if (!TerminateJobObject(job->job, 1) || WaitForSingleObject(job->process, 5000) != WAIT_OBJECT_0) throw WorkspaceCopyError("Workspace copy process exit remains unverified");
    }
    job->Close(); napi_value result; napi_get_undefined(env, &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_WINDOWS_COPY_ACTOR", error.what()); return nullptr; }
}
#endif
