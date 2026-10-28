#ifdef _WIN32
// One current-user, per-installation Installed Apps entry. No HKLM, arbitrary
// registry path, silent deletion, service control or program execution.
struct DesktopUninstallValue { const wchar_t* name; std::wstring text; bool number = false; };
static std::wstring DesktopUninstallText(napi_env env, napi_value value, size_t maximum) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || !length || length > maximum) throw std::runtime_error("Invalid uninstall field");
  std::vector<char16_t> text(length + 1);
  if (napi_get_value_string_utf16(env, value, text.data(), text.size(), &length) != napi_ok) throw std::runtime_error("Invalid uninstall field");
  std::wstring result(reinterpret_cast<wchar_t*>(text.data()), length);
  if (result.find_first_of(L"\0\r\n", 0, 3) != std::wstring::npos) throw std::runtime_error("Invalid uninstall field");
  return result;
}
static bool DesktopUninstallId(const std::wstring& id) {
  if (id.size() != 36) return false;
  for (size_t i = 0; i < id.size(); i++) {
    bool dash = i == 8 || i == 13 || i == 18 || i == 23;
    if (dash ? id[i] != L'-' : !((id[i] >= L'0' && id[i] <= L'9') || (id[i] >= L'a' && id[i] <= L'f'))) return false;
  }
  return true;
}
static std::wstring DesktopUninstallKey(napi_env env, napi_value value) {
  auto id = DesktopUninstallText(env, value, 36);
  if (!DesktopUninstallId(id)) throw std::runtime_error("Invalid installation identity");
  return L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Crabot-" + id;
}
static std::vector<DesktopUninstallValue> DesktopUninstallValues(napi_env env, napi_value record) {
  napi_value names, executableValue, rootValue, versionValue; uint32_t count = 0;
  if (napi_get_property_names(env, record, &names) != napi_ok || napi_get_array_length(env, names, &count) != napi_ok || count != 3
    || napi_get_named_property(env, record, "executable", &executableValue) != napi_ok
    || napi_get_named_property(env, record, "installRoot", &rootValue) != napi_ok
    || napi_get_named_property(env, record, "version", &versionValue) != napi_ok) throw std::runtime_error("Invalid uninstall record");
  auto executable = DesktopLoginPath(env, executableValue), root = DesktopLoginPath(env, rootValue), version = DesktopUninstallText(env, versionValue, 128);
  const auto prefix = root + L"\\app\\releases\\";
  if (executable.size() <= prefix.size() + 11 || _wcsnicmp(executable.c_str(), prefix.c_str(), prefix.size()) != 0
    || executable.substr(executable.size() - 11) != L"\\Crabot.exe"
    || !DesktopUninstallId(executable.substr(prefix.size(), executable.size() - prefix.size() - 11))) throw std::runtime_error("Uninstall program outside installation");
  for (auto letter : version) if (!((letter >= L'0' && letter <= L'9') || (letter >= L'A' && letter <= L'Z') || (letter >= L'a' && letter <= L'z') || letter == L'.' || letter == L'-')) throw std::runtime_error("Invalid uninstall version");
  return {{L"DisplayName", L"Crabot"}, {L"DisplayVersion", version}, {L"Publisher", L"Crabot"}, {L"InstallLocation", root},
    {L"DisplayIcon", L"\"" + executable + L"\",0"}, {L"UninstallString", L"\"" + executable + L"\" --uninstall"},
    {L"NoModify", L"", true}, {L"NoRepair", L"", true}};
}
static bool DesktopUninstallValueMatches(HKEY key, const DesktopUninstallValue& expected) {
  DWORD type = 0, bytes = 0;
  if (RegQueryValueExW(key, expected.name, nullptr, &type, nullptr, &bytes) != ERROR_SUCCESS) return false;
  if (expected.number) {
    DWORD value = 0;
    return type == REG_DWORD && bytes == sizeof(value) && RegQueryValueExW(key, expected.name, nullptr, &type,
      reinterpret_cast<BYTE*>(&value), &bytes) == ERROR_SUCCESS && type == REG_DWORD && bytes == sizeof(value) && value == 1;
  }
  if (type != REG_SZ || bytes != (expected.text.size() + 1) * sizeof(wchar_t)) return false;
  std::vector<wchar_t> value(expected.text.size() + 1);
  return RegQueryValueExW(key, expected.name, nullptr, &type, reinterpret_cast<BYTE*>(value.data()), &bytes) == ERROR_SUCCESS
    && type == REG_SZ && bytes == value.size() * sizeof(wchar_t) && value.back() == L'\0'
    && std::wstring(value.data(), value.size() - 1) == expected.text;
}
static void VerifyDesktopUninstall(HKEY key, const std::vector<DesktopUninstallValue>& before,
    const std::vector<DesktopUninstallValue>& after, bool complete) {
  DWORD subkeys = 0, values = 0;
  if (RegQueryInfoKeyW(key, nullptr, nullptr, nullptr, &subkeys, nullptr, nullptr, &values, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS
    || subkeys || values > after.size() || (complete && values != after.size())) throw std::runtime_error("Custom uninstall entry retained");
  for (DWORD i = 0; i < values; i++) {
    wchar_t name[256]; DWORD length = 256;
    if (RegEnumValueW(key, i, name, &length, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) throw std::runtime_error("Cannot inspect uninstall entry");
    bool recognized = false;
    for (size_t field = 0; field < after.size(); field++) if (std::wstring(name, length) == after[field].name) {
      recognized = DesktopUninstallValueMatches(key, after[field]) || (!complete && DesktopUninstallValueMatches(key, before[field])); break;
    }
    if (!recognized) throw std::runtime_error("Custom uninstall entry retained");
  }
}
static napi_value ReplaceDesktopUninstall(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 4; napi_value args[4]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 3) throw std::runtime_error("Expected installation and source/target entry");
    auto keyPath = DesktopUninstallKey(env, args[0]);
    auto before = DesktopUninstallValues(env, args[1]), after = DesktopUninstallValues(env, args[2]);
    if (before[3].text != after[3].text) throw std::runtime_error("Installation root changed");
    DesktopLoginKey key;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, keyPath.c_str(), 0, nullptr, 0, KEY_QUERY_VALUE | KEY_SET_VALUE | KEY_ENUMERATE_SUB_KEYS,
      nullptr, &key.value, nullptr) != ERROR_SUCCESS) throw std::runtime_error("Cannot register uninstall entry");
    // Missing fields or a mixture of these exact old/new values can be left by
    // interruption. Unknown values are preserved, never repaired by overwriting.
    VerifyDesktopUninstall(key.value, before, after, false);
    for (const auto& field : after) {
      VerifyDesktopUninstall(key.value, before, after, false);
      DWORD number = 1;
      const BYTE* bytes = field.number ? reinterpret_cast<const BYTE*>(&number) : reinterpret_cast<const BYTE*>(field.text.c_str());
      DWORD length = field.number ? sizeof(number) : static_cast<DWORD>((field.text.size() + 1) * sizeof(wchar_t));
      if (RegSetValueExW(key.value, field.name, 0, field.number ? REG_DWORD : REG_SZ, bytes, length) != ERROR_SUCCESS) throw std::runtime_error("Uninstall registration incomplete");
    }
    if (RegFlushKey(key.value) != ERROR_SUCCESS) throw std::runtime_error("Uninstall registration unconfirmed");
    VerifyDesktopUninstall(key.value, after, after, true);
    napi_value result; napi_get_boolean(env, true, &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_INSTALL_REGISTRATION", error.what()); return nullptr; }
}
static napi_value RemoveDesktopUninstall(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 3; napi_value args[3]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) throw std::runtime_error("Expected installation and original entry");
    auto keyPath = DesktopUninstallKey(env, args[0]); auto expected = DesktopUninstallValues(env, args[1]);
    DesktopLoginKey key;
    LONG opened = RegOpenKeyExW(HKEY_CURRENT_USER, keyPath.c_str(), 0, KEY_QUERY_VALUE | KEY_ENUMERATE_SUB_KEYS, &key.value);
    if (opened != ERROR_FILE_NOT_FOUND) {
      if (opened != ERROR_SUCCESS) throw std::runtime_error("Cannot inspect uninstall entry");
      VerifyDesktopUninstall(key.value, expected, expected, true);
      if (RegDeleteKeyW(HKEY_CURRENT_USER, keyPath.c_str()) != ERROR_SUCCESS) throw std::runtime_error("Uninstall entry removal unconfirmed");
      HKEY deleted = key.value; key.value = nullptr;
      if (RegCloseKey(deleted) != ERROR_SUCCESS || RegFlushKey(HKEY_CURRENT_USER) != ERROR_SUCCESS) throw std::runtime_error("Uninstall entry removal unconfirmed");
      DesktopLoginKey remaining;
      if (RegOpenKeyExW(HKEY_CURRENT_USER, keyPath.c_str(), 0, KEY_QUERY_VALUE, &remaining.value) != ERROR_FILE_NOT_FOUND) throw std::runtime_error("Uninstall entry removal unconfirmed");
    }
    napi_value result; napi_get_boolean(env, true, &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_INSTALL_REGISTRATION", error.what()); return nullptr; }
}
#endif
