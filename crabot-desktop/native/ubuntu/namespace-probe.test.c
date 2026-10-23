#define _GNU_SOURCE
#include <sched.h>
#include <errno.h>
int main(void) {
  /* Ubuntu may permit creation but deny capabilities inside the new userns.
   * Exercise the network namespace operation Chromium also needs. */
  if (unshare(CLONE_NEWUSER) != 0) return errno == EPERM || errno == EACCES ? 13 : 1;
  if (unshare(CLONE_NEWNET) == 0) return 0;
  return errno == EPERM || errno == EACCES ? 13 : 1;
}
