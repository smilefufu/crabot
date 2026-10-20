// Physical directory rename only. The caller owns job authorization, identity, journals and fsync.
#ifndef _WIN32
#include <sys/stat.h>
#include <stdio.h>
#ifdef __APPLE__
#include <sys/stdio.h>
#endif
#endif

static bool MoveAbsolutePath(const std::string& path) {
  if (path.empty() || path.find('\0') != std::string::npos) return false;
#ifdef _WIN32
  if (path.back() == '/' || path.back() == '\\') return false;
  const bool drive = path.size() > 3 && ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z'))
    && path[1] == ':' && (path[2] == '/' || path[2] == '\\');
  return drive || (path.size() > 2 && path[0] == '\\' && path[1] == '\\');
#else
  return path.front() == '/' && path.back() != '/';
#endif
}
#ifdef _WIN32
static std::wstring MoveWidePath(const std::string& path) {
  // PrivateFilePath is only the shared UTF-8/NUL conversion, without an ownership grant.
  auto wide = PrivateFilePath(path);
  for (auto& character : wide) if (character == L'/') character = L'\\';
  if (wide.rfind(L"\\\\.\\", 0) == 0) throw std::runtime_error("Device paths are not directory moves");
  if (wide.rfind(L"\\\\?\\", 0) == 0) return wide;
  if (wide.rfind(L"\\\\", 0) == 0) return L"\\\\?\\UNC\\" + wide.substr(2);
  return L"\\\\?\\" + wide;
}
static FILE_ID_INFO MoveDirectoryId(const std::wstring& path) {
  HANDLE file = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot inspect move directory");
  FILE_ATTRIBUTE_TAG_INFO attributes{}; FILE_ID_INFO identity{};
  bool valid = GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes))
    && (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    && GetFileInformationByHandleEx(file, FileIdInfo, &identity, sizeof(identity));
  CloseHandle(file);
  bool identified = false;
  for (auto byte : identity.FileId.Identifier) if (byte) identified = true;
  if (!valid || !identified) throw std::runtime_error("Move source or result is not a verifiable ordinary directory");
  return identity;
}
#endif
static napi_value RenameDirectoryNoReplace(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 3; napi_value args[3]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) throw std::runtime_error("Expected exactly two directory paths");
    auto source = Text(env, args[0]), target = Text(env, args[1]);
    if (!MoveAbsolutePath(source) || !MoveAbsolutePath(target)) throw std::runtime_error("Expected absolute directory paths without trailing separators");
#ifdef _WIN32
    auto from = MoveWidePath(source), to = MoveWidePath(target);
    auto before = MoveDirectoryId(from);
    // Neither replacement nor cross-volume copy-and-delete is allowed.
    if (!MoveFileExW(from.c_str(), to.c_str(), MOVEFILE_WRITE_THROUGH)) throw std::runtime_error("Atomic directory move without replacement failed");
    auto after = MoveDirectoryId(to);
    if (before.VolumeSerialNumber != after.VolumeSerialNumber || std::memcmp(before.FileId.Identifier, after.FileId.Identifier, sizeof(before.FileId.Identifier))) {
      throw std::runtime_error("Moved directory identity changed; retain maintenance evidence");
    }
#else
    struct stat before{}, after{};
    if (lstat(source.c_str(), &before) || !S_ISDIR(before.st_mode)) throw std::runtime_error("Move source is not an ordinary directory");
#ifdef __APPLE__
    if (renamex_np(source.c_str(), target.c_str(), RENAME_EXCL)) throw std::runtime_error("Atomic directory move without replacement failed");
#else
#ifdef SYS_renameat2
    if (syscall(SYS_renameat2, AT_FDCWD, source.c_str(), AT_FDCWD, target.c_str(), 1u /* RENAME_NOREPLACE */)) throw std::runtime_error("Atomic directory move without replacement failed");
#else
    throw std::runtime_error("Atomic no-replace directory move is unavailable");
#endif
#endif
    if (lstat(target.c_str(), &after) || !S_ISDIR(after.st_mode) || before.st_dev != after.st_dev || before.st_ino != after.st_ino) {
      throw std::runtime_error("Moved directory identity changed; retain maintenance evidence");
    }
#endif
    napi_value result; napi_get_undefined(env, &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_DIRECTORY_MOVE", error.what()); return nullptr; }
}
