#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "apparmor-path.h"
int main(void) {
  char out[1024];
  assert(crabot_apparmor_path("/home/用户/Crabot dir", out, sizeof out));
  assert(!strcmp(out, "\"/home/用户/Crabot dir\""));
  assert(crabot_apparmor_path("/a/@{HOME}/*?[]{}\\\"#", out, sizeof out));
  assert(!strcmp(out, "\"/a/\\x40\\x7bHOME\\x7d/\\x2a\\x3f\\x5b\\x5d\\x7b\\x7d\\x5c\\x22\\x23\""));
  assert(!crabot_apparmor_path("relative", out, sizeof out));
  assert(!crabot_apparmor_path("/newline\nentry", out, sizeof out));
  assert(!crabot_apparmor_path("/tab\tentry", out, sizeof out));
  assert(!crabot_apparmor_path("/ab", out, 5));
  assert(crabot_apparmor_path("/a", out, 5));
  puts("AppArmor literal attachment cases passed");
}
