#define _GNU_SOURCE
#include <sched.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  /* Ubuntu may permit creation but deny capabilities inside the new userns.
   * Exercise the network namespace operation Chromium also needs. */
  if (unshare(CLONE_NEWUSER) != 0) return errno == EPERM || errno == EACCES ? 13 : 1;
  if (unshare(CLONE_NEWNET) == 0) {
    if (argc == 2 && !strcmp(argv[1], "--hold")) { puts("CRABOT_NAMESPACE_HOLD"); fflush(stdout); sleep(30); }
    return 0;
  }
  return errno == EPERM || errno == EACCES ? 13 : 1;
}
