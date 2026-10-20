// Read-only filesystem metadata. This is not an ownership, copy or migration permission.
#include <algorithm>
#include <cstdint>
#ifndef _WIN32
#include <sys/xattr.h>
#ifdef __APPLE__
#include <sys/acl.h>
#else
#include <linux/stat.h>
#endif
#endif

static constexpr size_t MetadataLimit = 16 * 1024 * 1024;

static void MetadataPart(std::string& output, const std::string& value) {
  if (value.size() > MetadataLimit || output.size() + value.size() + 32 > MetadataLimit) throw std::runtime_error("File metadata exceeds bounded verification limit");
  output += std::to_string(value.size()) + ':' + value;
}
#ifndef _WIN32
static std::string MetadataXattrs(const std::string& path) {
#ifdef __APPLE__
  auto list = [&](char* buffer, size_t size) { return listxattr(path.c_str(), buffer, size, XATTR_NOFOLLOW); };
  auto read = [&](const char* name, void* buffer, size_t size) { return getxattr(path.c_str(), name, buffer, size, 0, XATTR_NOFOLLOW); };
#else
  auto list = [&](char* buffer, size_t size) { return llistxattr(path.c_str(), buffer, size); };
  auto read = [&](const char* name, void* buffer, size_t size) { return lgetxattr(path.c_str(), name, buffer, size); };
#endif
  auto size = list(nullptr, 0);
  if (size < 0) throw std::runtime_error("Cannot enumerate file extended attributes");
  if (static_cast<size_t>(size) > MetadataLimit) throw std::runtime_error("File metadata exceeds bounded verification limit");
  std::vector<char> bytes(static_cast<size_t>(size));
  if (list(bytes.data(), bytes.size()) != size) throw std::runtime_error("File extended attributes changed");
  std::vector<std::string> names;
  for (size_t at = 0; at < bytes.size();) {
    auto end = std::find(bytes.begin() + at, bytes.end(), '\0');
    if (end == bytes.end() || end == bytes.begin() + at) throw std::runtime_error("Invalid extended attribute name");
    names.emplace_back(bytes.data() + at, end - (bytes.begin() + at)); at += names.back().size() + 1;
  }
  std::sort(names.begin(), names.end());
  std::string result;
  for (const auto& name : names) {
    auto length = read(name.c_str(), nullptr, 0);
    if (length < 0) throw std::runtime_error("Cannot read file extended attribute");
    if (static_cast<size_t>(length) > MetadataLimit) throw std::runtime_error("File metadata exceeds bounded verification limit");
    std::string value(static_cast<size_t>(length), '\0');
    if (read(name.c_str(), value.data(), value.size()) != length) throw std::runtime_error("File extended attribute changed");
    MetadataPart(result, name); MetadataPart(result, value);
  }
  return result;
}
#else
static std::string MetadataSecurity(HANDLE file) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD fields = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
  if (GetSecurityInfo(file, SE_FILE_OBJECT, fields, nullptr, nullptr, nullptr, nullptr, &descriptor) != ERROR_SUCCESS) {
    throw std::runtime_error("Cannot inspect file owner and access ACL");
  }
  LPSTR text = nullptr;
  const bool ok = ConvertSecurityDescriptorToStringSecurityDescriptorA(descriptor, SDDL_REVISION_1, fields, &text, nullptr);
  LocalFree(descriptor);
  if (!ok) throw std::runtime_error("Cannot serialize file access ACL");
  std::string result(text); LocalFree(text); return result;
}
static std::string MetadataWindowsEas(HANDLE file) {
  using Query = NTSTATUS(NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, BOOLEAN, PVOID, ULONG, PULONG, BOOLEAN);
  auto query = reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryEaFile"));
  if (!query) throw std::runtime_error("Cannot inspect file extended attributes");
  std::vector<unsigned char> buffer(65536); IO_STATUS_BLOCK status{};
  auto code = query(file, &status, buffer.data(), static_cast<ULONG>(buffer.size()), FALSE, nullptr, 0, nullptr, TRUE);
  if (code == static_cast<NTSTATUS>(0xC0000052L) || code == static_cast<NTSTATUS>(0xC000004FL)) return {};
  if (code != 0 || status.Information > buffer.size()) throw std::runtime_error("Cannot read all file extended attributes");
  std::vector<std::pair<std::string, std::string>> attributes;
  for (size_t at = 0; at < status.Information;) {
    if (status.Information - at < 8) throw std::runtime_error("Incomplete extended attribute entry");
    ULONG next = 0; USHORT valueLength = 0;
    std::memcpy(&next, buffer.data() + at, sizeof(next)); std::memcpy(&valueLength, buffer.data() + at + 6, sizeof(valueLength));
    const size_t nameLength = buffer[at + 5], size = 8 + nameLength + 1 + valueLength;
    if (!nameLength || size > status.Information - at || buffer[at + 8 + nameLength] != 0
        || (next && (next < size || next > status.Information - at))) throw std::runtime_error("Invalid extended attribute entry");
    std::string name(reinterpret_cast<char*>(buffer.data() + at + 8), nameLength), value(1, static_cast<char>(buffer[at + 4]));
    value.append(reinterpret_cast<char*>(buffer.data() + at + 9 + nameLength), valueLength);
    attributes.emplace_back(name, value);
    if (!next) break;
    at += next;
  }
  std::sort(attributes.begin(), attributes.end()); std::string result;
  for (const auto& entry : attributes) { MetadataPart(result, entry.first); MetadataPart(result, entry.second); }
  return result;
}
#endif

