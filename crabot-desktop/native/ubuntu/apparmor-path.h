#ifndef CRABOT_APPARMOR_PATH_H
#define CRABOT_APPARMOR_PATH_H
#include <stddef.h>
/* Quoted AppArmor attachment. Hex escapes avoid both variable expansion and
 * glob syntax. Slash stays visible so this is an absolute attachment. */
static int crabot_apparmor_path(const char *path, char *out, size_t capacity) {
  static const char hex[] = "0123456789abcdef";
  size_t used = 0;
  if (!path || path[0] != '/' || capacity < 3) return 0;
  out[used++] = '"';
  for (const unsigned char *p = (const unsigned char *)path; *p; ++p) {
    if (*p < 32 || *p == 127) return 0;
    int plain = (*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9')
      || *p >= 128 || *p == '/' || *p == '-' || *p == '_' || *p == '.' || *p == ' ';
    size_t count = plain ? 1 : 4;
    if (used + count + 2 > capacity) return 0;
    if (plain) out[used++] = (char)*p;
    else { out[used++] = '\\'; out[used++] = 'x'; out[used++] = hex[*p >> 4]; out[used++] = hex[*p & 15]; }
  }
  out[used++] = '"'; out[used] = 0;
  return 1;
}
#endif
