#ifndef _WIN32
static int DirectoryDescriptor(napi_env env, napi_value argument) {
  double value = -1;
  if (napi_get_value_double(env, argument, &value) != napi_ok || !std::isfinite(value) || value < 0
    || value > 2147483647 || std::floor(value) != value) throw std::runtime_error("Invalid directory descriptor");
  return static_cast<int>(value);
}
static napi_value CreatePrivateStagingDirectory(napi_env env, napi_callback_info info) {
  int fd = -1;
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected one new staging directory path");
    const auto path = Text(env, args[0]);
    if (!MoveAbsolutePath(path) || mkdir(path.c_str(), 0700)) throw std::runtime_error("Cannot create exclusive private staging directory");
    struct stat entry{}, opened{}, after{};
    if (lstat(path.c_str(), &entry)) throw std::runtime_error("Cannot inspect new staging directory");
    fd = open(path.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (fd < 0 || fstat(fd, &opened) || !S_ISDIR(opened.st_mode) || opened.st_uid != geteuid()
      || opened.st_dev != entry.st_dev || opened.st_ino != entry.st_ino) throw std::runtime_error("Staging directory identity changed");
#ifdef __APPLE__
    // A selected parent can have inheritable ACLs that override mode 0700. Touch only our opened new directory.
    acl_t empty = acl_init(0);
    if (!empty) throw std::runtime_error("Cannot create empty staging access ACL");
    const int code = acl_set_fd(fd, empty); acl_free(empty);
    if (code) throw std::runtime_error("Cannot remove inherited staging access ACL");
#endif
    if (fchmod(fd, 0700) || lstat(path.c_str(), &after) || !S_ISDIR(after.st_mode)
      || after.st_dev != opened.st_dev || after.st_ino != opened.st_ino || after.st_uid != geteuid()
      || (after.st_mode & 0777) != 0700) throw std::runtime_error("Private staging directory could not be verified");
    close(fd); fd = -1;
    napi_value result, dev, ino; napi_create_object(env, &result);
    const auto device = std::to_string(opened.st_dev), inode = std::to_string(opened.st_ino);
    napi_create_string_utf8(env, device.data(), device.size(), &dev); napi_create_string_utf8(env, inode.data(), inode.size(), &ino);
    napi_set_named_property(env, result, "dev", dev); napi_set_named_property(env, result, "ino", ino); return result;
  } catch (const std::exception& error) {
    if (fd >= 0) close(fd);
    napi_throw_error(env, "CRABOT_PRIVATE_STAGING", error.what()); return nullptr;
  }
}
#endif

#ifndef _WIN32
static napi_value EnterDirectoryFd(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 4; napi_value args[4]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 3) throw std::runtime_error("Expected an inherited directory descriptor and identity");
    const int fd = DirectoryDescriptor(env, args[0]);
    const auto device = Text(env, args[1]), inode = Text(env, args[2]); struct stat stat{};
    if (fstat(fd, &stat) || !S_ISDIR(stat.st_mode) || std::to_string(stat.st_dev) != device || std::to_string(stat.st_ino) != inode
      || fchdir(fd)) throw std::runtime_error("Inherited directory identity could not be verified");
    napi_value result; napi_get_undefined(env, &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_DIRECTORY_FD", error.what()); return nullptr; }
}
#endif

#ifndef _WIN32
static napi_value CopyDirectoryTimesFd(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 3; napi_value args[3]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) throw std::runtime_error("Expected two open directory descriptors");
    const int source = DirectoryDescriptor(env, args[0]), target = DirectoryDescriptor(env, args[1]);
    struct stat before{}, destination{};
    if (fstat(source, &before) || fstat(target, &destination) || !S_ISDIR(before.st_mode) || !S_ISDIR(destination.st_mode)
      || (before.st_dev == destination.st_dev && before.st_ino == destination.st_ino)) throw std::runtime_error("Expected distinct ordinary directories");
#ifdef __APPLE__
    const struct timespec times[2] = { before.st_atimespec, before.st_mtimespec };
#else
    const struct timespec times[2] = { before.st_atim, before.st_mtim };
#endif
    if (futimens(target, times)) throw std::runtime_error("Directory timestamps could not be copied");
    napi_value result; napi_get_undefined(env, &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_DIRECTORY_TIMES", error.what()); return nullptr; }
}
#endif

#ifdef _WIN32
// Observe existing directory rights; OPEN_EXISTING never creates a probe file.
static napi_value InspectDirectoryWriteAccess(napi_env env, napi_callback_info info) {
  HANDLE directory = INVALID_HANDLE_VALUE;
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected one existing directory path");
    const auto path = Text(env, args[0]);
    if (!MoveAbsolutePath(path)) throw std::runtime_error("Expected an absolute directory path");
    const auto wide = MoveWidePath(path);
    directory = CreateFileW(wide.c_str(), FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    bool allowed = false;
    if (directory == INVALID_HANDLE_VALUE) {
      if (GetLastError() != ERROR_ACCESS_DENIED) throw std::runtime_error("Cannot observe directory write access");
    } else {
      FILE_ATTRIBUTE_TAG_INFO attributes{};
      if (!GetFileInformationByHandleEx(directory, FileAttributeTagInfo, &attributes, sizeof(attributes))) {
        throw std::runtime_error("Cannot identify target access directory");
      }
      std::vector<wchar_t> volume(32768); DWORD flags = 0;
      if (!GetVolumePathNameW(wide.c_str(), volume.data(), static_cast<DWORD>(volume.size()))
        || !GetVolumeInformationW(volume.data(), nullptr, 0, nullptr, nullptr, &flags, nullptr, 0)) {
        throw std::runtime_error("Cannot observe target volume write access");
      }
      allowed = (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
        && !(flags & FILE_READ_ONLY_VOLUME);
      CloseHandle(directory); directory = INVALID_HANDLE_VALUE;
    }
    napi_value result; napi_get_boolean(env, allowed, &result); return result;
  } catch (const std::exception& error) {
    if (directory != INVALID_HANDLE_VALUE) CloseHandle(directory);
    napi_throw_error(env, "CRABOT_DIRECTORY_ACCESS", error.what()); return nullptr;
  }
}
#endif
