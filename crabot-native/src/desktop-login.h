#ifdef _WIN32
// Only this current user's named Crabot Run command. StartupApproved is never
// opened or rewritten, so a concurrent OS disablement remains authoritative.
struct DesktopLoginKey {
  HKEY value = nullptr;
  ~DesktopLoginKey() { if (value) RegCloseKey(value); }
};
static std::wstring DesktopLoginPath(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length < 4 || length > 32760) throw std::runtime_error("Invalid desktop login path");
  std::vector<char16_t> text(length + 1);
  if (napi_get_value_string_utf16(env, value, text.data(), text.size(), &length) != napi_ok) throw std::runtime_error("Invalid desktop login path");
  std::wstring result(reinterpret_cast<wchar_t*>(text.data()), length);
  if (result.find_first_of(L"\0\r\n\"", 0, 4) != std::wstring::npos
    || !((result.size() >= 3 && result[1] == L':' && result[2] == L'\\') || result.rfind(L"\\\\", 0) == 0)
    || result.back() == L'\\') throw std::runtime_error("Invalid desktop login path");
  return result;
}
static std::wstring ReadDesktopLoginCommand(HKEY key) {
  DWORD type = 0, bytes = 0;
  if (RegQueryValueExW(key, L"Crabot", nullptr, &type, nullptr, &bytes) != ERROR_SUCCESS
    || type != REG_SZ || bytes < sizeof(wchar_t) || bytes > 65536 || bytes % sizeof(wchar_t)) throw std::runtime_error("Cannot verify desktop login command");
  std::vector<wchar_t> text(bytes / sizeof(wchar_t), 0);
  DWORD actual = bytes;
  if (RegQueryValueExW(key, L"Crabot", nullptr, &type, reinterpret_cast<BYTE*>(text.data()), &actual) != ERROR_SUCCESS
    || type != REG_SZ || actual != bytes || text.back() != L'\0') throw std::runtime_error("Desktop login command changed");
  std::wstring result(text.data(), text.size() - 1);
  if (result.find(L'\0') != std::wstring::npos) throw std::runtime_error("Invalid desktop login command");
  return result;
}
// Read-only command inspection; unlike Electron's LaunchItem.args, Win32
// parsing retains switches. Only the fixed current-user Crabot value is read.
static napi_value InspectDesktopLogin(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected one desktop program");
    auto expected = DesktopLoginPath(env, args[0]);
    DesktopLoginKey key;
    LONG opened = RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0, KEY_QUERY_VALUE, &key.value);
    const char* status = "absent";
    if (opened != ERROR_FILE_NOT_FOUND && opened != ERROR_SUCCESS) throw std::runtime_error("Cannot inspect desktop login command");
    if (opened == ERROR_SUCCESS) {
      DWORD type = 0, bytes = 0;
      LONG queried = RegQueryValueExW(key.value, L"Crabot", nullptr, &type, nullptr, &bytes);
      if (queried != ERROR_FILE_NOT_FOUND) {
        if (queried != ERROR_SUCCESS) throw std::runtime_error("Cannot inspect desktop login command");
        auto command = ReadDesktopLoginCommand(key.value);
        int count = 0; LPWSTR* parts = CommandLineToArgvW(command.c_str(), &count);
        if (!parts || count < 1) { if (parts) LocalFree(parts); throw std::runtime_error("Invalid desktop login command"); }
        status = _wcsicmp(parts[0], expected.c_str()) != 0 ? "different"
          : count == 2 && std::wstring(parts[1]) == L"--background" ? "background" : "custom";
        LocalFree(parts);
        if (ReadDesktopLoginCommand(key.value) != command) throw std::runtime_error("Desktop login command changed");
      }
    }
    napi_value result; napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_LOGIN_STARTUP_UPDATE", error.what()); return nullptr; }
}
static napi_value RetargetDesktopLogin(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) throw std::runtime_error("Expected source and target desktop programs");
    auto source = DesktopLoginPath(env, args[0]), target = DesktopLoginPath(env, args[1]);
    DWORD attributes = GetFileAttributesW(target.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) throw std::runtime_error("Target desktop program cannot be verified");
    DesktopLoginKey key;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0,
      KEY_QUERY_VALUE | KEY_SET_VALUE, &key.value) != ERROR_SUCCESS) throw std::runtime_error("Cannot open desktop login command");
    auto current = ReadDesktopLoginCommand(key.value);
    int count = 0; LPWSTR* parts = CommandLineToArgvW(current.c_str(), &count);
    bool fromSource = false, atTarget = false;
    if (parts && count == 2 && std::wstring(parts[1]) == L"--background") {
      fromSource = _wcsicmp(parts[0], source.c_str()) == 0;
      atTarget = _wcsicmp(parts[0], target.c_str()) == 0;
    }
    if (parts) LocalFree(parts);
    if (!fromSource && !atTarget) throw std::runtime_error("Unrecognized desktop login command retained");
    if (!atTarget) {
      auto replacement = L"\"" + target + L"\" --background";
      if (ReadDesktopLoginCommand(key.value) != current) throw std::runtime_error("Desktop login command changed");
      if (RegSetValueExW(key.value, L"Crabot", 0, REG_SZ, reinterpret_cast<const BYTE*>(replacement.c_str()),
        static_cast<DWORD>((replacement.size() + 1) * sizeof(wchar_t))) != ERROR_SUCCESS
        || RegFlushKey(key.value) != ERROR_SUCCESS || ReadDesktopLoginCommand(key.value) != replacement) throw std::runtime_error("Desktop login retarget remains unconfirmed");
    }
    napi_value result; napi_get_boolean(env, true, &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_LOGIN_STARTUP_UPDATE", error.what()); return nullptr; }
}
// Uninstall only this original command; never touch StartupApproved or the
// shared Run key itself. Missing state is idempotent, unfamiliar state retained.
static napi_value RemoveDesktopLogin(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) throw std::runtime_error("Expected original desktop program");
    auto expected = DesktopLoginPath(env, args[0]);
    DesktopLoginKey key;
    LONG opened = RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0,
      KEY_QUERY_VALUE | KEY_SET_VALUE, &key.value);
    if (opened != ERROR_FILE_NOT_FOUND && opened != ERROR_SUCCESS) throw std::runtime_error("Cannot open desktop login command");
    if (opened == ERROR_SUCCESS) {
      DWORD type = 0, bytes = 0;
      LONG queried = RegQueryValueExW(key.value, L"Crabot", nullptr, &type, nullptr, &bytes);
      if (queried != ERROR_FILE_NOT_FOUND) {
        if (queried != ERROR_SUCCESS) throw std::runtime_error("Cannot inspect desktop login command");
        auto current = ReadDesktopLoginCommand(key.value);
        int count = 0; LPWSTR* parts = CommandLineToArgvW(current.c_str(), &count);
        bool recognized = parts && count == 2 && _wcsicmp(parts[0], expected.c_str()) == 0 && std::wstring(parts[1]) == L"--background";
        if (parts) LocalFree(parts);
        if (!recognized) throw std::runtime_error("Unrecognized desktop login command retained");
        if (ReadDesktopLoginCommand(key.value) != current) throw std::runtime_error("Desktop login command changed");
        if (RegDeleteValueW(key.value, L"Crabot") != ERROR_SUCCESS || RegFlushKey(key.value) != ERROR_SUCCESS
          || RegQueryValueExW(key.value, L"Crabot", nullptr, &type, nullptr, &bytes) != ERROR_FILE_NOT_FOUND) {
          throw std::runtime_error("Desktop login removal remains unconfirmed");
        }
      }
    }
    napi_value result; napi_get_boolean(env, true, &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_INSTALL_REGISTRATION", error.what()); return nullptr; }
}
#endif
