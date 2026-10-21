#ifdef _WIN32
struct WorkspaceMetadataObject {
  WorkspaceSyncHandle file{nullptr, CloseHandle};
  FILE_ID_INFO id{};
  FILE_STANDARD_INFO standard{};
  bool directory = false;
};
static WorkspaceMetadataObject OpenWorkspaceMetadataObject(const std::wstring& path, ULONGLONG volume, bool writable) {
  WorkspaceMetadataObject object;
  object.file = OpenPinnedWorkspaceHandle(path, READ_CONTROL | FILE_READ_ATTRIBUTES
    | (writable ? WRITE_DAC | WRITE_OWNER | FILE_WRITE_ATTRIBUTES : 0));
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (GetFileType(object.file.get()) != FILE_TYPE_DISK
    || !GetFileInformationByHandleEx(object.file.get(), FileAttributeTagInfo, &attributes, sizeof(attributes))
    || (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    || !GetFileInformationByHandleEx(object.file.get(), FileIdInfo, &object.id, sizeof(object.id))
    || object.id.VolumeSerialNumber != volume
    || !GetFileInformationByHandleEx(object.file.get(), FileStandardInfo, &object.standard, sizeof(object.standard))
    || object.standard.DeletePending) throw std::runtime_error("Cannot identify ordinary workspace metadata object");
  object.directory = (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  bool identified = false;
  for (auto byte : object.id.FileId.Identifier) if (byte) identified = true;
  if (!identified || !!object.standard.Directory != object.directory
    || (!object.directory && object.standard.NumberOfLinks != 1)) throw std::runtime_error("Unsupported workspace metadata object");
  return object;
}
struct WorkspaceMetadataDirectory {
  WorkspaceDirectoryCursor cursor;
  std::wstring targetPath;
  WorkspaceMetadataObject source, target;
};
// Exact source metadata on the copied tree only. Source objects are always opened read-only.
static napi_value CopyPinnedWorkspaceMetadata(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 3; napi_value args[3]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) throw std::runtime_error("Expected two actual workspace directory pins");
    auto source = OwnedDirectoryPin(env, args[0]), target = OwnedDirectoryPin(env, args[1]);
    const auto inside = [](const std::wstring& parent, const std::wstring& child) {
      return parent.size() <= child.size() && CompareStringOrdinal(parent.data(), static_cast<int>(parent.size()), child.data(), static_cast<int>(parent.size()), TRUE) == CSTR_EQUAL
        && (parent.size() == child.size() || child[parent.size()] == L'\\');
    };
    if (inside(source->path, target->path) || inside(target->path, source->path)) throw std::runtime_error("Workspace metadata roots overlap");
    const auto sourceId = PinnedDirectoryId(source->handles.back()), targetId = PinnedDirectoryId(target->handles.back());
    if (DirectoryIdText(sourceId) != source->identity || DirectoryIdText(targetId) != target->identity) throw std::runtime_error("Workspace metadata root changed");
    const auto openPair = [&](const std::wstring& from, const std::wstring& to) {
      auto pair = std::make_unique<WorkspaceMetadataDirectory>();
      pair->cursor.path = from; pair->targetPath = to;
      pair->source = OpenWorkspaceMetadataObject(from, sourceId.VolumeSerialNumber, false);
      pair->target = OpenWorkspaceMetadataObject(to, targetId.VolumeSerialNumber, true);
      if (pair->source.directory != pair->target.directory
        || (!pair->source.directory && pair->source.standard.EndOfFile.QuadPart != pair->target.standard.EndOfFile.QuadPart)) throw std::runtime_error("Copied workspace metadata type or size differs");
      CopyWorkspaceObjectMetadata(pair->source.file.get(), pair->target.file.get(), to);
      return pair;
    };
    auto root = openPair(source->path, target->path);
    if (!root->source.directory || DirectoryIdText(root->source.id) != source->identity
      || DirectoryIdText(root->target.id) != target->identity) throw std::runtime_error("Workspace metadata root identity changed");
    std::vector<std::unique_ptr<WorkspaceMetadataDirectory>> stack;
    stack.push_back(std::move(root));
    uint32_t objects = 1;
    while (!stack.empty()) {
      auto& parent = *stack.back();
      std::wstring name;
      if (!parent.cursor.Next(name)) {
        stack.pop_back();
        continue;
      }
      if (objects++ >= 999999) throw std::runtime_error("Workspace metadata object limit exceeded");
      auto child = openPair(parent.cursor.path + L"\\" + name, parent.targetPath + L"\\" + name);
      if (child->source.directory) stack.push_back(std::move(child));
    }
    if (DirectoryIdText(MoveDirectoryId(source->path)) != source->identity
      || DirectoryIdText(MoveDirectoryId(target->path)) != target->identity) throw std::runtime_error("Workspace metadata roots changed");
    napi_value result; napi_get_undefined(env, &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_WORKSPACE_METADATA", error.what()); return nullptr; }
}
#endif
