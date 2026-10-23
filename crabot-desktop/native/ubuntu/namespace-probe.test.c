#define _GNU_SOURCE
#include <sched.h>
#include <errno.h>
int main(void) {
  if (unshare(CLONE_NEWUSER) == 0) return 0;
  return errno == EPERM || errno == EACCES ? 13 : 1;
}
