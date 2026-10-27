// Ephemeral maintenance-copy cleanup only. No installation/data path, command,
// persisted executable locator or service authority is accepted from arguments.
#include <filesystem>
#include <iostream>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <tlhelp32.h>
#else
#include <unistd.h>
#include <sys/stat.h>
#ifdef __APPLE__
#include <libproc.h>
#include <mach-o/dyld.h>
#include <sys/event.h>
#else
#include <poll.h>
#include <sys/syscall.h>
#endif
#endif
namespace fs = std::filesystem;
static void Require(bool value) { if (!value) throw std::runtime_error("Private copy cleanup remains unverified"); }
#ifdef _WIN32
struct Handle { HANDLE value = INVALID_HANDLE_VALUE; ~Handle() { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); } };
static std::string Sid(PSID value) {
  LPSTR text = nullptr; Require(ConvertSidToStringSidA(value, &text)); std::string result(text); LocalFree(text); return result;
}
static std::string Owner(HANDLE process) {
  Handle token; Require(OpenProcessToken(process, TOKEN_QUERY, &token.value)); DWORD size = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &size); Require(size && size <= 65536);
  std::vector<unsigned char> data(size); Require(GetTokenInformation(token.value, TokenUser, data.data(), size, &size));
  return Sid(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid);
}
static fs::path Image(HANDLE process) {
  std::vector<wchar_t> text(32768); DWORD count = static_cast<DWORD>(text.size());
  Require(QueryFullProcessImageNameW(process, 0, text.data(), &count)); return fs::canonical(std::wstring(text.data(), count));
}
static std::string Identity(const fs::path& file, bool directory, bool privateRoot = false) {
  Handle handle; handle.value = CreateFileW(file.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  Require(handle.value != INVALID_HANDLE_VALUE);
  FILE_ID_INFO id{}; FILE_BASIC_INFO basic{}; FILE_STANDARD_INFO standard{};
  Require(GetFileInformationByHandleEx(handle.value, FileIdInfo, &id, sizeof(id))
    && GetFileInformationByHandleEx(handle.value, FileBasicInfo, &basic, sizeof(basic))
    && GetFileInformationByHandleEx(handle.value, FileStandardInfo, &standard, sizeof(standard)));
  PSID owner = nullptr; PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  Require(GetSecurityInfo(handle.value, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | (privateRoot ? DACL_SECURITY_INFORMATION : 0),
    &owner, nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS);
  static const auto current = Owner(GetCurrentProcess()); // This fixed single-threaded role never changes its token.
  const auto actual = Sid(owner);
  bool allowed = actual == current;
  if (privateRoot) {
    void* raw = nullptr; SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0;
    allowed = allowed && acl && acl->AceCount == 1 && GetSecurityDescriptorControl(descriptor, &control, &revision)
      && (control & SE_DACL_PROTECTED) && GetAce(acl, 0, &raw);
    if (allowed) {
      auto ace = reinterpret_cast<ACCESS_ALLOWED_ACE*>(raw);
      allowed = ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && Sid(&ace->SidStart) == current
        && ((ace->Mask & FILE_ALL_ACCESS) == FILE_ALL_ACCESS || (ace->Mask & GENERIC_ALL));
    }
  }
  LocalFree(descriptor); Require(allowed);
  if (directory) Require((basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT));
  std::ostringstream out; out << id.VolumeSerialNumber << ':';
  for (auto byte : id.FileId.Identifier) out << static_cast<unsigned int>(byte) << '.';
  out << ':' << basic.FileAttributes << ':' << actual;
  if (!directory) out << ':' << standard.NumberOfLinks << ':' << standard.EndOfFile.QuadPart << ':' << basic.LastWriteTime.QuadPart << ':' << basic.ChangeTime.QuadPart;
  return out.str();
}
struct Parent {
  Handle process;
  explicit Parent(const fs::path& root) {
    Handle snapshot; snapshot.value = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0); Require(snapshot.value != INVALID_HANDLE_VALUE);
    PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry); DWORD pid = 0;
    for (BOOL found = Process32FirstW(snapshot.value, &entry); found; found = Process32NextW(snapshot.value, &entry))
      if (entry.th32ProcessID == GetCurrentProcessId()) { pid = entry.th32ParentProcessID; break; }
    Require(pid > 0); process.value = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid); Require(process.value != nullptr);
    FILETIME created{}, exited{}, kernel{}, user{}, selfCreated{};
    Require(GetProcessTimes(process.value, &created, &exited, &kernel, &user)
      && GetProcessTimes(GetCurrentProcess(), &selfCreated, &exited, &kernel, &user)
      && CompareFileTime(&created, &selfCreated) <= 0);
    Require(Owner(process.value) == Owner(GetCurrentProcess()) && fs::equivalent(Image(process.value), root / L"gui/Crabot.exe"));
    Require(WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT);
  }
  void Wait() { Require(WaitForSingleObject(process.value, INFINITE) == WAIT_OBJECT_0); }
};
#else
static fs::path Image() {
#ifdef __APPLE__
  uint32_t size = 0; _NSGetExecutablePath(nullptr, &size); std::vector<char> text(size);
  Require(!_NSGetExecutablePath(text.data(), &size)); return fs::canonical(text.data());
#else
  return fs::canonical("/proc/self/exe");
#endif
}
static std::string Identity(const fs::path& file, bool directory, bool privateRoot = false) {
  struct stat value{}; Require(!lstat(file.c_str(), &value) && value.st_uid == geteuid());
  if (directory) Require(S_ISDIR(value.st_mode));
  if (privateRoot) Require((value.st_mode & 0777) == 0700);
  std::ostringstream out; out << value.st_dev << ':' << value.st_ino << ':' << value.st_mode << ':' << value.st_uid << ':' << value.st_gid;
#ifdef __APPLE__
  const auto modified = value.st_mtimespec, changed = value.st_ctimespec;
#else
  const auto modified = value.st_mtim, changed = value.st_ctim;
#endif
  if (!directory) out << ':' << value.st_nlink << ':' << value.st_size << ':' << modified.tv_sec << ':' << modified.tv_nsec << ':' << changed.tv_sec << ':' << changed.tv_nsec;
  return out.str();
}
struct Parent {
  int descriptor = -1;
  explicit Parent(const fs::path& root) {
    const auto pid = getppid(); Require(pid > 1);
#ifdef __APPLE__
    descriptor = kqueue(); Require(descriptor >= 0);
    struct kevent event; EV_SET(&event, pid, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, nullptr);
    Require(!kevent(descriptor, &event, 1, nullptr, 0, nullptr));
    struct proc_bsdinfo info{}; char image[PROC_PIDPATHINFO_MAXSIZE];
    Require(proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) == sizeof(info) && info.pbi_uid == geteuid());
    Require(proc_pidpath(pid, image, sizeof(image)) > 0 && fs::canonical(image) == fs::canonical(root / "gui/Crabot.app/Contents/MacOS/Crabot"));
#else
    descriptor = static_cast<int>(syscall(SYS_pidfd_open, pid, 0)); Require(descriptor >= 0);
    struct stat parent{}; Require(!stat(("/proc/" + std::to_string(pid)).c_str(), &parent) && parent.st_uid == geteuid());
    Require(fs::canonical("/proc/" + std::to_string(pid) + "/exe") == fs::canonical(root / "node"));
#endif
    Require(getppid() == pid);
  }
  ~Parent() { if (descriptor >= 0) close(descriptor); }
  void Wait() {
#ifdef __APPLE__
    struct kevent event; Require(kevent(descriptor, nullptr, 0, &event, 1, nullptr) == 1 && !(event.flags & EV_ERROR) && (event.fflags & NOTE_EXIT));
#else
    struct pollfd event{descriptor, POLLIN, 0}; Require(poll(&event, 1, -1) == 1 && (event.revents & POLLIN));
#endif
  }
};
#endif
struct Entry { fs::path file; std::string identity; bool directory; };
static std::vector<Entry> Capture(const fs::path& root, const std::string& volume) {
  std::vector<Entry> result;
  if (!fs::exists(fs::symlink_status(root))) return result;
  const auto append = [&](const fs::path& file) {
    auto type = fs::symlink_status(file); Require(fs::is_directory(type) || fs::is_regular_file(type) || fs::is_symlink(type));
    const bool directory = fs::is_directory(type); const auto identity = Identity(file, directory);
    Require(identity.substr(0, identity.find(':')) == volume); result.push_back({file, identity, directory}); Require(result.size() <= 20000);
  };
  append(root);
  if (fs::is_directory(fs::symlink_status(root)))
    for (const auto& entry : fs::recursive_directory_iterator(root)) append(entry.path());
  return result;
}
static void Remove(const std::vector<Entry>& entries) {
  for (auto it = entries.rbegin(); it != entries.rend(); ++it) {
    if (!fs::exists(fs::symlink_status(it->file))) continue;
    Require(Identity(it->file, it->directory) == it->identity);
    Require(fs::remove(it->file));
  }
}
int main(int argc, char**) {
  try {
    Require(argc == 1);
#ifdef _WIN32
    const auto self = Image(GetCurrentProcess()); Require(self.filename() == L"cleanup.exe");
#else
    const auto self = Image(); Require(self.filename() == "cleanup");
#endif
    const auto root = self.parent_path();
    Require(std::regex_match(root.filename().u8string(), std::regex("crabot-removal-host-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}"))
      && fs::equivalent(fs::current_path(), root.parent_path()));
    const auto original = Identity(root, true, true), volume = original.substr(0, original.find(':')); Parent parent(root);
    std::vector<Entry> programs;
#ifdef __linux__
    for (const auto& entry : fs::directory_iterator(root)) if (entry.path() != self) {
      auto part = Capture(entry.path(), volume); programs.insert(programs.end(), part.begin(), part.end());
    }
#else
    programs = Capture(root / "gui", volume); Require(!programs.empty());
#endif
#ifdef _WIN32
    // Keep the fixed readiness bytes independent of CRT CR-LF translation.
    DWORD written = 0; Require(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), "READY\n", 6, &written, nullptr) && written == 6);
#else
    std::cout << "READY\n" << std::flush;
#endif
    parent.Wait(); Require(Identity(root, true, true) == original);
    Remove(programs);
#ifndef __linux__
    Remove(Capture(root / "profile", volume));
#endif
    Require(Identity(root, true, true) == original);
#ifdef _WIN32
    { Handle file; file.value = CreateFileW(self.c_str(), DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr); Require(file.value != INVALID_HANDLE_VALUE);
    FILE_DISPOSITION_INFO_EX disposition{FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS};
    // Unsupported/self-image deletion keeps only this small helper for OS temp
    // cleanup. It never executes again or blocks removal of the original app.
    Require(SetFileInformationByHandle(file.value, FileDispositionInfoEx, &disposition, sizeof(disposition))); }
#else
    Require(fs::remove(self));
#endif
    Require(fs::remove(root)); return 0;
  } catch (...) { std::cerr << "CRABOT_PRIVATE_COPY_RETAINED\n"; return 1; }
}
