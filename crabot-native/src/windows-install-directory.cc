// Installer-only mkdir: establish the same new private root as the existing
// desktop preparer. Existing nonempty installations and their ACLs stay intact.
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include "existing-directory-access.h"
#include <string>
#include <vector>
#include <cstdio>

int wmain(int argc, wchar_t** argv) {
  HANDLE token = nullptr;
  LPWSTR sid = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr, existing = nullptr;
  int result = 1;
  const char* stage = "arguments";
  try {
    if (argc != 2) throw 1;
    stage = "resolve-path";
    std::vector<wchar_t> full(32768);
    DWORD length = GetFullPathNameW(argv[1], static_cast<DWORD>(full.size()), full.data(), nullptr);
    if (!length || length >= full.size()) throw 1;
    std::wstring root(full.data());
    while (root.size() > 3 && root.back() == L'\\') root.pop_back();
    if (root.size() <= 3 || root[1] != L':' || root[2] != L'\\') throw 1;
    root = L"\\\\?\\" + root;
    stage = "current-user";
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) throw 1;
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    if (!size || size > 65536) throw 1;
    std::vector<unsigned char> user(size);
    if (!GetTokenInformation(token, TokenUser, user.data(), size, &size)) throw 1;
    PSID owner = reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;
    if (!ConvertSidToStringSidW(owner, &sid)) throw 1;
    stage = "inspect-directory";
    DWORD attributes = GetFileAttributesW(root.c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES) {
      if (!(attributes & FILE_ATTRIBUTE_DIRECTORY) || attributes & FILE_ATTRIBUTE_REPARSE_POINT) throw 1;
      stage = "existing-owner";
      PSID before = nullptr; PACL acl = nullptr;
      DWORD error = GetNamedSecurityInfoW(root.data(), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &before, nullptr, &acl, nullptr, &existing);
      if (error != ERROR_SUCCESS) { SetLastError(error); throw 1; }
      if (!before || (!EqualSid(owner, before) && !(IsWellKnownSid(before, WinBuiltinAdministratorsSid)
        && ExistingDataAccess(existing, acl, owner)))) { SetLastError(ERROR_ACCESS_DENIED); throw 1; }
      stage = "list-existing";
      WIN32_FIND_DATAW entry{};
      HANDLE search = FindFirstFileW((root + L"\\*").c_str(), &entry);
      if (search == INVALID_HANDLE_VALUE) throw 1;
      bool empty = true;
      do { if (std::wstring(entry.cFileName) != L"." && std::wstring(entry.cFileName) != L"..") { empty = false; break; } }
      while (FindNextFileW(search, &entry));
      const DWORD ended = empty ? GetLastError() : ERROR_SUCCESS;
      FindClose(search);
      if (empty && ended != ERROR_NO_MORE_FILES) throw 1;
      if (!empty) result = 0; // GUI verifies the existing selected installation.
      else { stage = "replace-empty"; if (!RemoveDirectoryW(root.c_str())) throw 1; }
    } else if (GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND) throw 1;
    if (result != 0) {
      stage = "create-parents";
      // Never attempt to create the existing drive root: Windows can return
      // ACCESS_DENIED for mkdir("D:\\") even when creating children is allowed.
      for (size_t end = root.find(L'\\', 7); end != std::wstring::npos; end = root.find(L'\\', end + 1)) {
        const std::wstring parent = root.substr(0, end);
        const DWORD before = GetFileAttributesW(parent.c_str());
        if (before != INVALID_FILE_ATTRIBUTES && (before & FILE_ATTRIBUTE_DIRECTORY)) continue;
        if (!CreateDirectoryW(parent.c_str(), nullptr)) {
          const DWORD error = GetLastError(), attributes = GetFileAttributesW(parent.c_str());
          if (error != ERROR_ALREADY_EXISTS || attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY)) {
            SetLastError(error); throw 1;
          }
        }
      }
      stage = "prepare-private-access";
      std::wstring acl = L"O:" + std::wstring(sid) + L"D:P(A;OICI;GA;;;" + sid + L")";
      if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(acl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) throw 1;
      SECURITY_ATTRIBUTES access{sizeof(access), descriptor, FALSE};
      stage = "create-directory";
      if (!CreateDirectoryW(root.c_str(), &access)) throw 1;
      result = 0;
    }
  } catch (...) {
    std::fprintf(stderr, "CRABOT_INSTALL_DIRECTORY stage=%s win32=%lu\n", stage, GetLastError());
    result = 1;
  }
  if (existing) LocalFree(existing);
  if (descriptor) LocalFree(descriptor);
  if (sid) LocalFree(sid);
  if (token) CloseHandle(token);
  return result;
}
