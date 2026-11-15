#ifdef _WIN32
#include <memory>

// A Windows Job Object is the kernel's authoritative ownership scope for a module
// process tree. KILL_ON_JOB_CLOSE makes an MM crash release descendants too; explicit
// TerminateJobObject remains the only normal stop path.
struct ProcessJob {
  HANDLE handle = nullptr;
  void Close() {
    if (handle) { CloseHandle(handle); handle = nullptr; }
  }
};
static void FinalizeProcessJob(napi_env, void* data, void*) { auto job = static_cast<ProcessJob*>(data); job->Close(); delete job; }
static ProcessJob* OwnedProcessJob(napi_env env, napi_value value) {
  void* data = nullptr;
  if (napi_get_value_external(env, value, &data) != napi_ok || !data) throw std::runtime_error("Expected an owned process job");
  return static_cast<ProcessJob*>(data);
}
static std::runtime_error ProcessJobError(const char* operation, DWORD code) {
  return std::runtime_error(std::string(operation) + " (Windows " + std::to_string(code) + ")");
}
static napi_value CreateProcessJob(napi_env env, napi_callback_info) {
  auto job = std::make_unique<ProcessJob>();
  try {
    job->handle = CreateJobObjectW(nullptr, nullptr);
    if (!job->handle) throw ProcessJobError("Cannot create process job", GetLastError());
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job->handle, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) throw ProcessJobError("Cannot bind process job lifetime", GetLastError());
    napi_value result;
    if (napi_create_external(env, job.get(), FinalizeProcessJob, nullptr, &result) != napi_ok) throw std::runtime_error("Cannot own process job");
    job.release(); return result;
  } catch (const std::exception& error) {
    job->Close(); napi_throw_error(env, "CRABOT_PROCESS_JOB", error.what()); return nullptr;
  }
}
static napi_value AssignProcessToJob(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    int32_t pid = 0;
    if (argc != 2 || napi_get_value_int32(env, args[1], &pid) != napi_ok || pid < 1) throw std::runtime_error("Expected an owned process job and a process ID");
    auto job = OwnedProcessJob(env, args[0]);
    HANDLE process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, static_cast<DWORD>(pid));
    if (!process) throw ProcessJobError("Cannot open process for job", GetLastError());
    const BOOL assigned = AssignProcessToJobObject(job->handle, process);
    const DWORD code = assigned ? 0 : GetLastError();
    CloseHandle(process);
    if (!assigned) throw ProcessJobError("Cannot assign process to job", code);
    napi_value result; napi_get_boolean(env, true, &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_PROCESS_JOB", error.what()); return nullptr; }
}
static napi_value TerminateProcessJob(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    auto job = OwnedProcessJob(env, args[0]);
    if (!TerminateJobObject(job->handle, 1)) throw ProcessJobError("Cannot terminate process job", GetLastError());
    napi_value result; napi_get_boolean(env, true, &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_PROCESS_JOB", error.what()); return nullptr; }
}
static napi_value InspectProcessJob(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    auto job = OwnedProcessJob(env, args[0]);
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job->handle, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) throw ProcessJobError("Cannot observe process job", GetLastError());
    napi_value result; napi_create_uint32(env, accounting.ActiveProcesses, &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_PROCESS_JOB", error.what()); return nullptr; }
}
static napi_value CloseProcessJob(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; void* data = nullptr;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 1 || napi_get_value_external(env, args[0], &data) != napi_ok || !data) {
    napi_throw_error(env, "CRABOT_PROCESS_JOB", "Invalid process job handle"); return nullptr;
  }
  static_cast<ProcessJob*>(data)->Close();
  napi_value result; napi_get_undefined(env, &result); return result;
}
static void RegisterProcessJob(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"createProcessJob", nullptr, CreateProcessJob, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"assignProcessToJob", nullptr, AssignProcessToJob, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"terminateProcessJob", nullptr, TerminateProcessJob, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspectProcessJob", nullptr, InspectProcessJob, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closeProcessJob", nullptr, CloseProcessJob, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
}
#endif
