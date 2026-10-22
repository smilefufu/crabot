#ifdef _WIN32
#include <memory>
// Read-only security observations. No ACL is written, and this is not migration authority.
struct WorkspaceSecurityDescriptor {
  PSECURITY_DESCRIPTOR value = nullptr;
  explicit WorkspaceSecurityDescriptor(HANDLE file) {
    if (GetSecurityInfo(file, SE_FILE_OBJECT, WorkspaceMetadataSecurityFields, nullptr, nullptr, nullptr, nullptr, &value) != ERROR_SUCCESS)
      throw std::runtime_error("Cannot inspect workspace owner ACL");
  }
  ~WorkspaceSecurityDescriptor() { if (value) LocalFree(value); }
  WorkspaceSecurityDescriptor(const WorkspaceSecurityDescriptor&) = delete;
  WorkspaceSecurityDescriptor& operator=(const WorkspaceSecurityDescriptor&) = delete;
};
static ACCESS_ALLOWED_ACE* WorkspaceOwnerAce(PSECURITY_DESCRIPTOR descriptor, bool directory) {
  PSID owner = nullptr; BOOL defaulted = FALSE, present = FALSE; PACL acl = nullptr; void* raw = nullptr;
  if (!GetSecurityDescriptorOwner(descriptor, &owner, &defaulted) || !owner || MetadataSid(owner) != PrivateFileCurrentOwner()
    || !GetSecurityDescriptorDacl(descriptor, &present, &acl, &defaulted) || !present || !acl || acl->AceCount != 1
    || !GetAce(acl, 0, &raw)) return nullptr;
  auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
  const BYTE flags = ace->Header.AceFlags;
  if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || !IsValidSid(&ace->SidStart) || !EqualSid(owner, &ace->SidStart)
    || (ace->Mask != FILE_ALL_ACCESS && ace->Mask != GENERIC_ALL)) return nullptr;
  if (directory ? ((flags & ~INHERITED_ACE) != (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) : (flags != 0 && flags != INHERITED_ACE)) return nullptr;
  return ace;
}
static bool WorkspaceOwnerAccess(HANDLE file, bool directory) {
  WorkspaceSecurityDescriptor descriptor(file);
  return WorkspaceOwnerAce(descriptor.value, directory) != nullptr;
}
static std::string WorkspaceSecurityText(PSECURITY_DESCRIPTOR descriptor) {
  LPSTR text = nullptr;
  if (!ConvertSecurityDescriptorToStringSecurityDescriptorA(descriptor, SDDL_REVISION_1,
    OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | SACL_SECURITY_INFORMATION, &text, nullptr))
    throw std::runtime_error("Cannot serialize workspace security comparison");
  std::string result(text); LocalFree(text); return result;
}
static bool WorkspaceOwnerInheritanceDifference(HANDLE source, HANDLE target) {
  for (HANDLE file : { source, target }) {
    FILE_ATTRIBUTE_TAG_INFO attributes{}; FILE_STANDARD_INFO standard{};
    if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes))
      || (attributes.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))
      || !GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard))
      || standard.Directory || standard.DeletePending || standard.NumberOfLinks != 1) return false;
  }
  WorkspaceSecurityDescriptor a(source), b(target);
  auto left = WorkspaceOwnerAce(a.value, false), right = WorkspaceOwnerAce(b.value, false);
  SECURITY_DESCRIPTOR_CONTROL ac = 0, bc = 0; DWORD ar = 0, br = 0;
  if (!left || !right || left->Header.AceFlags != 0 || right->Header.AceFlags != INHERITED_ACE
    || !GetSecurityDescriptorControl(a.value, &ac, &ar) || !GetSecurityDescriptorControl(b.value, &bc, &br)
    || ac != bc || ar != br) return false;
  // Only alter this private in-memory observation. Never write the descriptor back to either file.
  right->Header.AceFlags = 0;
  return WorkspaceSecurityText(a.value) == WorkspaceSecurityText(b.value);
}
static HANDLE OpenWorkspaceSecurityObservation(napi_env env, napi_value value) {
  const auto path = Text(env, value);
  if (!MoveAbsolutePath(path)) throw std::runtime_error("Expected an absolute workspace path");
  HANDLE file = CreateFileW(MoveWidePath(path).c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot open workspace security observation");
  return file;
}
static napi_value InspectWorkspaceOwnerAccess(napi_env env, napi_callback_info info) {
  HANDLE file = INVALID_HANDLE_VALUE;
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected one workspace path");
    file = OpenWorkspaceSecurityObservation(env, args[0]);
    FILE_ATTRIBUTE_TAG_INFO attributes{}; FILE_STANDARD_INFO standard{};
    if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes))
      || !GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard))) throw std::runtime_error("Cannot identify workspace object");
    const bool directory = (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    const bool valid = !(attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && !standard.DeletePending
      && (directory || standard.NumberOfLinks == 1) && WorkspaceOwnerAccess(file, directory);
    CloseHandle(file); file = INVALID_HANDLE_VALUE;
    napi_value result; napi_get_boolean(env, valid, &result); return result;
  } catch (const std::exception& error) {
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    napi_throw_error(env, "CRABOT_FILE_METADATA", error.what()); return nullptr;
  }
}
static napi_value CompareWorkspaceOwnerInheritance(napi_env env, napi_callback_info info) {
  HANDLE source = INVALID_HANDLE_VALUE, target = INVALID_HANDLE_VALUE;
  try {
    size_t argc = 3; napi_value args[3]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) throw std::runtime_error("Expected original and copied workspace files");
    source = OpenWorkspaceSecurityObservation(env, args[0]); target = OpenWorkspaceSecurityObservation(env, args[1]);
    const bool valid = WorkspaceOwnerInheritanceDifference(source, target);
    CloseHandle(source); source = INVALID_HANDLE_VALUE; CloseHandle(target); target = INVALID_HANDLE_VALUE;
    napi_value result; napi_get_boolean(env, valid, &result); return result;
  } catch (const std::exception& error) {
    if (source != INVALID_HANDLE_VALUE) CloseHandle(source); if (target != INVALID_HANDLE_VALUE) CloseHandle(target);
    napi_throw_error(env, "CRABOT_FILE_METADATA", error.what()); return nullptr;
  }
}
#endif
