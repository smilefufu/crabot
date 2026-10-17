// The management command locates a sealed payload without a host interpreter.
// A version selector lives outside payload inventories; Windows can change it
// while this launcher and the previous payload's node.exe are still open.
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
#include <stdexcept>
#include <cstdlib>
#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif
#endif
namespace fs = std::filesystem;

static fs::path Executable() {
#ifdef _WIN32
  std::vector<wchar_t> text(32768);
  DWORD count = GetModuleFileNameW(nullptr, text.data(), static_cast<DWORD>(text.size()));
  if (!count || count >= text.size()) throw std::runtime_error("Cannot locate Crabot command");
  return fs::canonical(fs::path(std::wstring(text.data(), count)));
#elif __APPLE__
  uint32_t size = 0; _NSGetExecutablePath(nullptr, &size);
  std::vector<char> text(size);
  if (_NSGetExecutablePath(text.data(), &size)) throw std::runtime_error("Cannot locate Crabot command");
  return fs::canonical(text.data());
#else
  return fs::canonical("/proc/self/exe");
#endif
}

static fs::path Payload() {
  auto root = Executable().parent_path().parent_path();
  auto selector = root / "current-core";
  if (fs::exists(selector)) {
    if (!fs::is_regular_file(fs::symlink_status(selector)) || fs::file_size(selector) > 66) throw std::runtime_error("Invalid Crabot version selector");
    std::ifstream input(selector); std::string id;
    std::getline(input, id);
    if (!id.empty() && id.back() == '\r') id.pop_back();
    if (id.size() != 64 || id.find_first_not_of("0123456789abcdef") != std::string::npos || input.peek() != EOF) throw std::runtime_error("Invalid Crabot version selector");
    root /= fs::path("releases") / id;
  }
  if (!fs::is_regular_file(root / "core-release.json") || !fs::is_regular_file(root / "cli.mjs")) throw std::runtime_error("Crabot payload is missing");
  return root;
}

#ifdef _WIN32
// Inverse of the Windows argv parser, including empty arguments and backslashes
// immediately before quotes/the closing quote. Never invoke cmd.exe or a shell.
static std::wstring Quote(const std::wstring& text) {
  std::wstring result = L"\""; size_t slashes = 0;
  for (auto character : text) {
    if (character == L'\\') { slashes++; continue; }
    if (character == L'"') result.append(slashes * 2 + 1, L'\\');
    else result.append(slashes, L'\\');
    slashes = 0; result += character;
  }
  result.append(slashes * 2, L'\\'); return result + L'"';
}
static BOOL WINAPI ConsoleSignal(DWORD signal) { return signal == CTRL_C_EVENT || signal == CTRL_BREAK_EVENT; }
int wmain(int argc, wchar_t** argv) {
  try {
    auto root = Payload(), node = root / L".product-runtime/node/node.exe";
    if (!SetEnvironmentVariableW(L"CRABOT_PRODUCT_REQUIRED", L"1")) throw std::runtime_error("Cannot select bundled runtime");
    if (!fs::is_regular_file(node)) throw std::runtime_error("Bundled Node is missing");
    std::wstring command = Quote(node.wstring()) + L" " + Quote((root / L"cli.mjs").wstring());
    for (int i = 1; i < argc; i++) command += L" " + Quote(argv[i]);
    STARTUPINFOW startup{}; startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE); startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE); startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION process{};
    if (GetConsoleCP() && !SetConsoleCtrlHandler(ConsoleSignal, TRUE)) throw std::runtime_error("Cannot preserve console signals");
    if (!CreateProcessW(node.c_str(), command.data(), nullptr, nullptr, TRUE, 0, nullptr, nullptr, &startup, &process)) throw std::runtime_error("Cannot start bundled Node");
    CloseHandle(process.hThread);
    DWORD code = 1; bool waited = WaitForSingleObject(process.hProcess, INFINITE) == WAIT_OBJECT_0;
    bool exited = waited && GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hProcess);
    if (!exited) throw std::runtime_error("Cannot observe Crabot command exit");
    return static_cast<int>(code);
  } catch (const std::exception& error) {
    std::cerr << "[crabot] " << error.what() << ". Repair the installation; user data is preserved.\n"; return 127;
  }
}
#else
int main(int argc, char** argv) {
  try {
    auto root = Payload();
    if (setenv("CRABOT_PRODUCT_REQUIRED", "1", 1)) throw std::runtime_error("Cannot select bundled runtime");
    std::string node = root / ".product-runtime/node/bin/node", entry = root / "cli.mjs";
    if (!fs::is_regular_file(node)) throw std::runtime_error("Bundled Node is missing");
    std::vector<char*> args{node.data(), entry.data()};
    for (int i = 1; i < argc; i++) args.push_back(argv[i]);
    args.push_back(nullptr);
    execv(node.c_str(), args.data());
    throw std::runtime_error("Cannot execute bundled Node");
  } catch (const std::exception& error) {
    std::cerr << "[crabot] " << error.what() << ". Repair the installation; user data is preserved.\n"; return 127;
  }
}
#endif
