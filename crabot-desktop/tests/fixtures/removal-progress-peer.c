#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(void) {
  FILE *started = fopen("spawned", "w"); if (!started) return 7; fprintf(started, "%ld", (long)getpid()); fclose(started);
  char mode[64] = {0}, frame[4096]; FILE *file = fopen("behavior", "r");
  if (!file || !fgets(mode, sizeof mode, file)) return 8;
  fclose(file);
  if (getenv("NODE_OPTIONS") || getenv("DATA_DIR") || getenv("ADMIN_TOKEN") || getenv("CRABOT_PRODUCT_ROOT")) return 91;
  if (!strcmp(mode, "exit")) return 9;
  if (!strcmp(mode, "silent")) { for (;;) pause(); }
  if (!strcmp(mode, "invalid")) { puts("{\"action\":\"run\"}"); fflush(stdout); }
  else if (!strcmp(mode, "oversize")) { for (int i=0; i<300; i++) putchar('x'); fflush(stdout); }
  else { puts("{\"event\":\"ready\"}"); fflush(stdout); }
  if (!strcmp(mode, "duplicate-ready")) { puts("{\"event\":\"ready\"}"); fflush(stdout); }
  while (fgets(frame, sizeof frame, stdin)) {
    if (strstr(frame, "\"type\":\"close\"")) {
      if (!strcmp(mode, "ignore-close")) { for (;;) pause(); }
      return 0;
    }
    if (!strcmp(mode, "late-invalid")) { puts("{\"action\":\"run\"}"); fflush(stdout); }
    if (!strcmp(mode, "cancel") || !strcmp(mode, "duplicate-cancel") || !strcmp(mode, "uncancellable")) {
      puts("{\"action\":\"cancel\"}");
      if (!strcmp(mode, "duplicate-cancel")) puts("{\"action\":\"cancel\"}");
      fflush(stdout);
    }
  }
  return 0;
}
