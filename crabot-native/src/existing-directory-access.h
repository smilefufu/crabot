#pragma once
#include <windows.h>

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
