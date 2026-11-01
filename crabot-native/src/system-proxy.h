#ifdef _WIN32
// Reads the logged-in user's fixed connection proxy only. No PAC evaluation,
// registry writes, machine defaults, or WinHTTP session/network requests.
struct UserProxyConfiguration {
  WINHTTP_CURRENT_USER_IE_PROXY_CONFIG value{};
  ~UserProxyConfiguration() {
    if (value.lpszProxy) GlobalFree(value.lpszProxy);
    if (value.lpszProxyBypass) GlobalFree(value.lpszProxyBypass);
    if (value.lpszAutoConfigUrl) GlobalFree(value.lpszAutoConfigUrl);
  }
};
static napi_value ReadWindowsFixedProxy(napi_env env, napi_callback_info info) {
  UserProxyConfiguration config;
  napi_value result;
  if (!WinHttpGetIEProxyConfigForCurrentUser(&config.value) || !config.value.lpszProxy) {
    napi_get_null(env, &result); return result;
  }
  const auto length = wcsnlen_s(config.value.lpszProxy, 32768);
  if (!length) { napi_get_null(env, &result); return result; }
  if (length >= 32768) {
    napi_throw_error(env, "CRABOT_SYSTEM_PROXY", "Cannot read current user fixed proxy"); return nullptr;
  }
  napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(config.value.lpszProxy), length, &result);
  return result;
}
#endif
