/* Finite parent transport fixture, not the GTK installer or business Core. */
#include <errno.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 4) return 2;
  pid_t child = fork();
  if (child < 0) return 3;
  if (!child) { execl(argv[1], argv[1], argv[2], argv[3], (char *)0); _exit(127); }
  int status;
  while (waitpid(child, &status, 0) < 0) if (errno != EINTR) return 4;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
