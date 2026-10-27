#ifdef _WIN32
#include <aclapi.h>

// ACL ownership needs the current primary token, not a process-table snapshot.
// Read it afresh: this is not a cached user or process-identity receipt.
static std::string PrivateFileCurrentOwner() {
  HANDLE token = nullptr; LPSTR sid = nullptr;
  try {
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) throw std::runtime_error("Cannot inspect current file owner");
    DWORD size = 0; GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    if (!size || size > 65536) throw std::runtime_error("Current file owner is unavailable");
    std::vector<unsigned char> data(size);
    if (!GetTokenInformation(token, TokenUser, data.data(), size, &size)
      || !ConvertSidToStringSidA(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid, &sid)) throw std::runtime_error("Cannot inspect current file owner");
    std::string result(sid);
    LocalFree(sid); sid = nullptr; CloseHandle(token); token = nullptr;
    return result;
  } catch (...) {
    if (sid) LocalFree(sid); if (token) CloseHandle(token);
    throw;
  }
}

static std::wstring PrivateFilePath(const std::string& path) {
  if (path.empty() || path.find('\0') != std::string::npos) throw std::runtime_error("Invalid private file path");
  int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.c_str(), -1, nullptr, 0);
  std::vector<wchar_t> wide(count);
  if (!count || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.c_str(), -1, wide.data(), count)) throw std::runtime_error("Invalid private file path");
  return std::wstring(wide.data());
}
static napi_value WritePrivateFile(napi_env env, napi_callback_info info) {
  HANDLE file = INVALID_HANDLE_VALUE; PSECURITY_DESCRIPTOR descriptor = nullptr;
  std::wstring path; bool created = false;
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) throw std::runtime_error("Expected private file path and text");
    path = PrivateFilePath(Text(env, args[0])); auto text = Text(env, args[1]);
    if (text.size() > 65536) throw std::runtime_error("Private file is too large");
    auto owner = PrivateFileCurrentOwner();
    auto acl = "O:" + owner + "D:P(A;;GA;;;" + owner + ")";
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorA(acl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) throw std::runtime_error("Cannot create private file ACL");
    SECURITY_ATTRIBUTES attributes{ sizeof(attributes), descriptor, FALSE };
    file = CreateFileW(path.c_str(), GENERIC_WRITE | DELETE, 0, &attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    LocalFree(descriptor); descriptor = nullptr;
    if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot create private file; existing files are never overwritten");
    created = true; DWORD written;
    if (!WriteFile(file, text.data(), static_cast<DWORD>(text.size()), &written, nullptr) || written != text.size() || !FlushFileBuffers(file)) throw std::runtime_error("Cannot write private file");
    CloseHandle(file); file = INVALID_HANDLE_VALUE;
    napi_value value; napi_get_undefined(env, &value); return value;
  } catch (const std::exception& error) {
    if (descriptor) LocalFree(descriptor);
    if (file != INVALID_HANDLE_VALUE) {
      if (created) { FILE_DISPOSITION_INFO remove{ TRUE }; SetFileInformationByHandle(file, FileDispositionInfo, &remove, sizeof(remove)); }
      CloseHandle(file);
    }
    napi_throw_error(env, "CRABOT_PRIVATE_FILE", error.what()); return nullptr;
  }
}
// Existing application roots keep their ACLs. SYSTEM/Administrators already
// control the OS; ordinary other principals may read but may not mutate data.
static bool ExistingDataAcl(PACL acl, PSID owner) {
  if (!acl || !IsValidAcl(acl)) return false;
  const DWORD writes = GENERIC_ALL | GENERIC_WRITE | WRITE_DAC | WRITE_OWNER | DELETE
    | FILE_DELETE_CHILD | FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES;
  for (DWORD index = 0; index < acl->AceCount; index++) {
    void* raw = nullptr;
    if (!GetAce(acl, index, &raw)) return false;
    const auto header = static_cast<ACE_HEADER*>(raw);
    if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) return false;
    const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
    const auto sid = reinterpret_cast<PSID>(&ace->SidStart);
    if (!IsValidSid(sid)) return false;
    if (!EqualSid(sid, owner) && !IsWellKnownSid(sid, WinLocalSystemSid)
      && !IsWellKnownSid(sid, WinBuiltinAdministratorsSid) && (ace->Mask & writes)) return false;
  }
  return true;
}
static bool ExistingDataAccess(PSECURITY_DESCRIPTOR descriptor, PACL acl, PSID owner) {
  if (!ExistingDataAcl(acl, owner)) return false;
  HANDLE primary = nullptr, token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &primary)) return false;
  const BOOL duplicated = DuplicateToken(primary, SecurityImpersonation, &token);
  CloseHandle(primary);
  if (!duplicated) return false;
  GENERIC_MAPPING mapping{ FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS };
  PRIVILEGE_SET privileges{}; DWORD size = sizeof(privileges), granted = 0; BOOL allowed = FALSE;
  const BOOL checked = AccessCheck(descriptor, token, FILE_ALL_ACCESS, &mapping, &privileges, &size, &granted, &allowed);
  CloseHandle(token);
  return checked && allowed && (granted & FILE_ALL_ACCESS) == FILE_ALL_ACCESS;
}
static napi_value IsPrivatePath(napi_env env, napi_callback_info info, bool directory, bool requirePrivate = true, bool requireProtected = true, bool existingData = false) {
  HANDLE file = INVALID_HANDLE_VALUE; PSECURITY_DESCRIPTOR descriptor = nullptr; PSID current = nullptr;
  try {
    size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected private file path");
    auto path = PrivateFilePath(Text(env, args[0]));
    file = CreateFileW(path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr);
    if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot inspect private file");
    BY_HANDLE_FILE_INFORMATION fileInfo{};
    PSID owner = nullptr; PACL acl = nullptr;
    if (!GetFileInformationByHandle(file, &fileInfo) || (fileInfo.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
      || !!(fileInfo.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory
      || GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &acl, nullptr, &descriptor) != ERROR_SUCCESS) throw std::runtime_error("Cannot inspect private file ACL");
    auto sid = PrivateFileCurrentOwner();
    if (!ConvertStringSidToSidA(sid.c_str(), &current)) throw std::runtime_error("Cannot inspect current user SID");
    SECURITY_DESCRIPTOR_CONTROL control; DWORD revision; void* raw = nullptr;
    bool valid = owner && EqualSid(owner, current);
    if (valid && existingData) valid = ExistingDataAccess(descriptor, acl, current);
    if (valid && requirePrivate) valid = acl && GetSecurityDescriptorControl(descriptor, &control, &revision)
      && (!requireProtected || (control & SE_DACL_PROTECTED)) && acl->AceCount == 1 && GetAce(acl, 0, &raw);
    if (valid && requirePrivate) {
      auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
      valid = ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && EqualSid(&ace->SidStart, current)
        && ((ace->Mask & FILE_ALL_ACCESS) == FILE_ALL_ACCESS || (ace->Mask & GENERIC_ALL));
      if (directory) valid = valid && (ace->Header.AceFlags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) == (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE);
    }
    LocalFree(current); LocalFree(descriptor); CloseHandle(file);
    napi_value value; napi_get_boolean(env, valid, &value); return value;
  } catch (const std::exception& error) {
    if (current) LocalFree(current); if (descriptor) LocalFree(descriptor); if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    napi_throw_error(env, "CRABOT_PRIVATE_FILE", error.what()); return nullptr;
  }
}
static napi_value IsPrivateFile(napi_env env, napi_callback_info info) { return IsPrivatePath(env, info, false); }
static napi_value IsPrivateDirectory(napi_env env, napi_callback_info info) { return IsPrivatePath(env, info, true); }
static napi_value IsOwnerOnlyFile(napi_env env, napi_callback_info info) { return IsPrivatePath(env, info, false, true, false); }
static napi_value IsOwnerOnlyDirectory(napi_env env, napi_callback_info info) { return IsPrivatePath(env, info, true, true, false); }
static napi_value IsOwnedDirectory(napi_env env, napi_callback_info info) { return IsPrivatePath(env, info, true, false); }
static napi_value IsOwnedFile(napi_env env, napi_callback_info info) { return IsPrivatePath(env, info, false, false); }
static napi_value IsExistingDataDirectory(napi_env env, napi_callback_info info) { return IsPrivatePath(env, info, true, false, false, true); }
static napi_value CreatePrivateDirectory(napi_env env, napi_callback_info info) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  try {
    size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected private directory path");
    auto path = PrivateFilePath(Text(env, args[0]));
    auto owner = PrivateFileCurrentOwner();
    auto acl = "O:" + owner + "D:P(A;OICI;GA;;;" + owner + ")";
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorA(acl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) throw std::runtime_error("Cannot create private directory ACL");
    SECURITY_ATTRIBUTES attributes{ sizeof(attributes), descriptor, FALSE };
    bool created = CreateDirectoryW(path.c_str(), &attributes);
    LocalFree(descriptor); descriptor = nullptr;
    if (!created) throw std::runtime_error("Cannot create private directory; existing directories are never changed");
    napi_value result; napi_get_undefined(env, &result); return result;
  } catch (const std::exception& error) {
    if (descriptor) LocalFree(descriptor);
    napi_throw_error(env, "CRABOT_PRIVATE_DIRECTORY", error.what()); return nullptr;
  }
}
static void RegisterPrivateFile(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"writePrivateFile", nullptr, WritePrivateFile, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"isPrivateFile", nullptr, IsPrivateFile, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createPrivateDirectory", nullptr, CreatePrivateDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"isPrivateDirectory", nullptr, IsPrivateDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"isOwnerOnlyFile", nullptr, IsOwnerOnlyFile, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"isOwnerOnlyDirectory", nullptr, IsOwnerOnlyDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"isOwnedDirectory", nullptr, IsOwnedDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"isExistingDataDirectory", nullptr, IsExistingDataDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"isOwnedFile", nullptr, IsOwnedFile, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
}
#endif
