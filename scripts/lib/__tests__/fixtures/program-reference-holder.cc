// Finite private test actor only; never packaged as a product executable.
#include <cstdio>
#include <cstring>
#include <cwchar>
#ifdef _WIN32
#include <windows.h>
#ifdef CRABOT_REFERENCE_DLL
extern "C" __declspec(dllexport) int crabot_reference_fixture() { return 1; }
BOOL WINAPI DllMain(HINSTANCE, DWORD, LPVOID) { return TRUE; }
#else
int wmain(int argc, wchar_t** argv) {
  if (argc != 3 || wcscmp(argv[2], L"library")) return 2;
  HMODULE library = LoadLibraryW(argv[1]); if (!library) return 3;
  puts("ready"); fflush(stdout); getchar(); FreeLibrary(library); return 0;
}
#endif
#else
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#ifdef __APPLE__
#include <sys/fileport.h>
#include <mach/mach.h>
#endif
#ifdef __linux__
#include <sys/prctl.h>
#endif
int main(int argc, char** argv) {
  if (argc != 3) return 2;
  void* mapped = MAP_FAILED; int fd = -1;
#ifdef __APPLE__
  fileport_t port = MACH_PORT_NULL;
#endif
  if (!strcmp(argv[2], "mapped")) {
    fd = open(argv[1], O_RDONLY); if (fd < 0) return 3;
    mapped = mmap(nullptr, 4096, PROT_READ, MAP_PRIVATE, fd, 0); close(fd); fd = -1;
    if (mapped == MAP_FAILED) return 4;
  } else if (!strcmp(argv[2], "cwd")) { if (chdir(argv[1])) return 5; }
#ifdef __APPLE__
  else if (!strcmp(argv[2], "fileport")) {
    fd = open(argv[1], O_RDONLY); if (fd < 0) return 8;
    if (fileport_makeport(fd, &port)) { close(fd); return 9; }
    close(fd); fd = -1;
  }
#endif
#ifdef __linux__
  else if (!strcmp(argv[2], "protected")) {
    fd = open(argv[1], O_RDONLY); if (fd < 0 || prctl(PR_SET_DUMPABLE, 0)) return 6;
  }
#endif
  else return 7;
  puts("ready"); fflush(stdout); getchar();
  if (mapped != MAP_FAILED) munmap(mapped, 4096);
#ifdef __APPLE__
  if (port != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), port);
#endif
  if (fd >= 0) close(fd);
  return 0;
}
#endif