static napi_value InspectFileMetadata(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected exactly one absolute file path");
    const auto path = Text(env, args[0]);
    if (!MoveAbsolutePath(path)) throw std::runtime_error("Expected an absolute file path without trailing separators");
    std::string data; std::vector<std::string> streams, blockers;
#ifdef _WIN32
    const auto wide = MoveWidePath(path);
    HANDLE file = CreateFileW(wide.c_str(), FILE_READ_EA | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot open file metadata");
    try {
      FILE_ATTRIBUTE_TAG_INFO attributes{};
      if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes))
          || (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) throw std::runtime_error("Reparse-point metadata is not supported");
      MetadataPart(data, std::to_string(attributes.FileAttributes)); MetadataPart(data, MetadataSecurity(file));
      MetadataPart(data, MetadataWindowsEas(file));
      WIN32_FIND_STREAM_DATA stream{};
      HANDLE search = FindFirstStreamW(wide.c_str(), FindStreamInfoStandard, &stream, 0);
      if (search == INVALID_HANDLE_VALUE) {
        auto error = GetLastError();
        if (error != ERROR_HANDLE_EOF && error != ERROR_INVALID_PARAMETER) throw std::runtime_error("Cannot enumerate file streams");
      } else {
        do {
          std::wstring name(stream.cStreamName);
          if (name != L"::$DATA") {
            if (name.size() < 8 || name[0] != L':' || name.substr(name.size() - 6) != L":$DATA") { FindClose(search); throw std::runtime_error("Invalid named file stream"); }
            name.resize(name.size() - 6);
            int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name.data(), static_cast<int>(name.size()), nullptr, 0, nullptr, nullptr);
            if (length <= 0) { FindClose(search); throw std::runtime_error("Cannot encode file stream name"); }
            std::string encoded(length, '\0');
            WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name.data(), static_cast<int>(name.size()), encoded.data(), length, nullptr, nullptr);
            streams.push_back(encoded);
          }
        } while (FindNextStreamW(search, &stream));
        auto error = GetLastError(); FindClose(search);
        if (error != ERROR_HANDLE_EOF) throw std::runtime_error("File stream enumeration failed");
      }
      CloseHandle(file);
    } catch (...) { CloseHandle(file); throw; }
#else
    struct stat stat{};
    if (lstat(path.c_str(), &stat) || (!S_ISREG(stat.st_mode) && !S_ISDIR(stat.st_mode) && !S_ISLNK(stat.st_mode))) {
      throw std::runtime_error("Cannot inspect ordinary file, directory or link metadata");
    }
    MetadataPart(data, std::to_string(stat.st_mode)); MetadataPart(data, std::to_string(stat.st_uid)); MetadataPart(data, std::to_string(stat.st_gid));
    MetadataPart(data, MetadataXattrs(path));
#ifdef __APPLE__
    MetadataPart(data, std::to_string(stat.st_flags));
    if (stat.st_flags & (UF_IMMUTABLE | UF_APPEND | SF_IMMUTABLE | SF_APPEND)) blockers.push_back("immutable_or_append");
    if (stat.st_flags & 0xffff0000u) blockers.push_back("system_file_flags");
    errno = 0; acl_t acl = acl_get_link_np(path.c_str(), ACL_TYPE_EXTENDED);
    if (!acl && errno != ENOENT) throw std::runtime_error("Cannot inspect file access ACL");
    std::string encoded;
    if (acl) {
      auto size = acl_size(acl);
      if (size < 0 || static_cast<size_t>(size) > MetadataLimit) { acl_free(acl); throw std::runtime_error("Cannot size bounded file access ACL"); }
      encoded.resize(static_cast<size_t>(size));
      auto copied = acl_copy_ext(encoded.data(), acl, encoded.size()); acl_free(acl);
      if (copied < 0) throw std::runtime_error("Cannot serialize file access ACL");
      encoded.resize(static_cast<size_t>(copied));
    }
    MetadataPart(data, encoded);
#else
#ifdef SYS_statx
    struct statx extended{};
    if (syscall(SYS_statx, AT_FDCWD, path.c_str(), AT_SYMLINK_NOFOLLOW, STATX_BASIC_STATS, &extended)) {
      throw std::runtime_error("Cannot inspect Linux filesystem attributes");
    }
    const uint64_t flags = STATX_ATTR_COMPRESSED | STATX_ATTR_IMMUTABLE | STATX_ATTR_APPEND
      | STATX_ATTR_NODUMP | STATX_ATTR_ENCRYPTED | STATX_ATTR_VERITY;
    MetadataPart(data, std::to_string(extended.stx_attributes & flags));
    if (extended.stx_attributes & flags) blockers.push_back("linux_file_flags");
#else
    throw std::runtime_error("Linux filesystem attribute inspection is unavailable");
#endif
#endif
#endif
    std::sort(streams.begin(), streams.end());
    napi_value result, bytes, names; napi_create_object(env, &result);
    napi_create_buffer_copy(env, data.size(), data.data(), nullptr, &bytes); napi_set_named_property(env, result, "metadata", bytes);
    napi_create_array_with_length(env, streams.size(), &names);
    for (size_t i = 0; i < streams.size(); i++) { napi_value name; napi_create_string_utf8(env, streams[i].data(), streams[i].size(), &name); napi_set_element(env, names, i, name); }
    napi_set_named_property(env, result, "streams", names);
    napi_value blocked; napi_create_array_with_length(env, blockers.size(), &blocked);
    for (size_t i = 0; i < blockers.size(); i++) { napi_value name; napi_create_string_utf8(env, blockers[i].data(), blockers[i].size(), &name); napi_set_element(env, blocked, i, name); }
    napi_set_named_property(env, result, "copy_blockers", blocked); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_FILE_METADATA", error.what()); return nullptr; }
}
