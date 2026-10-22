// One same-volume regular-file move only. The caller owns authorization, privacy and parent fsync.
#ifdef _WIN32
static FILE_ID_INFO MoveRegularFileId(const std::wstring& path) {
  HANDLE file = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot inspect move file");
  FILE_ATTRIBUTE_TAG_INFO attributes{}; FILE_STANDARD_INFO standard{}; FILE_ID_INFO identity{};
  bool valid = GetFileType(file) == FILE_TYPE_DISK
    && GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes))
    && !(attributes.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
    && GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)) && standard.NumberOfLinks == 1
    && GetFileInformationByHandleEx(file, FileIdInfo, &identity, sizeof(identity));
  CloseHandle(file);
  bool identified = false;
  for (auto byte : identity.FileId.Identifier) if (byte) identified = true;
  if (!valid || !identified) throw std::runtime_error("Move source or result is not a verifiable single-link regular file");
  return identity;
}
#endif
static napi_value RenameFileNoReplace(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 3; napi_value args[3]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) throw std::runtime_error("Expected exactly two file paths");
    auto source = Text(env, args[0]), target = Text(env, args[1]);
    if (source == target || !MoveAbsolutePath(source) || !MoveAbsolutePath(target)) throw std::runtime_error("Expected absolute file paths without trailing separators");
#ifdef _WIN32
    auto from = MoveWidePath(source), to = MoveWidePath(target);
    auto before = MoveRegularFileId(from);
    if (!MoveFileExW(from.c_str(), to.c_str(), MOVEFILE_WRITE_THROUGH)) throw std::runtime_error("Atomic file move without replacement failed");
    auto after = MoveRegularFileId(to);
    if (before.VolumeSerialNumber != after.VolumeSerialNumber || std::memcmp(before.FileId.Identifier, after.FileId.Identifier, sizeof(before.FileId.Identifier))) {
      throw std::runtime_error("Moved file identity changed; retain finalization diagnostics");
    }
#else
    struct stat before{}, after{};
    if (lstat(source.c_str(), &before) || !S_ISREG(before.st_mode) || before.st_nlink != 1) throw std::runtime_error("Move source is not a single-link regular file");
#ifdef __APPLE__
    if (renamex_np(source.c_str(), target.c_str(), RENAME_EXCL)) throw std::runtime_error("Atomic file move without replacement failed");
#else
#ifdef SYS_renameat2
    if (syscall(SYS_renameat2, AT_FDCWD, source.c_str(), AT_FDCWD, target.c_str(), 1u /* RENAME_NOREPLACE */)) throw std::runtime_error("Atomic file move without replacement failed");
#else
    throw std::runtime_error("Atomic no-replace file move is unavailable");
#endif
#endif
    if (lstat(target.c_str(), &after) || !S_ISREG(after.st_mode) || after.st_nlink != 1 || before.st_dev != after.st_dev || before.st_ino != after.st_ino) {
      throw std::runtime_error("Moved file identity changed; retain finalization diagnostics");
    }
#endif
    napi_value result; napi_get_undefined(env, &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_FILE_MOVE", error.what()); return nullptr; }
}
