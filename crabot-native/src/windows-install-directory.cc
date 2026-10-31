// Installer-only mkdir: establish the same new private root as the existing
// desktop preparer. Existing nonempty installations and their ACLs stay intact.
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <filesystem>
#include <string>
#include <vector>

int wmain(int argc, wchar_t** argv) {
  HANDLE token = nullptr;
  LPWSTR sid = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr, existing = nullptr;
  int result = 1;
  try {
    if (argc != 2) throw 1;
    std::vector<wchar_t> full(32768);
    DWORD length = GetFullPathNameW(argv[1], static_cast<DWORD>(full.size()), full.data(), nullptr);
    if (!length || length >= full.size()) throw 1;
    std::wstring root(full.data());
    while (root.size() > 3 && root.back() == L'\\') root.pop_back();
    if (root.size() <= 3 || root[1] != L':' || root[2] != L'\\') throw 1;
    root = L"\\\\?\\" + root;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) throw 1;
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    if (!size || size > 65536) throw 1;
    std::vector<unsigned char> user(size);
    if (!GetTokenInformation(token, TokenUser, user.data(), size, &size)) throw 1;
    PSID owner = reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;
    if (!ConvertSidToStringSidW(owner, &sid)) throw 1;
    DWORD attributes = GetFileAttributesW(root.c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES) {
      if (!(attributes & FILE_ATTRIBUTE_DIRECTORY) || attributes & FILE_ATTRIBUTE_REPARSE_POINT) throw 1;
      PSID before = nullptr;
      if (GetNamedSecurityInfoW(root.data(), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
        &before, nullptr, nullptr, nullptr, &existing) != ERROR_SUCCESS || !EqualSid(owner, before)) throw 1;
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
      else if (!RemoveDirectoryW(root.c_str())) throw 1;
    } else if (GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND) throw 1;
    if (result != 0) {
      std::filesystem::create_directories(std::filesystem::path(root).parent_path());
      std::wstring acl = L"O:" + std::wstring(sid) + L"D:P(A;OICI;GA;;;" + sid + L")";
      if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(acl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) throw 1;
      SECURITY_ATTRIBUTES access{sizeof(access), descriptor, FALSE};
      if (!CreateDirectoryW(root.c_str(), &access)) throw 1;
      result = 0;
    }
  } catch (...) { result = 1; }
  if (existing) LocalFree(existing);
  if (descriptor) LocalFree(descriptor);
  if (sid) LocalFree(sid);
  if (token) CloseHandle(token);
  return result;
}
