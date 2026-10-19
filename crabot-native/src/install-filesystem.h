// Read-only OS volume facts. Never mount, chmod or grant system privileges.
#ifndef _WIN32
#ifdef __APPLE__
#include <sys/mount.h>
#else
#include <sys/vfs.h>
#include <sys/statvfs.h>
#endif
#endif
static napi_value InstallFilesystemCall(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected an existing installation directory");
    auto path = Text(env, args[0]);
    if (path.empty() || path.find('\0') != std::string::npos) throw std::runtime_error("Invalid installation directory");
    bool supported = false; std::string filesystem;
#ifdef _WIN32
    auto wide = PrivateFilePath(path); std::vector<wchar_t> volume(32768); wchar_t name[256]{}; DWORD flags = 0;
    if (!GetVolumePathNameW(wide.c_str(), volume.data(), static_cast<DWORD>(volume.size()))
      || !GetVolumeInformationW(volume.data(), nullptr, 0, nullptr, nullptr, &flags, name, 256)) throw std::runtime_error("Cannot inspect installation volume");
    filesystem = "unsupported";
    if (std::wstring(name) == L"NTFS") filesystem = "ntfs";
    else if (std::wstring(name) == L"ReFS") filesystem = "refs";
    supported = GetDriveTypeW(volume.data()) == DRIVE_FIXED && !(flags & FILE_READ_ONLY_VOLUME)
      && (flags & FILE_PERSISTENT_ACLS) && filesystem != "unsupported";
#elif __APPLE__
    struct statfs facts{};
    if (statfs(path.c_str(), &facts)) throw std::runtime_error("Cannot inspect installation volume");
    filesystem = facts.f_fstypename;
    supported = (facts.f_flags & MNT_LOCAL) && !(facts.f_flags & MNT_RDONLY) && (filesystem == "apfs" || filesystem == "hfs");
#else
    struct statfs facts{};
    if (statfs(path.c_str(), &facts)) throw std::runtime_error("Cannot inspect installation volume");
    auto type = static_cast<unsigned long>(facts.f_type);
    switch (type) {
      case 0xef53: filesystem = "ext"; break;
      case 0x9123683e: filesystem = "btrfs"; break;
      case 0x58465342: filesystem = "xfs"; break;
      case 0x2fc12fc1: filesystem = "zfs"; break;
      default: filesystem = "unsupported";
    }
    supported = filesystem != "unsupported" && !(facts.f_flags & ST_RDONLY);
#endif
    napi_value result, allowed; napi_create_object(env, &result); napi_get_boolean(env, supported, &allowed);
    Property(env, result, "supported", allowed); Property(env, result, "filesystem", String(env, filesystem)); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_INSTALL_FILESYSTEM", error.what()); return nullptr; }
}
