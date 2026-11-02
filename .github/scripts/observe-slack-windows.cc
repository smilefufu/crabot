// Diagnostic only: observe window creation/show for unchanged desktop18 tools.
#include <windows.h>
#include <tlhelp32.h>
#include <fstream>
#include <string>
#include <vector>
#include <set>

static std::wofstream output;
static std::wstring root;
static std::wofstream processes;
static std::set<DWORD> seen;
static std::wstring Read(const wchar_t* file) {
  std::wifstream input(root + L"\\" + file);
  std::wstring line; std::getline(input, line); return line;
}
static DWORD Parent(DWORD pid) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry); DWORD parent = 0;
  if (Process32FirstW(snapshot, &entry)) do {
    if (entry.th32ProcessID == pid) { parent = entry.th32ParentProcessID; break; }
  } while (Process32NextW(snapshot, &entry));
  CloseHandle(snapshot); return parent;
}
static std::wstring Image(DWORD pid) {
  wchar_t image[32768]{}; DWORD size = 32768;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process) { QueryFullProcessImageNameW(process, 0, image, &size); CloseHandle(process); }
  return image;
}
static void ObserveProcesses() {
  HANDLE snapshot=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0);
  if(snapshot==INVALID_HANDLE_VALUE)return;
  PROCESSENTRY32W entry{};entry.dwSize=sizeof(entry);
  if(Process32FirstW(snapshot,&entry))do{
    bool selected=false;
    for(const wchar_t* name:{L"node.exe",L"powershell.exe",L"slack.exe",L"crabot-hidden-console.exe",L"WindowsTerminal.exe",L"OpenConsole.exe",L"conhost.exe"}) if(!_wcsicmp(entry.szExeFile,name))selected=true;
    if(selected&&seen.insert(entry.th32ProcessID).second)processes<<Read(L"phase")<<L'\t'<<GetTickCount64()<<L'\t'<<entry.th32ProcessID<<L'\t'<<entry.th32ParentProcessID<<L'\t'<<entry.szExeFile<<std::endl;
  }while(Process32NextW(snapshot,&entry));
  CloseHandle(snapshot);
}
static void CALLBACK Event(HWINEVENTHOOK, DWORD event, HWND window, LONG object, LONG child, DWORD, DWORD time) {
  if (!window || object != OBJID_WINDOW || child != CHILDID_SELF || GetAncestor(window, GA_ROOT) != window) return;
  DWORD pid = 0; GetWindowThreadProcessId(window, &pid);
  wchar_t klass[256]{}; GetClassNameW(window, klass, 256);
  DWORD parent = Parent(pid);
  output << Read(L"phase") << L'\t' << time << L'\t' << event << L'\t' << pid << L'\t' << parent
    << L'\t' << reinterpret_cast<UINT_PTR>(window) << L'\t' << IsWindowVisible(window) << L'\t' << klass << L'\t' << Image(pid) << L'\t' << Image(parent) << std::endl;
}
int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wstring(argv[1]) == L"--visible-control") {
    wchar_t command[] = L"cmd.exe /d /c ping -n 3 127.0.0.1";
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION process{};
    if (!CreateProcessW(nullptr, command, nullptr, nullptr, FALSE, CREATE_NEW_CONSOLE, nullptr, nullptr, &startup, &process)) return 4;
    WaitForSingleObject(process.hProcess, 10000); CloseHandle(process.hThread); CloseHandle(process.hProcess); return 0;
  }
  if (argc != 2) return 2;
  root = argv[1]; output.open(root + L"\\window-events.tsv");processes.open(root+L"\\process-starts.tsv");
  HWINEVENTHOOK hook = SetWinEventHook(EVENT_OBJECT_CREATE, EVENT_OBJECT_HIDE, nullptr, Event, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
  if (!hook) return 3;
  std::ofstream(root + L"\\observer-ready").put('1');
  SetTimer(nullptr, 1, 20, nullptr);
  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    if(message.message==WM_TIMER)ObserveProcesses();
    if (GetFileAttributesW((root + L"\\observer-stop").c_str()) != INVALID_FILE_ATTRIBUTES) break;
    TranslateMessage(&message); DispatchMessageW(&message);
  }
  UnhookWinEvent(hook); return 0;
}
