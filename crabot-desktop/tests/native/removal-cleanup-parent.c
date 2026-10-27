// Finite native parent-image fixture, not a product GUI or business runtime.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/types.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int output[2]; if (pipe(output)) return 2;
  pid_t child = fork(); if (child < 0) return 2;
  if (!child) {
    close(output[0]); if (dup2(output[1], STDOUT_FILENO) < 0) _exit(2); close(output[1]);
    execl(argv[1], argv[1], (char *)NULL); _exit(2);
  }
  close(output[1]); printf("CHILD:%ld\n", (long)child); fflush(stdout);
  char ready[6]; size_t count = 0;
  while (count < sizeof(ready)) { ssize_t n = read(output[0], ready + count, sizeof(ready) - count); if (n <= 0) return 2; count += (size_t)n; }
  close(output[0]); if (memcmp(ready, "READY\n", sizeof(ready))) return 2;
  puts("READY"); fflush(stdout);
  char action; return read(STDIN_FILENO, &action, 1) == 1 && action == 'q' ? 0 : 2;
}
