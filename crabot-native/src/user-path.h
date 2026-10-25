#ifdef _WIN32
// Current-user CLI registration only. Never writes machine environment or runs
// reg.exe/PowerShell, and preserves the existing registry value and string type.
struct CliEnvironmentKey {
  HKEY value = nullptr;
  ~CliEnvironmentKey() { if (value) RegCloseKey(value); }
};
struct CliUserPath { bool present = false; DWORD type = REG_EXPAND_SZ; std::wstring value; };
static CliUserPath ReadCliUserPath(HKEY key) {
  CliUserPath result;
  if (!key) return result;
  DWORD bytes = 0;
  LSTATUS status = RegQueryValueExW(key, L"Path", nullptr, &result.type, nullptr, &bytes);
  if (status == ERROR_FILE_NOT_FOUND) return result;
  if (status != ERROR_SUCCESS || bytes > 65536 || bytes % sizeof(wchar_t)
    || (result.type != REG_SZ && result.type != REG_EXPAND_SZ)) throw std::runtime_error("Cannot verify current user PATH");
  std::vector<wchar_t> text(bytes / sizeof(wchar_t) + 1, 0);
  if (RegQueryValueExW(key, L"Path", nullptr, &result.type, reinterpret_cast<BYTE*>(text.data()), &bytes) != ERROR_SUCCESS) throw std::runtime_error("Cannot read current user PATH");
  if (bytes % sizeof(wchar_t) || (result.type != REG_SZ && result.type != REG_EXPAND_SZ)) throw std::runtime_error("Current user PATH changed while reading");
  result.present = true; result.value.assign(text.data());
  for (size_t i = result.value.size(); i < bytes / sizeof(wchar_t); i++) if (text[i]) throw std::runtime_error("Invalid current user PATH");
  return result;
}
static std::wstring CliWideArgument(napi_env env, napi_value value) {
  size_t length;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length > 32760) throw std::runtime_error("Invalid CLI path argument");
  std::vector<char16_t> text(length + 1);
  if (napi_get_value_string_utf16(env, value, text.data(), text.size(), &length) != napi_ok) throw std::runtime_error("Invalid CLI path argument");
  std::wstring result(reinterpret_cast<wchar_t*>(text.data()), length);
  if (result.find(L'\0') != std::wstring::npos) throw std::runtime_error("Invalid CLI path argument");
  return result;
}
static napi_value ReadUserPathCall(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 0; napi_get_cb_info(env, info, &argc, nullptr, nullptr, nullptr);
    CliEnvironmentKey key;
    auto status = RegOpenKeyExW(HKEY_CURRENT_USER, L"Environment", 0, KEY_QUERY_VALUE, &key.value);
    if (status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND) throw std::runtime_error("Cannot read current user environment");
    auto current = ReadCliUserPath(key.value);
    napi_value result;
    if (current.present) napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(current.value.data()), current.value.size(), &result);
    else napi_get_null(env, &result);
    return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_CLI_PATH", error.what()); return nullptr; }
}
static napi_value AppendUserPathCall(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) throw std::runtime_error("Expected CLI directory and prior user PATH");
    auto directory = CliWideArgument(env, args[0]);
    if (directory.empty() || directory.find_first_of(L";\r\n\"") != std::wstring::npos
      || !((directory.size() >= 3 && directory[1] == L':' && directory[2] == L'\\') || directory.rfind(L"\\\\", 0) == 0)) throw std::runtime_error("Unsupported CLI directory");
    DWORD attributes = GetFileAttributesW(directory.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) throw std::runtime_error("CLI directory cannot be verified");
    napi_value nullValue; napi_get_null(env, &nullValue); bool missing = false;
    napi_strict_equals(env, args[1], nullValue, &missing);
    auto expected = missing ? std::wstring() : CliWideArgument(env, args[1]);
    CliEnvironmentKey key;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, L"Environment", 0, nullptr, 0, KEY_QUERY_VALUE | KEY_SET_VALUE, nullptr, &key.value, nullptr) != ERROR_SUCCESS) throw std::runtime_error("Cannot update current user environment");
    auto current = ReadCliUserPath(key.value);
    if (current.present == missing || current.value != expected) throw std::runtime_error("Current user PATH changed; retry installation");
    bool present = false;
    std::wistringstream parts(current.value); std::wstring part;
    while (std::getline(parts, part, L';')) {
      if (part.size() >= 2 && part.front() == L'\"' && part.back() == L'\"') part = part.substr(1, part.size() - 2);
      DWORD needed = ExpandEnvironmentStringsW(part.c_str(), nullptr, 0);
      if (!needed || needed > 32768) continue;
      std::vector<wchar_t> expanded(needed);
      if (ExpandEnvironmentStringsW(part.c_str(), expanded.data(), needed) == needed && _wcsicmp(expanded.data(), directory.c_str()) == 0) present = true;
    }
    if (!present) {
      auto updated = current.value.empty() ? directory : current.value + L";" + directory;
      if (updated.size() > 32760 || RegSetValueExW(key.value, L"Path", 0, current.type,
        reinterpret_cast<const BYTE*>(updated.c_str()), static_cast<DWORD>((updated.size() + 1) * sizeof(wchar_t))) != ERROR_SUCCESS) throw std::runtime_error("Cannot register CLI in current user PATH");
    }
    if (RegFlushKey(key.value) != ERROR_SUCCESS) throw std::runtime_error("Current user PATH could not be persisted");
    napi_value result; napi_get_boolean(env, !present, &result);
    return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_CLI_PATH", error.what()); return nullptr; }
}
// Called in a bounded standalone helper, never on Electron's UI thread: a hung
// third-party window can delay the OS broadcast even after registry success.
static napi_value NotifyUserPathCall(napi_env env, napi_callback_info info) {
  DWORD_PTR reply = 0;
  bool notified = SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0,
    reinterpret_cast<LPARAM>(L"Environment"), SMTO_ABORTIFHUNG, 2000, &reply) != 0;
  napi_value result; napi_get_boolean(env, notified, &result); return result;
}
static void RegisterUserPath(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"readUserPath", nullptr, ReadUserPathCall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"appendUserPathDirectory", nullptr, AppendUserPathCall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"notifyUserPathChanged", nullptr, NotifyUserPathCall, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
}
#endif
