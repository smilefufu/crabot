// Node-API and Windows handles only; no casts of Node StreamBase/libuv pointers.
#ifdef _WIN32
// Handles stay inside this DLL. CRT file descriptor tables are not shared between
// independently linked Node/Electron runtimes and a /MT native addon.
static const napi_type_tag PipeConnectionTag = { 0x3c9d0d4058b34d21ULL, 0xb0c4bcdb23174ba1ULL };
static const napi_type_tag PipeServerTag = { 0x17228b43881f4d73ULL, 0x90fe1c1245cd317eULL };
struct PipeConnection {
  HANDLE handle, stopped;
  unsigned active = 0;
  bool closed = false;
  explicit PipeConnection(HANDLE value) : handle(value), stopped(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
    if (!stopped) throw std::runtime_error("Cannot create pipe cancellation event");
  }
  void Close() {
    closed = true; SetEvent(stopped);
    if (!active && handle != INVALID_HANDLE_VALUE) { CloseHandle(handle); handle = INVALID_HANDLE_VALUE; }
  }
  ~PipeConnection() { Close(); CloseHandle(stopped); }
};
static void FinalizeConnection(napi_env, void* data, void*) { delete static_cast<PipeConnection*>(data); }
static napi_value ConnectionObject(napi_env env, HANDLE handle) {
  auto connection = new PipeConnection(handle);
  napi_value value; napi_create_object(env, &value);
  napi_wrap(env, value, connection, FinalizeConnection, nullptr, nullptr);
  napi_type_tag_object(env, value, &PipeConnectionTag);
  return value;
}
static PipeConnection* GetConnection(napi_env env, napi_value value) {
  bool matches = false; void* data = nullptr;
  if (napi_check_object_type_tag(env, value, &PipeConnectionTag, &matches) != napi_ok || !matches
    || napi_unwrap(env, value, &data) != napi_ok || !data) throw std::runtime_error("Invalid local pipe connection");
  return static_cast<PipeConnection*>(data);
}
struct LocalPipe {
  std::wstring name;
  PSECURITY_DESCRIPTOR security = nullptr;
  HANDLE stopped = nullptr, pending = INVALID_HANDLE_VALUE;
  bool accepting = false, closed = false;
  void Close() {
    closed = true;
    if (stopped) SetEvent(stopped);
    if (pending != INVALID_HANDLE_VALUE) { CloseHandle(pending); pending = INVALID_HANDLE_VALUE; }
  }
  ~LocalPipe() { Close(); if (stopped) CloseHandle(stopped); if (security) LocalFree(security); }
  HANDLE Create(bool first) {
    SECURITY_ATTRIBUTES attributes{ sizeof(attributes), security, FALSE };
    auto pipe = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 16, 65536, 65536, 5000, &attributes);
    if (pipe == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot create private local pipe");
    return pipe;
  }
};
static std::wstring PipeName(const std::string& text) {
  const std::string prefix = "\\\\.\\pipe\\crabot-desktop-";
  if (text.rfind(prefix, 0) != 0 || text.size() != prefix.size() + 64
    || text.substr(prefix.size()).find_first_not_of("0123456789abcdef") != std::string::npos) throw std::runtime_error("Invalid local pipe name");
  return std::wstring(text.begin(), text.end());
}
static void FinalizePipe(napi_env, void* data, void*) { delete static_cast<LocalPipe*>(data); }
static napi_value CreatePipeServer(napi_env env, napi_callback_info info) {
  LocalPipe* server = nullptr;
  try {
    size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected local pipe name");
    server = new LocalPipe; server->name = PipeName(Text(env, args[0]));
    auto acl = "D:P(A;;GA;;;" + Inspect(GetCurrentProcessId()).owner + ")";
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorA(acl.c_str(), SDDL_REVISION_1, &server->security, nullptr)) throw std::runtime_error("Cannot create current-user pipe ACL");
    server->stopped = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!server->stopped) throw std::runtime_error("Cannot create pipe cancellation event");
    server->pending = server->Create(true);
    napi_value result; napi_create_object(env, &result);
    napi_wrap(env, result, server, FinalizePipe, nullptr, nullptr);
    napi_type_tag_object(env, result, &PipeServerTag); return result;
  } catch (const std::exception& error) {
    delete server; napi_throw_error(env, "CRABOT_LOCAL_PIPE", error.what()); return nullptr;
  }
}
static LocalPipe* PipeArgument(napi_env env, napi_callback_info info, napi_value* value) {
  size_t argc = 1; void* data = nullptr; bool matches = false; napi_get_cb_info(env, info, &argc, value, nullptr, nullptr);
  if (argc != 1 || napi_check_object_type_tag(env, *value, &PipeServerTag, &matches) != napi_ok || !matches
    || napi_unwrap(env, *value, &data) != napi_ok || !data) throw std::runtime_error("Invalid local pipe server");
  return static_cast<LocalPipe*>(data);
}
struct PipeWork {
  napi_async_work work = nullptr;
  napi_deferred deferred;
  napi_ref serverRef = nullptr;
  LocalPipe* server = nullptr;
  HANDLE handle = INVALID_HANDLE_VALUE;
  std::wstring name;
  std::string error;
  bool connect = false;
};
static void ExecutePipe(napi_env, void* data) {
  auto task = static_cast<PipeWork*>(data);
  try {
    if (task->connect) {
      auto deadline = GetTickCount64() + 5000;
      do {
        task->handle = CreateFileW(task->name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
          FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
        if (task->handle != INVALID_HANDLE_VALUE) return;
        auto error = GetLastError();
        if (error != ERROR_PIPE_BUSY && error != ERROR_FILE_NOT_FOUND) break;
        if (error == ERROR_PIPE_BUSY) WaitNamedPipeW(task->name.c_str(), 50);
        else Sleep(10);
      } while (GetTickCount64() < deadline);
      throw std::runtime_error("Local pipe unavailable");
    }
    OVERLAPPED overlap{}; overlap.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!overlap.hEvent) throw std::runtime_error("Cannot create pipe accept event");
    bool connected = ConnectNamedPipe(task->handle, &overlap);
    auto error = connected ? ERROR_SUCCESS : GetLastError();
    if (error == ERROR_IO_PENDING) {
      HANDLE events[] = { overlap.hEvent, task->server->stopped };
      auto wait = WaitForMultipleObjects(2, events, FALSE, INFINITE);
      DWORD bytes;
      if (wait != WAIT_OBJECT_0) {
        CancelIoEx(task->handle, &overlap);
        // Keep OVERLAPPED/event alive until kernel cancellation has completed.
        GetOverlappedResult(task->handle, &overlap, &bytes, TRUE);
        error = ERROR_OPERATION_ABORTED;
      } else if (!GetOverlappedResult(task->handle, &overlap, &bytes, FALSE)) error = GetLastError();
      else error = ERROR_SUCCESS;
    }
    CloseHandle(overlap.hEvent);
    if (error != ERROR_SUCCESS && error != ERROR_PIPE_CONNECTED) throw std::runtime_error("Local pipe accept cancelled or failed");
  } catch (const std::exception& error) { task->error = error.what(); }
}
static void CompletePipe(napi_env env, napi_status status, void* data) {
  auto task = static_cast<PipeWork*>(data);
  try {
    if (status != napi_ok || !task->error.empty() || (task->server && task->server->closed)) throw std::runtime_error(task->error.empty() ? "Local pipe closed" : task->error);
    // Preserve a listening instance before handing off the connected handle.
    if (task->server) task->server->pending = task->server->Create(false);
    if (!SetHandleInformation(task->handle, HANDLE_FLAG_INHERIT, 0)) throw std::runtime_error("Cannot isolate local pipe handle");
    auto connection = ConnectionObject(env, task->handle);
    task->handle = INVALID_HANDLE_VALUE;
    napi_resolve_deferred(env, task->deferred, connection);
  } catch (const std::exception& error) {
    napi_value value; napi_create_error(env, nullptr, String(env, error.what()), &value); napi_reject_deferred(env, task->deferred, value);
  }
  if (task->handle != INVALID_HANDLE_VALUE) CloseHandle(task->handle);
  if (task->server) task->server->accepting = false;
  if (task->serverRef) napi_delete_reference(env, task->serverRef);
  napi_delete_async_work(env, task->work); delete task;
}
static napi_value QueuePipe(napi_env env, PipeWork* task) {
  napi_value result; napi_create_promise(env, &task->deferred, &result);
  napi_create_async_work(env, nullptr, String(env, "Crabot local authentication pipe"), ExecutePipe, CompletePipe, task, &task->work);
  napi_queue_async_work(env, task->work); return result;
}
static napi_value AcceptPipe(napi_env env, napi_callback_info info) {
  try {
    napi_value value; auto server = PipeArgument(env, info, &value);
    if (server->closed || server->accepting) throw std::runtime_error("Local pipe closed or accept already pending");
    if (server->pending == INVALID_HANDLE_VALUE) server->pending = server->Create(false);
    auto task = new PipeWork; task->server = server; task->handle = server->pending;
    server->pending = INVALID_HANDLE_VALUE; server->accepting = true;
    napi_create_reference(env, value, 1, &task->serverRef);
    return QueuePipe(env, task);
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_LOCAL_PIPE", error.what()); return nullptr; }
}
static napi_value ClosePipe(napi_env env, napi_callback_info info) {
  try {
    napi_value value; PipeArgument(env, info, &value)->Close(); napi_get_undefined(env, &value); return value;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_LOCAL_PIPE", error.what()); return nullptr; }
}
static napi_value ConnectPipe(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected local pipe name");
    auto name = PipeName(Text(env, args[0])); auto task = new PipeWork; task->connect = true; task->name = name;
    return QueuePipe(env, task);
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_LOCAL_PIPE", error.what()); return nullptr; }
}
static napi_value PipePeer(napi_env env, napi_callback_info info, bool server) {
  try {
    size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected local pipe connection");
    auto connection = GetConnection(env, args[0]); ULONG pid;
    if (connection->closed || !(server ? GetNamedPipeServerProcessId(connection->handle, &pid)
      : GetNamedPipeClientProcessId(connection->handle, &pid))) throw std::runtime_error("Cannot identify local pipe peer");
    return Object(env, Inspect(pid));
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_PEER_IDENTITY", error.what()); return nullptr; }
}
static napi_value ServerPeer(napi_env env, napi_callback_info info) { return PipePeer(env, info, true); }
static napi_value ClientPeer(napi_env env, napi_callback_info info) { return PipePeer(env, info, false); }

struct PipeIo {
  napi_async_work work = nullptr;
  napi_deferred deferred;
  napi_ref reference;
  PipeConnection* connection;
  std::vector<char> bytes;
  DWORD transferred = 0;
  bool write;
  std::string error;
};
static void ExecuteIo(napi_env, void* data) {
  auto task = static_cast<PipeIo*>(data);
  OVERLAPPED overlap{}; overlap.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!overlap.hEvent) { task->error = "Cannot create local pipe IO event"; return; }
  BOOL completed = task->write
    ? WriteFile(task->connection->handle, task->bytes.data(), task->bytes.size(), &task->transferred, &overlap)
    : ReadFile(task->connection->handle, task->bytes.data(), task->bytes.size(), &task->transferred, &overlap);
  auto error = completed ? ERROR_SUCCESS : GetLastError();
  if (error == ERROR_IO_PENDING) {
    HANDLE events[] = { overlap.hEvent, task->connection->stopped };
    auto wait = WaitForMultipleObjects(2, events, FALSE, 5000);
    if (wait != WAIT_OBJECT_0) {
      CancelIoEx(task->connection->handle, &overlap);
      GetOverlappedResult(task->connection->handle, &overlap, &task->transferred, TRUE);
      error = ERROR_OPERATION_ABORTED;
    } else if (!GetOverlappedResult(task->connection->handle, &overlap, &task->transferred, FALSE)) error = GetLastError();
    else error = ERROR_SUCCESS;
  }
  CloseHandle(overlap.hEvent);
  if (!task->write && error == ERROR_BROKEN_PIPE) task->transferred = 0;
  else if (error != ERROR_SUCCESS || (task->write && task->transferred != task->bytes.size())) task->error = "Local pipe IO failed, closed or timed out";
}
static void CompleteIo(napi_env env, napi_status status, void* data) {
  auto task = static_cast<PipeIo*>(data);
  napi_value value;
  if (status != napi_ok || !task->error.empty()) {
    napi_create_error(env, nullptr, String(env, task->error.empty() ? "Local pipe IO cancelled" : task->error), &value);
    napi_reject_deferred(env, task->deferred, value);
  } else {
    if (task->write) napi_get_undefined(env, &value);
    else if (!task->transferred) napi_get_null(env, &value);
    else napi_create_buffer_copy(env, task->transferred, task->bytes.data(), nullptr, &value);
    napi_resolve_deferred(env, task->deferred, value);
  }
  task->connection->active--;
  if (task->connection->closed) task->connection->Close();
  napi_delete_reference(env, task->reference); napi_delete_async_work(env, task->work); delete task;
}
static napi_value QueueIo(napi_env env, napi_callback_info info, bool write) {
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != (write ? 2 : 1)) throw std::runtime_error("Invalid local pipe IO arguments");
    auto connection = GetConnection(env, args[0]);
    if (connection->closed) throw std::runtime_error("Local pipe closed");
    std::vector<char> bytes(65536);
    if (write) {
      bool buffer = false; napi_is_buffer(env, args[1], &buffer); void* data; size_t size;
      if (!buffer || napi_get_buffer_info(env, args[1], &data, &size) != napi_ok || !size || size > 65536) throw std::runtime_error("Invalid local pipe frame size");
      bytes.assign(static_cast<char*>(data), static_cast<char*>(data) + size);
    }
    auto task = new PipeIo; task->connection = connection; task->write = write; task->bytes = std::move(bytes);
    napi_value result; napi_create_promise(env, &task->deferred, &result);
    napi_create_reference(env, args[0], 1, &task->reference); connection->active++;
    napi_create_async_work(env, nullptr, String(env, "Crabot local pipe IO"), ExecuteIo, CompleteIo, task, &task->work);
    napi_queue_async_work(env, task->work); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_LOCAL_PIPE", error.what()); return nullptr; }
}
static napi_value ReadPipe(napi_env env, napi_callback_info info) { return QueueIo(env, info, false); }
static napi_value WritePipe(napi_env env, napi_callback_info info) { return QueueIo(env, info, true); }
static napi_value CloseConnection(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected local pipe connection");
    GetConnection(env, args[0])->Close(); napi_value result; napi_get_undefined(env, &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_LOCAL_PIPE", error.what()); return nullptr; }
}
static void RegisterLocalPipe(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"createPipeServer", nullptr, CreatePipeServer, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"acceptPipe", nullptr, AcceptPipe, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closePipeServer", nullptr, ClosePipe, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"connectPipe", nullptr, ConnectPipe, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspectServerPeer", nullptr, ServerPeer, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspectPeer", nullptr, ClientPeer, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"readPipe", nullptr, ReadPipe, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"writePipe", nullptr, WritePipe, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closePipe", nullptr, CloseConnection, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
}
#endif
