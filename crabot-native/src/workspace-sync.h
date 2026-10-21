#ifdef _WIN32
#include <memory>

using WorkspaceSyncHandle = std::unique_ptr<void, decltype(&CloseHandle)>;
using WorkspaceSyncSearch = std::unique_ptr<void, decltype(&FindClose)>;
struct WorkspaceSyncObject {
  WorkspaceSyncHandle metadata{nullptr, CloseHandle};
  std::vector<WorkspaceSyncHandle> writable;
  FILE_ID_INFO id{};
  FILE_BASIC_INFO basic{};
  FILE_STANDARD_INFO standard{};
  bool directory = false;
};
static WorkspaceSyncHandle OpenPinnedWorkspaceHandle(const std::wstring& path, DWORD access) {
  HANDLE raw = CreateFileW(path.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (raw == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot open pinned workspace sync object");
  return WorkspaceSyncHandle(raw, CloseHandle);
}
static void CheckWorkspaceSyncId(HANDLE file, const FILE_ID_INFO& expected) {
  FILE_ID_INFO current{};
  if (!GetFileInformationByHandleEx(file, FileIdInfo, &current, sizeof(current))
    || DirectoryIdText(current) != DirectoryIdText(expected)) throw std::runtime_error("Workspace sync object identity changed");
}
static std::vector<std::wstring> WorkspaceSyncStreams(const std::wstring& path) {
  std::vector<std::wstring> names;
  WIN32_FIND_STREAM_DATA entry{};
  HANDLE raw = FindFirstStreamW(path.c_str(), FindStreamInfoStandard, &entry, 0);
  if (raw == INVALID_HANDLE_VALUE) {
    const auto error = GetLastError();
    if (error == ERROR_HANDLE_EOF || error == ERROR_INVALID_PARAMETER) return names;
    throw std::runtime_error("Cannot enumerate workspace sync streams");
  }
  WorkspaceSyncSearch search(raw, FindClose);
  do {
    const std::wstring name(entry.cStreamName);
    if (name == L"::$DATA") continue;
    if (name.size() < 8 || name.front() != L':' || name.substr(name.size() - 6) != L":$DATA"
      || name.substr(1, name.size() - 7).find_first_of(L"\\/:") != std::wstring::npos || names.size() >= 1024) {
      throw std::runtime_error("Unsupported workspace sync stream");
    }
    names.push_back(name);
  } while (FindNextStreamW(raw, &entry));
  if (GetLastError() != ERROR_HANDLE_EOF) throw std::runtime_error("Incomplete workspace sync streams");
  return names;
}
static std::unique_ptr<WorkspaceSyncObject> OpenWorkspaceSyncObject(const std::wstring& path,
    ULONGLONG volume, const std::string* expected, const char*& stage) {
  auto object = std::make_unique<WorkspaceSyncObject>();
  stage = "metadata-open";
  object->metadata = OpenPinnedWorkspaceHandle(path, FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES);
  const auto file = object->metadata.get();
  stage = "metadata-read";
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (GetFileType(file) != FILE_TYPE_DISK
    || !GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes))
    || (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    || !GetFileInformationByHandleEx(file, FileIdInfo, &object->id, sizeof(object->id))
    || object->id.VolumeSerialNumber != volume || (expected && DirectoryIdText(object->id) != *expected)
    || !GetFileInformationByHandleEx(file, FileBasicInfo, &object->basic, sizeof(object->basic))
    || !GetFileInformationByHandleEx(file, FileStandardInfo, &object->standard, sizeof(object->standard))
    || object->standard.DeletePending) throw std::runtime_error("Cannot verify ordinary workspace sync object");
  object->directory = (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  bool identified = false;
  for (auto byte : object->id.FileId.Identifier) if (byte) identified = true;
  if (!identified || !!object->standard.Directory != object->directory) throw std::runtime_error("Workspace sync type or identity is unavailable");
  if (!object->directory && object->standard.NumberOfLinks != 1) throw std::runtime_error("Workspace sync does not mutate a hard-linked file");
  stage = "stream-enumeration";
  const auto streams = WorkspaceSyncStreams(path);
  bool readonlyChanged = false;
  const auto restore = [&]() {
    if (!readonlyChanged) return;
    readonlyChanged = false; // Submit restoration once; an unknown result is never retried.
    stage = "readonly-restore";
    if (!SetFileInformationByHandle(file, FileBasicInfo, &object->basic, sizeof(object->basic))) throw std::runtime_error("Cannot restore workspace staging readonly metadata");
  };
  try {
    if (object->basic.FileAttributes & FILE_ATTRIBUTE_READONLY) {
      FILE_BASIC_INFO writable = object->basic;
      writable.FileAttributes &= ~FILE_ATTRIBUTE_READONLY;
      if (!writable.FileAttributes) writable.FileAttributes = FILE_ATTRIBUTE_NORMAL;
      stage = "readonly-clear";
      if (!SetFileInformationByHandle(file, FileBasicInfo, &writable, sizeof(writable))) throw std::runtime_error("Cannot prepare workspace staging write handle");
      readonlyChanged = true;
    }
    stage = "write-handle";
    object->writable.push_back(OpenPinnedWorkspaceHandle(path, GENERIC_WRITE | FILE_READ_ATTRIBUTES));
    CheckWorkspaceSyncId(object->writable.back().get(), object->id);
    for (const auto& name : streams) {
      object->writable.push_back(OpenPinnedWorkspaceHandle(path + name, GENERIC_WRITE | FILE_READ_ATTRIBUTES));
      CheckWorkspaceSyncId(object->writable.back().get(), object->id);
    }
    restore();
  } catch (...) {
    const auto failedStage = stage;
    restore();
    stage = failedStage;
    throw;
  }
  return object;
}
static void FlushWorkspaceSyncObject(const WorkspaceSyncObject& object, const char*& stage) {
  stage = "flush";
  // Each named stream precedes the main file/directory metadata flush.
  for (auto item = object.writable.rbegin(); item != object.writable.rend(); ++item) {
    if (!FlushFileBuffers(item->get())) throw std::runtime_error("Cannot flush workspace staging object");
  }
  stage = "flush-readback";
  CheckWorkspaceSyncId(object.metadata.get(), object.id);
  FILE_BASIC_INFO basic{}; FILE_STANDARD_INFO standard{};
  if (!GetFileInformationByHandleEx(object.metadata.get(), FileBasicInfo, &basic, sizeof(basic))
    || !GetFileInformationByHandleEx(object.metadata.get(), FileStandardInfo, &standard, sizeof(standard))
    || basic.FileAttributes != object.basic.FileAttributes || basic.LastWriteTime.QuadPart != object.basic.LastWriteTime.QuadPart
    || standard.EndOfFile.QuadPart != object.standard.EndOfFile.QuadPart || standard.DeletePending
    || (!object.directory && standard.NumberOfLinks != 1)) throw std::runtime_error("Workspace sync object changed while flushing");
}
// Neutral ordinary-directory name cursor; it performs no metadata writes or synchronization.
struct WorkspaceDirectoryCursor {
  std::wstring path;
  WorkspaceSyncSearch search{nullptr, FindClose};
  bool started = false;
  bool Next(std::wstring& name) {
    WIN32_FIND_DATAW entry{};
    for (;;) {
      BOOL found;
      if (!started) {
        started = true;
        HANDLE raw = FindFirstFileW((path + L"\\*").c_str(), &entry);
        if (raw == INVALID_HANDLE_VALUE) {
          if (GetLastError() == ERROR_FILE_NOT_FOUND) return false;
          throw std::runtime_error("Cannot enumerate workspace sync directory");
        }
        search.reset(raw);
        found = TRUE;
      } else found = FindNextFileW(search.get(), &entry);
      if (!found) {
        if (GetLastError() == ERROR_NO_MORE_FILES) return false;
        throw std::runtime_error("Incomplete workspace sync directory");
      }
      name = entry.cFileName;
      if (name != L"." && name != L"..") return true;
    }
  }
};
struct WorkspaceSyncDirectory : WorkspaceDirectoryCursor {
  std::unique_ptr<WorkspaceSyncObject> object;
};
// Physical staging synchronization only. The fixed job owns authority, source validation and file-ready publication.
static napi_value SyncPinnedWorkspaceTree(napi_env env, napi_callback_info info) {
  const char* stage = "root-pin";
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected one owned workspace staging directory pin");
    auto pin = OwnedDirectoryPin(env, args[0]);
    const auto rootId = PinnedDirectoryId(pin->handles.back());
    if (DirectoryIdText(rootId) != pin->identity) throw std::runtime_error("Workspace sync root pin changed");
    auto root = OpenWorkspaceSyncObject(pin->path, rootId.VolumeSerialNumber, &pin->identity, stage);
    if (!root->directory) throw std::runtime_error("Workspace sync root is not a directory");
    uint32_t files = 0, directories = 1, streams = static_cast<uint32_t>(root->writable.size() - 1);
    std::vector<std::unique_ptr<WorkspaceSyncDirectory>> stack;
    auto first = std::make_unique<WorkspaceSyncDirectory>();
    first->path = pin->path;
    first->object = std::move(root);
    stack.push_back(std::move(first));
    while (!stack.empty()) {
      auto& directory = *stack.back();
      std::wstring name;
      stage = "directory-enumeration";
      if (!directory.Next(name)) {
        FlushWorkspaceSyncObject(*directory.object, stage);
        stack.pop_back();
        continue;
      }
      if (files + directories >= 1000000) throw std::runtime_error("Workspace sync object limit exceeded");
      const auto childPath = directory.path + L"\\" + name;
      auto child = OpenWorkspaceSyncObject(childPath, rootId.VolumeSerialNumber, nullptr, stage);
      streams += static_cast<uint32_t>(child->writable.size() - 1);
      if (child->directory) {
        directories++;
        auto frame = std::make_unique<WorkspaceSyncDirectory>();
        frame->path = childPath;
        frame->object = std::move(child);
        stack.push_back(std::move(frame));
      } else {
        files++;
        FlushWorkspaceSyncObject(*child, stage);
      }
    }
    stage = "root-readback";
    if (DirectoryIdText(PinnedDirectoryId(pin->handles.back())) != pin->identity
      || DirectoryIdText(MoveDirectoryId(pin->path)) != pin->identity) throw std::runtime_error("Workspace sync root changed");
    napi_value result, count; napi_create_object(env, &result);
    napi_create_uint32(env, files, &count); napi_set_named_property(env, result, "files", count);
    napi_create_uint32(env, directories, &count); napi_set_named_property(env, result, "directories", count);
    napi_create_uint32(env, streams, &count); napi_set_named_property(env, result, "streams", count); return result;
  } catch (const std::exception& error) {
    napi_value result; napi_create_error(env, String(env, "WORKSPACE_SYNC_UNVERIFIED"), String(env, error.what()), &result);
    napi_set_named_property(env, result, "stage", String(env, stage)); napi_throw(env, result); return nullptr;
  }
}
#endif
