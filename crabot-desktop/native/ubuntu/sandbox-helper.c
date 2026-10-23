#define _GNU_SOURCE
#include <json-glib/json-glib.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "apparmor-path.h"

/* One-shot, no GTK, no application execution and no business data access.
 * Only --inspect ROOT (caller UID, read-only) or --register ROOT (Polkit). */
static uid_t caller;
static const char *stage = "arguments";
static void refuse(void) {
  fprintf(stderr, "CRABOT_SANDBOX_NOT_READY:%s\n", stage);
  exit(1);
}
static void need(bool ok) { if (!ok) refuse(); }
static bool matches(const char *value, const char *pattern) {
  return value && g_regex_match_simple(pattern, value, 0, 0);
}
static bool same_stat(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_mode == b->st_mode && a->st_uid == b->st_uid
    && a->st_size == b->st_size && a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec
    && a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}
static void directory(int fd, uid_t owner, bool ancestors) {
  struct stat st;
  need(fd >= 0 && fstat(fd, &st) == 0 && S_ISDIR(st.st_mode) && !(st.st_mode & 0022)
    && (st.st_uid == owner || (ancestors && st.st_uid == 0)));
}
/* Every component opened without following links. Caller-owned ancestors are
 * accepted only without group/other write. No PATH, realpath-follow fallback. */
