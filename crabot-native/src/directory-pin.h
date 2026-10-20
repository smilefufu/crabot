#ifdef _WIN32
#include <memory>

struct DirectoryPin {
  std::vector<HANDLE> handles;
  std::string identity;
  void Close() { for (auto it = handles.rbegin(); it != handles.rend(); ++it) CloseHandle(*it); handles.clear(); }
  ~DirectoryPin() { Close(); }
};
static const napi_type_tag DirectoryPinTag = { 0x435241424f544449ULL, 0x5250494e30303031ULL };
static std::string DirectoryIdText(const FILE_ID_INFO& id) {
  std::string value = std::to_string(id.VolumeSerialNumber) + ':';
  const char* hex = "0123456789abcdef";
  for (auto byte : id.FileId.Identifier) { value += hex[byte >> 4]; value += hex[byte & 15]; }
  return value;
}
static FILE_ID_INFO PinnedDirectoryId(HANDLE file) {
  FILE_ATTRIBUTE_TAG_INFO attributes{}; FILE_ID_INFO id{};
  if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes))
    || !(attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    || !GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id))) throw std::runtime_error("Cannot identify ordinary pinned directory");
  bool nonzero = false; for (auto byte : id.FileId.Identifier) if (byte) nonzero = true;
  if (!nonzero) throw std::runtime_error("Pinned directory identity is unavailable");
  return id;
}
static napi_value InspectDirectoryFileId(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected one directory path");
    const auto path = Text(env, args[0]);
    if (!MoveAbsolutePath(path)) throw std::runtime_error("Expected an absolute directory path");
    const auto id = DirectoryIdText(MoveDirectoryId(MoveWidePath(path)));
    napi_value value; napi_create_string_utf8(env, id.data(), id.size(), &value); return value;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_DIRECTORY_PIN", error.what()); return nullptr; }
}
static napi_value PinDirectory(napi_env env, napi_callback_info info) {
  auto pin = std::make_unique<DirectoryPin>();
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected one directory path");
    const auto path = Text(env, args[0]);
    if (!MoveAbsolutePath(path)) throw std::runtime_error("Expected an absolute directory path");
    const auto wide = MoveWidePath(path);
    // Local DOS volumes only until UNC/DFS path stability has its own native acceptance.
    if (wide.size() <= 7 || wide.rfind(L"\\\\?\\", 0) != 0 || wide[5] != L':' || wide[6] != L'\\') {
      throw std::runtime_error("Directory pin requires a local DOS volume path");
    }
    std::vector<std::wstring> paths{ wide.substr(0, 7) };
    size_t start = 7;
    for (;;) {
      auto end = wide.find(L'\\', start);
      const auto part = wide.substr(start, end == std::wstring::npos ? end : end - start);
      if (part.empty() || part == L"." || part == L"..") throw std::runtime_error("Directory pin path is not normalized");
      paths.push_back(wide.substr(0, end));
      if (end == std::wstring::npos) break;
      start = end + 1;
    }
    for (size_t i = 0; i < paths.size(); i++) {
      const auto access = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | (i + 1 == paths.size() ? READ_CONTROL : 0);
      HANDLE file = CreateFileW(paths[i].c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
      if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot pin directory against path replacement");
      pin->handles.push_back(file);
      const auto id = PinnedDirectoryId(file);
      if (i + 1 == paths.size()) pin->identity = DirectoryIdText(id);
    }
    napi_value result, id; napi_create_object(env, &result);
    if (napi_type_tag_object(env, result, &DirectoryPinTag) != napi_ok) throw std::runtime_error("Cannot tag directory pin");
    napi_create_string_utf8(env, pin->identity.data(), pin->identity.size(), &id); napi_set_named_property(env, result, "identity", id);
    if (napi_wrap(env, result, pin.get(), [](napi_env, void* data, void*) { delete static_cast<DirectoryPin*>(data); }, nullptr, nullptr) != napi_ok) {
      throw std::runtime_error("Cannot own directory pin");
    }
    pin.release(); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_DIRECTORY_PIN", error.what()); return nullptr; }
}
static napi_value ReleaseDirectoryPin(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    bool tagged = false; void* data = nullptr; napi_valuetype type = napi_undefined;
    if (argc == 1) napi_typeof(env, args[0], &type);
    if (argc != 1 || type != napi_object || napi_check_object_type_tag(env, args[0], &DirectoryPinTag, &tagged) != napi_ok || !tagged
      || napi_unwrap(env, args[0], &data) != napi_ok || !data) throw std::runtime_error("Expected an owned directory pin");
    static_cast<DirectoryPin*>(data)->Close();
    napi_value value; napi_get_undefined(env, &value); return value;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_DIRECTORY_PIN", error.what()); return nullptr; }
}
#endif