static int open_chain(int base, const char *relative, uid_t owner, bool ancestors, bool is_directory) {
  need(relative && *relative && relative[0] != '/');
  g_auto(GStrv) parts = g_strsplit(relative, "/", -1);
  int fd = dup(base); need(fd >= 0);
  for (size_t i = 0; parts[i]; i++) {
    need(*parts[i] && strcmp(parts[i], ".") && strcmp(parts[i], ".."));
    bool last = parts[i + 1] == NULL;
    int next = openat(fd, parts[i], O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | ((!last || is_directory) ? O_DIRECTORY : 0));
    close(fd); fd = next; need(fd >= 0);
    if (!last || is_directory) directory(fd, owner, ancestors);
  }
  return fd;
}
static int root_directory(const char *root, uid_t owner) {
  need(root && root[0] == '/' && strlen(root) < 3000 && root[1] && !strchr(root, '\n') && !strchr(root, '\r'));
  int slash = open("/", O_RDONLY | O_CLOEXEC | O_DIRECTORY); need(slash >= 0);
  int fd = open_chain(slash, root + 1, owner, true, true); close(slash);
  struct stat st; need(fstat(fd, &st) == 0 && st.st_uid == owner && (st.st_mode & 07777) == 0700);
  return fd;
}
static char *read_file(int base, const char *relative, uid_t owner, size_t limit, bool private_file, char **digest) {
  int fd = open_chain(base, relative, owner, false, false);
  struct stat before, after;
  need(fstat(fd, &before) == 0 && S_ISREG(before.st_mode) && before.st_uid == owner && before.st_nlink == 1
    && !(before.st_mode & 0022) && before.st_size > 0 && (uint64_t)before.st_size <= limit
    && (!private_file || (before.st_mode & 07777) == 0600));
  char *text = g_malloc((size_t)before.st_size + 1); size_t used = 0;
  while (used < (size_t)before.st_size) {
    ssize_t count = read(fd, text + used, (size_t)before.st_size - used);
    if (count < 0 && errno == EINTR) continue;
    need(count > 0); used += (size_t)count;
  }
  char extra; need(read(fd, &extra, 1) == 0 && fstat(fd, &after) == 0 && same_stat(&before, &after));
  close(fd); text[used] = 0;
  if (digest) *digest = g_compute_checksum_for_data(G_CHECKSUM_SHA256, (guchar *)text, used);
  need(!memchr(text, 0, used)); return text;
}
static void member_seen(JsonParser *parser, JsonObject *object, const char *member, gpointer data) {
  (void)parser;
  g_autofree char *key = g_strdup_printf("%p:%s", (void *)object, member);
  need(g_hash_table_add(data, g_strdup(key)));
}
static JsonNode *json(int base, const char *relative, size_t limit, bool private_file, char **digest) {
  g_autofree char *text = read_file(base, relative, caller, limit, private_file, digest);
  /* JSON strings cannot smuggle a truncated C string through an escaped NUL. */
  for (const char *p = text; *p; p++) if (*p == '\\') {
    size_t slashes = 0; while (p[slashes] == '\\') slashes++;
    need(!(slashes % 2 && !strncmp(p + slashes, "u0000", 5)));
    p += slashes - 1;
  }
  g_autoptr(JsonParser) parser = json_parser_new();
  g_autoptr(GHashTable) members = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
  g_signal_connect(parser, "object-member", G_CALLBACK(member_seen), members);
  need(json_parser_load_from_data(parser, text, -1, NULL));
  JsonNode *node = json_parser_get_root(parser); need(node && JSON_NODE_HOLDS_OBJECT(node));
  return json_node_copy(node);
}
static JsonObject *object(JsonObject *obj, const char *name) {
  JsonNode *node = json_object_get_member(obj, name); need(node && JSON_NODE_HOLDS_OBJECT(node)); return json_node_get_object(node);
}
static const char *string(JsonObject *obj, const char *name) {
  JsonNode *node = json_object_get_member(obj, name);
  need(node && JSON_NODE_HOLDS_VALUE(node) && json_node_get_value_type(node) == G_TYPE_STRING);
  const char *value = json_node_get_string(node); need(value && g_utf8_validate(value, -1, NULL)); return value;
}
static int64_t integer(JsonObject *obj, const char *name) {
  JsonNode *node = json_object_get_member(obj, name);
  need(node && JSON_NODE_HOLDS_VALUE(node) && json_node_get_value_type(node) == G_TYPE_INT64); return json_node_get_int(node);
}
static void eq(JsonObject *obj, const char *name, const char *expected) { need(!strcmp(string(obj, name), expected)); }
static void keys(JsonObject *obj, const char *names) {
  g_auto(GStrv) wanted = g_strsplit(names, ",", -1); size_t count = 0;
  for (; wanted[count]; count++) need(json_object_has_member(obj, wanted[count]));
  need(json_object_get_size(obj) == count);
}
static void pair(JsonObject *obj, const char *version, const char *gui, const char *core) {
  keys(obj, "schema_version,version,gui_id,core_id"); need(integer(obj, "schema_version") == 1);
  eq(obj, "version", version); eq(obj, "gui_id", gui); eq(obj, "core_id", core);
}
typedef struct { char *relative, *name, *text, *sha; struct stat identity; } Target;
static void executable(int base, const char *relative, JsonObject *record, struct stat *identity, char **sha) {
  int fd = open_chain(base, relative, caller, false, false); struct stat after;
  need(fstat(fd, identity) == 0 && S_ISREG(identity->st_mode) && identity->st_uid == caller && identity->st_nlink == 1
    && (identity->st_mode & 07000) == 0 && !(identity->st_mode & 0022) && (identity->st_mode & 0111)
    && identity->st_size == integer(record, "size"));
  g_autoptr(GChecksum) sum = g_checksum_new(G_CHECKSUM_SHA256); unsigned char bytes[65536]; ssize_t count; bool first = true;
  while ((count = read(fd, bytes, sizeof bytes)) != 0) {
    if (count < 0 && errno == EINTR) continue;
    need(count > 0);
    if (first) { need(count >= 20 && !memcmp(bytes, "\177ELF\2\1", 6) && bytes[18] == 62 && bytes[19] == 0); first = false; }
    g_checksum_update(sum, bytes, (size_t)count);
  }
  need(!first && fstat(fd, &after) == 0 && same_stat(identity, &after)); close(fd);
  eq(record, "sha256", g_checksum_get_string(sum)); *sha = g_strdup(g_checksum_get_string(sum));
}
static void make_target(Target *target, int root, const char *install_root, const char *id, const char *role,
    const char *version_id, const char *relative, JsonObject *record) {
  target->relative = g_strdup(relative);
  executable(root, relative, record, &target->identity, &target->sha);
  g_autofree char *full = g_build_filename(install_root, relative, NULL);
  char escaped[16384]; need(crabot_apparmor_path(full, escaped, sizeof escaped));
  target->name = g_strdup_printf("crabot-%lu-%s-%s-%s", (unsigned long)caller, id, role, version_id);
  target->text = g_strdup_printf("# Crabot exact-path user namespace registration\nabi <abi/4.0>,\nprofile %s %s flags=(unconfined) {\n  userns,\n}\n", target->name, escaped);
}
static void verify_targets(const char *install_root, int root, Target targets[3]) {
  stage = "installation";
  g_autoptr(JsonNode) metadata = json(root, "desktop-installation.json", 65536, true, NULL);
  JsonObject *own = json_node_get_object(metadata); keys(own, "schema_version,installation_id,owner,install_root,root_identity,paths");
  need(integer(own, "schema_version") == 1);
  const char *id = string(own, "installation_id");
  need(matches(id, "^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$"));
  g_autofree char *owner = g_strdup_printf("%lu", (unsigned long)caller); eq(own, "owner", owner); eq(own, "install_root", install_root);
  struct stat st; need(fstat(root, &st) == 0);
  g_autofree char *dev = g_strdup_printf("%ju", (uintmax_t)st.st_dev), *ino = g_strdup_printf("%ju", (uintmax_t)st.st_ino);
  JsonObject *identity = object(own, "root_identity"), *paths = object(own, "paths");
  keys(identity, "dev,ino"); eq(identity, "dev", dev); eq(identity, "ino", ino);
  keys(paths, "app,core,data,bin"); eq(paths, "app", "app/releases"); eq(paths, "core", "releases"); eq(paths, "data", "data"); eq(paths, "bin", "bin");
  stage = "prepared-pair";
  g_autoptr(JsonNode) pending = json(root, ".desktop-installing.json", 4096, true, NULL);
  JsonObject *state = json_node_get_object(pending); keys(state, "schema_version,id,installation_id,selection,phase,payload_sha256");
  need(integer(state, "schema_version") == 1); eq(state, "installation_id", id); eq(state, "phase", "prepared");
  JsonObject *selection = object(state, "selection");
  const char *gui = string(selection, "gui_id"), *core = string(selection, "core_id"), *version = string(selection, "version");
  need(matches(gui, "^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$") && matches(core, "^[a-f0-9]{64}$")
    && matches(version, "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9_.-]+)?$"));
  pair(selection, version, gui, core);
  g_autofree char *payload_sha = NULL;
  g_autoptr(JsonNode) payload = json(root, ".desktop-install-payload.json", 64 * 1024 * 1024, true, &payload_sha);
  eq(state, "payload_sha256", payload_sha);
  JsonObject *proof = json_node_get_object(payload); need(integer(proof, "schema_version") == 1); eq(proof, "platform", "linux"); eq(proof, "arch", "x64");
  pair(object(proof, "selection"), version, gui, core);
  g_autofree char *pin_path = g_strdup_printf("app/releases/%s/resources/desktop-release.json", gui);
  g_autoptr(JsonNode) pin = json(root, pin_path, 4096, false, NULL); pair(json_node_get_object(pin), version, gui, core);
  g_autofree char *release_path = g_strdup_printf("releases/%s/core-release.json", core);
  g_autoptr(JsonNode) release = json(root, release_path, 65536, false, NULL);
  JsonObject *release_obj = json_node_get_object(release);
  need(integer(release_obj, "schema_version") == 1); eq(release_obj, "inventory_sha256", core); eq(release_obj, "version", version);
  eq(release_obj, "platform", "linux"); eq(release_obj, "arch", "x64");
  stage = "core-inventory";
  g_autofree char *index_path = g_strdup_printf("releases/%s/core-files.json", core), *index_sha = NULL;
  g_autoptr(JsonNode) index = json(root, index_path, 64 * 1024 * 1024, false, &index_sha); need(!strcmp(index_sha, core));
  JsonObject *files = object(json_node_get_object(index), "files");
  g_autofree char *runtime_path = g_strdup_printf("releases/%s/product-runtime.json", core), *runtime_sha = NULL;
  g_autoptr(JsonNode) runtime = json(root, runtime_path, 64 * 1024 * 1024, false, &runtime_sha);
  eq(object(files, "product-runtime.json"), "sha256", runtime_sha);
  JsonObject *product = json_node_get_object(runtime); need(integer(product, "schema_version") == 1); eq(product, "version", version);
  eq(product, "platform", "linux"); eq(product, "arch", "x64");
  const char *browser = string(product, "browser");
  need(matches(browser, "^\\.scrapling-runtime-[a-f0-9]{16}/chromium-launcher$"));
  g_autofree char *runtime_dir = g_path_get_dirname(browser);
  JsonObject *runtime_files = object(product, "files");
  g_autofree char *gui_path = g_strdup_printf("app/releases/%s/crabot-desktop", gui);
  stage = "gui-entry";
  make_target(&targets[0], root, install_root, id, "gui", gui, gui_path, object(object(proof, "gui"), "crabot-desktop"));
  stage = "browser-entries";
  g_autoptr(GList) names = json_object_get_members(runtime_files); bool found[2] = { false, false };
  for (GList *item = names; item; item = item->next) {
    const char *name = item->data;
    if (!g_str_has_prefix(name, runtime_dir) || name[strlen(runtime_dir)] != '/') continue;
    const char *suffix = name + strlen(runtime_dir) + 1; int role = -1;
    if (matches(suffix, "^browsers/chromium-[0-9]+/chrome-linux(64)?/chrome$")) role = 0;
    if (matches(suffix, "^browsers/chromium_headless_shell-[0-9]+/chrome-headless-shell-linux(64)?/headless_shell$")) role = 1;
    if (role < 0) continue;
    need(!found[role]); found[role] = true;
    JsonObject *entry = object(runtime_files, name), *core_entry = object(files, name);
    eq(core_entry, "type", "file"); eq(core_entry, "sha256", string(entry, "sha256")); need(integer(core_entry, "size") == integer(entry, "size"));
    g_autofree char *relative = g_strdup_printf("releases/%s/%s", core, name);
    make_target(&targets[role + 1], root, install_root, id, role ? "headless" : "chromium", core, relative, entry);
  }
  need(found[0] && found[1]);
}
static void unchanged_targets(const char *root_path, int root, Target targets[3]) {
  int current = root_directory(root_path, caller); struct stat before, after;
  need(fstat(root, &before) == 0 && fstat(current, &after) == 0 && before.st_ino == after.st_ino && before.st_dev == after.st_dev); close(current);
  for (int i = 0; i < 3; i++) {
    int fd = open_chain(root, targets[i].relative, caller, false, false);
    need(fstat(fd, &after) == 0 && same_stat(&targets[i].identity, &after)); close(fd);
  }
}
static int system_directory(void) {
  int slash = open("/", O_RDONLY | O_CLOEXEC | O_DIRECTORY); need(slash >= 0);
  int fd = open_chain(slash, "etc/apparmor.d", 0, false, true); close(slash); return fd;
}
static bool existing_policy(int directory_fd, const Target *target) {
  struct stat st;
  if (fstatat(directory_fd, target->name, &st, AT_SYMLINK_NOFOLLOW) != 0) { need(errno == ENOENT); return false; }
  need(S_ISREG(st.st_mode) && st.st_uid == 0 && st.st_nlink == 1 && (st.st_mode & 07777) == 0644);
  g_autofree char *text = read_file(directory_fd, target->name, 0, 16384, false, NULL);
  need(!strcmp(text, target->text)); return true;
}
static void publish_policy(int directory_fd, const Target *target) {
  if (existing_policy(directory_fd, target)) return;
  g_autofree char *random = g_uuid_string_random(), *temporary = g_strconcat(".crabot-", random, NULL);
  int fd = openat(directory_fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600); need(fd >= 0);
  size_t size = strlen(target->text), used = 0; bool ok = true;
  while (used < size) { ssize_t count = write(fd, target->text + used, size - used); if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { ok = false; break; } used += (size_t)count; }
  ok = ok && fchmod(fd, 0644) == 0 && fsync(fd) == 0;
  close(fd);
  if (ok) { if (linkat(directory_fd, temporary, directory_fd, target->name, 0) != 0) ok = errno == EEXIST; }
  bool removed = unlinkat(directory_fd, temporary, 0) == 0;
  need(ok && removed && fsync(directory_fd) == 0 && existing_policy(directory_fd, target));
}
static void load_policy(const Target *target) {
  /* Fixed executable and clean environment; never execute the verified entries. */
  int slash = open("/", O_RDONLY | O_CLOEXEC | O_DIRECTORY); need(slash >= 0);
  int parser = open_chain(slash, "usr/sbin/apparmor_parser", 0, false, false); close(slash);
  struct stat st; need(fstat(parser, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == 0 && !(st.st_mode & 0022) && (st.st_mode & 0111));
  g_autofree char *file = g_strconcat("/etc/apparmor.d/", target->name, NULL);
  pid_t pid = fork(); need(pid >= 0);
  if (pid == 0) {
    char *args[] = { "apparmor_parser", "-r", "-T", "-K", "--", file, NULL };
    char *env[] = { "PATH=/usr/sbin:/usr/bin", "LANG=C", "LC_ALL=C", "HOME=/root", NULL };
    if (chdir("/") != 0) _exit(126);
    fexecve(parser, args, env); _exit(126);
  }
  close(parser);
  int status = 0; pid_t waited; struct timespec begin, now; clock_gettime(CLOCK_MONOTONIC, &begin);
  while (true) {
    waited = waitpid(pid, &status, WNOHANG);
    if (waited < 0 && errno == EINTR) continue;
    if (waited != 0) break;
    clock_gettime(CLOCK_MONOTONIC, &now);
    if (now.tv_sec - begin.tv_sec > 90) { kill(pid, SIGKILL); while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {} refuse(); }
    struct timespec delay = { 0, 50000000 }; nanosleep(&delay, NULL);
  }
  need(waited == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0);
}
int main(int argc, char **argv) {
  umask(077);
  bool inspect = argc == 3 && !strcmp(argv[1], "--inspect"), registration = argc == 3 && !strcmp(argv[1], "--register");
  need(inspect || registration);
  if (registration) {
    const char *value = getenv("PKEXEC_UID");
    need(geteuid() == 0 && matches(value, "^[1-9][0-9]{0,9}$"));
    unsigned long parsed = strtoul(value, NULL, 10); need(parsed > 0 && parsed < UINT32_MAX); caller = (uid_t)parsed;
  } else { need(getuid() != 0 && getuid() == geteuid()); caller = getuid(); }
  stage = "root"; int root = root_directory(argv[2], caller); Target targets[3] = {0};
  verify_targets(argv[2], root, targets); stage = "entries-changed"; unchanged_targets(argv[2], root, targets);
  if (registration) {
    stage = "system-policy-conflict"; int system = system_directory();
    for (int i = 0; i < 3; i++) existing_policy(system, &targets[i]);
    for (int i = 0; i < 3; i++) { stage = "entries-changed"; unchanged_targets(argv[2], root, targets);
      stage = "system-policy-publish"; publish_policy(system, &targets[i]); stage = "system-policy-load"; load_policy(&targets[i]); }
    close(system);
  } else {
    for (int i = 0; i < 3; i++) { printf("%s\n%s", targets[i].name, targets[i].text); }
  }
  close(root);
  for (int i = 0; i < 3; i++) { g_free(targets[i].relative); g_free(targets[i].name); g_free(targets[i].text); g_free(targets[i].sha); }
  puts("CRABOT_SANDBOX_VERIFIED"); return 0;
}
