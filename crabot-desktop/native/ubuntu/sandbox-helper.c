#define _GNU_SOURCE
#include <json-glib/json-glib.h>
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <inttypes.h>
#include <poll.h>
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
 * Fixed install/update registration and exact uninstall rules; no executable list. */
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
  struct stat st; need(fstat(fd, &st) == 0 && st.st_uid == owner && (st.st_mode & 0700) == 0700 && !(st.st_mode & 07022));
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
static JsonNode *json_text(const char *text) {
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
static JsonNode *json(int base, const char *relative, size_t limit, bool private_file, char **digest) {
  g_autofree char *text = read_file(base, relative, caller, limit, private_file, digest);
  return json_text(text);
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
static void valid_pair(JsonObject *selection) {
  const char *gui = string(selection, "gui_id"), *core = string(selection, "core_id"), *version = string(selection, "version");
  need(matches(gui, "^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$") && matches(core, "^[a-f0-9]{64}$")
    && matches(version, "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9_.-]+)?$"));
  pair(selection, version, gui, core);
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
static void make_policy(Target *target, const char *install_root, const char *id, const char *role, const char *version_id, const char *relative) {
  target->relative = g_strdup(relative);
  g_autofree char *full = g_build_filename(install_root, relative, NULL);
  char escaped[16384]; need(crabot_apparmor_path(full, escaped, sizeof escaped));
  target->name = g_strdup_printf("crabot-%lu-%s-%s-%s", (unsigned long)caller, id, role, version_id);
  target->text = g_strdup_printf("# Crabot exact-path user namespace registration\nabi <abi/4.0>,\nprofile %s %s flags=(unconfined) {\n  userns,\n}\n", target->name, escaped);
}
static void make_target(Target *target, int root, const char *install_root, const char *id, const char *role,
    const char *version_id, const char *relative, JsonObject *record) {
  make_policy(target, install_root, id, role, version_id, relative);
  executable(root, relative, record, &target->identity, &target->sha);
}
static JsonNode *verified_metadata(const char *install_root, int root) {
  JsonNode *metadata = json(root, "desktop-installation.json", 65536, true, NULL);
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
  return metadata;
}
static int verify_targets(const char *install_root, int root, Target targets[3], const char *update_gui) {
  stage = "installation";
  g_autoptr(JsonNode) metadata = verified_metadata(install_root, root);
  const char *id = string(json_node_get_object(metadata), "installation_id");
  struct stat st;
  stage = "prepared-pair";
  g_autoptr(JsonNode) pending = NULL, payload = NULL;
  JsonObject *selection;
  if (update_gui) {
    /* Existing online preparation uses the already defined per-GUI payload
     * proof. Never invent a fresh-install marker or read business state. */
    stage = "update-source";
    need(fstatat(root, ".desktop-installing.json", &st, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT);
    g_autoptr(JsonNode) current = json(root, "current-release.json", 4096, true, NULL);
    JsonObject *source = json_node_get_object(current); valid_pair(source);
    g_autofree char *source_pin = g_strdup_printf("app/releases/%s/resources/desktop-release.json", string(source, "gui_id"));
    g_autoptr(JsonNode) original_pin = json(root, source_pin, 4096, false, NULL);
    pair(json_node_get_object(original_pin), string(source, "version"), string(source, "gui_id"), string(source, "core_id"));
    g_autofree char *source_release = g_strdup_printf("releases/%s/core-release.json", string(source, "core_id"));
    g_autoptr(JsonNode) original_release = json(root, source_release, 65536, false, NULL);
    JsonObject *original = json_node_get_object(original_release);
    need(integer(original, "schema_version") == 1); eq(original, "inventory_sha256", string(source, "core_id"));
    eq(original, "version", string(source, "version")); eq(original, "platform", "linux"); eq(original, "arch", "x64");
    stage = "update-prepared-pair";
    g_autofree char *proof_path = g_strdup_printf("app/payloads/%s.json", update_gui);
    payload = json(root, proof_path, 64 * 1024 * 1024, true, NULL);
    selection = object(json_node_get_object(payload), "selection"); eq(selection, "gui_id", update_gui);
  } else {
    pending = json(root, ".desktop-installing.json", 4096, true, NULL);
    JsonObject *state = json_node_get_object(pending); keys(state, "schema_version,id,installation_id,selection,phase,payload_sha256");
    need(integer(state, "schema_version") == 1); eq(state, "installation_id", id); eq(state, "phase", "prepared");
    selection = object(state, "selection"); valid_pair(selection);
    g_autofree char *prepared_proof = g_strdup_printf("app/payloads/%s.json", string(selection, "gui_id"));
    int cached = fstatat(root, prepared_proof, &st, AT_SYMLINK_NOFOLLOW);
    need(cached == 0 || errno == ENOENT);
    g_autofree char *payload_sha = NULL;
    payload = json(root, cached == 0 ? prepared_proof : ".desktop-install-payload.json", 64 * 1024 * 1024, true, &payload_sha);
    eq(state, "payload_sha256", payload_sha);
  }
  valid_pair(selection);
  const char *gui = string(selection, "gui_id"), *core = string(selection, "core_id"), *version = string(selection, "version");
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
  g_autofree char *pointer_path = g_strdup_printf("releases/%s/scrapling-runtime.json", core), *pointer_sha = NULL;
  g_autoptr(JsonNode) pointer = json(root, pointer_path, 4096, false, &pointer_sha);
  eq(object(files, "scrapling-runtime.json"), "sha256", pointer_sha);
  JsonObject *location = json_node_get_object(pointer); keys(location, "directory");
  const char *runtime_dir = string(location, "directory");
  need(strlen(runtime_dir) <= 240 && matches(runtime_dir, "^\\.scrapling-runtime-[A-Za-z0-9.-]+-[a-f0-9]{16}-[a-f0-9]{8}$"));
  g_autofree char *launcher = g_strconcat(runtime_dir, "/chromium-launcher", NULL); eq(product, "browser", launcher);
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
  need(found[0]);
  return found[1] ? 3 : 2;
}
/* History is used only to derive this caller's exact policy names and paths;
 * no historical program, business data, command or parser input is executed. */
static int removal_targets(const char *install_root, int root, Target targets[3]) {
  stage = "removal-installation";
  g_autoptr(JsonNode) metadata = verified_metadata(install_root, root);
  const char *id = string(json_node_get_object(metadata), "installation_id");
  g_autoptr(JsonNode) fence = json(root, ".desktop-removal.json", 4096, true, NULL);
  JsonObject *state = json_node_get_object(fence);
  keys(state, "schema_version,installation_id,operation_id,source_selection,phase,proof_sha256");
  need(integer(state, "schema_version") == 1); eq(state, "installation_id", id);
  need(!strcmp(string(state, "phase"), "stopping") || !strcmp(string(state, "phase"), "removing"));
  const char *operation = string(state, "operation_id"), *expected_sha = string(state, "proof_sha256");
  need(matches(operation, "^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$") && matches(expected_sha, "^[a-f0-9]{64}$"));
  JsonObject *selection = object(state, "source_selection"); valid_pair(selection);
  const char *gui = string(selection, "gui_id"), *core = string(selection, "core_id"), *version = string(selection, "version");
  g_autoptr(JsonNode) current = json(root, "current-release.json", 4096, true, NULL);
  pair(json_node_get_object(current), version, gui, core);
  struct stat st; need(fstatat(root, ".desktop-installing.json", &st, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT);
  stage = "removal-proof";
  g_autofree char *proof_file = g_strdup_printf("app/removals/%s/proof.json", operation), *proof_sha = NULL;
  g_autoptr(JsonNode) proof_node = json(root, proof_file, 128 * 1024 * 1024, true, &proof_sha);
  need(!strcmp(proof_sha, expected_sha));
  JsonObject *proof = json_node_get_object(proof_node); keys(proof, "schema_version,installation_id,operation_id,source_selection,payload,core");
  need(integer(proof, "schema_version") == 1); eq(proof, "installation_id", id); eq(proof, "operation_id", operation);
  pair(object(proof, "source_selection"), version, gui, core);
  JsonObject *payload = object(proof, "payload"); keys(payload, "schema_version,platform,arch,selection,gui"); need(integer(payload, "schema_version") == 1); eq(payload, "platform", "linux"); eq(payload, "arch", "x64");
  pair(object(payload, "selection"), version, gui, core);
  JsonObject *original = object(proof, "core"); keys(original, "release,inventory,host");
  const char *inventory = string(original, "inventory");
  g_autofree char *inventory_sha = g_compute_checksum_for_string(G_CHECKSUM_SHA256, inventory, -1); need(!strcmp(inventory_sha, core));
  g_autoptr(JsonNode) index = json_text(inventory), release = json_text(string(original, "release")), host = json_text(string(original, "host"));
  JsonObject *release_obj = json_node_get_object(release), *host_obj = json_node_get_object(host);
  need(integer(release_obj, "schema_version") == 1); eq(release_obj, "inventory_sha256", core); eq(release_obj, "version", version);
  eq(release_obj, "platform", "linux"); eq(release_obj, "arch", "x64");
  need(integer(host_obj, "schema_version") == 2); eq(host_obj, "platform", "linux"); eq(host_obj, "arch", "x64");
  g_autofree char *gui_path = g_strdup_printf("app/releases/%s/crabot-desktop", gui);
  make_policy(&targets[0], install_root, id, "gui", gui, gui_path);
  JsonObject *index_obj = json_node_get_object(index); keys(index_obj, "schema_version,files"); need(integer(index_obj, "schema_version") == 1);
  JsonObject *files = object(index_obj, "files");
  g_autoptr(GList) names = json_object_get_members(files); bool found[2] = { false, false };
  for (GList *item = names; item; item = item->next) {
    const char *name = item->data; int role = -1;
    if (matches(name, "^\\.scrapling-runtime-[A-Za-z0-9.-]+-[a-f0-9]{16}-[a-f0-9]{8}/browsers/chromium-[0-9]+/chrome-linux(64)?/chrome$")) role = 0;
    if (matches(name, "^\\.scrapling-runtime-[A-Za-z0-9.-]+-[a-f0-9]{16}-[a-f0-9]{8}/browsers/chromium_headless_shell-[0-9]+/chrome-headless-shell-linux(64)?/headless_shell$")) role = 1;
    if (role < 0) continue;
    need(!found[role]); found[role] = true;
    JsonObject *entry = object(files, name); eq(entry, "type", "file");
    need(matches(string(entry, "sha256"), "^[a-f0-9]{64}$") && integer(entry, "size") >= 20);
    g_autofree char *relative = g_strdup_printf("releases/%s/%s", core, name);
    make_policy(&targets[role + 1], install_root, id, role ? "headless" : "chromium", core, relative);
  }
  need(found[0]); return found[1] ? 3 : 2;
}
static void unchanged_root(const char *root_path, int root) {
  int current = root_directory(root_path, caller); struct stat before, after;
  need(fstat(root, &before) == 0 && fstat(current, &after) == 0 && before.st_ino == after.st_ino && before.st_dev == after.st_dev); close(current);
}
static void unchanged_targets(const char *root_path, int root, Target targets[3], int count) {
  unchanged_root(root_path, root); struct stat after;
  for (int i = 0; i < count; i++) {
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
static void parse_policy(const Target *target, bool removal) {
  /* Fixed executable and clean environment; never execute the verified entries. */
  int slash = open("/", O_RDONLY | O_CLOEXEC | O_DIRECTORY); need(slash >= 0);
  int parser = open_chain(slash, "usr/sbin/apparmor_parser", 0, false, false); close(slash);
  struct stat st; need(fstat(parser, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == 0 && !(st.st_mode & 0022) && (st.st_mode & 0111));
  g_autofree char *file = g_strconcat("/etc/apparmor.d/", target->name, NULL);
  pid_t pid = fork(); need(pid >= 0);
  if (pid == 0) {
    char *args[] = { "apparmor_parser", removal ? "-R" : "-r", "-T", "-K", "--", file, NULL };
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
static bool policy_loaded(const Target *target) {
  int fd = open("/sys/kernel/security/apparmor/profiles", O_RDONLY | O_CLOEXEC | O_NOFOLLOW); need(fd >= 0);
  FILE *profiles = fdopen(fd, "r"); need(profiles != NULL);
  char line[8192]; size_t read = 0; bool loaded = false;
  while (fgets(line, sizeof line, profiles)) {
    read += strlen(line); need(read <= 8 * 1024 * 1024);
    if (!strncmp(line, target->name, strlen(target->name)) && line[strlen(target->name)] == ' ') loaded = true;
  }
  bool ok = !ferror(profiles); fclose(profiles); need(ok); return loaded;
}
static void no_known_policy_user(const Target *target, const char *install_root) {
  /* The verified Node host owns full program/descendant stop admission. Refuse
   * a positively observed original namespace entry still running. A private
   * Node/GTK maintenance copy can inherit the source GUI label without depending
   * on its userns permission; that label alone is not original-program use. */
  g_autofree char *expected = g_build_filename(install_root, target->relative, NULL);
  DIR *proc = opendir("/proc"); need(proc != NULL); struct dirent *item;
  while ((item = readdir(proc))) {
    if (!matches(item->d_name, "^[1-9][0-9]*$")) continue;
    g_autofree char *directory = g_strconcat("/proc/", item->d_name, NULL); struct stat st;
    if (stat(directory, &st) != 0 || st.st_uid != caller) continue;
    g_autofree char *image_file = g_strconcat(directory, "/exe", NULL);
    char image[4096]; ssize_t image_size = readlink(image_file, image, sizeof image - 1);
    if (image_size <= 0 || (size_t)image_size >= sizeof image - 1) continue;
    image[image_size] = 0; if (strcmp(image, expected)) continue;
    g_autofree char *file = g_strconcat(directory, "/attr/current", NULL);
    int fd = open(file, O_RDONLY | O_CLOEXEC | O_NOFOLLOW); if (fd < 0) continue;
    char label[8192]; ssize_t count = read(fd, label, sizeof label - 1); close(fd);
    if (count <= 0) continue;
    label[count] = 0;
    if (!strncmp(label, target->name, strlen(target->name)) && label[strlen(target->name)] == ' ') { closedir(proc); stage = "system-policy-in-use"; refuse(); }
  }
  closedir(proc);
}
static void remove_policy(int directory_fd, const Target *target, const char *install_root) {
  bool file = existing_policy(directory_fd, target), loaded = policy_loaded(target);
  if (!file) { need(!loaded); return; }
  no_known_policy_user(target, install_root);
  if (loaded) { stage = "system-policy-unload"; parse_policy(target, true); need(!policy_loaded(target)); }
  stage = "system-policy-remove";
  need(existing_policy(directory_fd, target));
  need(unlinkat(directory_fd, target->name, 0) == 0 && fsync(directory_fd) == 0);
  need(!existing_policy(directory_fd, target) && !policy_loaded(target));
}
static char *removal_binding(int root, bool removing) {
  g_autoptr(JsonNode) node = json(root, ".desktop-removal.json", 4096, true, NULL);
  JsonObject *record = json_node_get_object(node);
  if (removing) eq(record, "phase", "removing");
  return g_strconcat(string(record, "operation_id"), ":", string(record, "proof_sha256"), NULL);
}
static void confirm_removal(const char *install_root, int root, Target targets[3], int count) {
  g_autofree char *binding = removal_binding(root, false);
  puts("CRABOT_SANDBOX_REMOVAL_READY"); need(fflush(stdout) == 0);
  stage = "removal-confirmation";
  struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN };
  need(poll(&input, 1, 90000) > 0);
  char frame[16]; ssize_t size = read(STDIN_FILENO, frame, sizeof frame);
  need(size == 7 && !memcmp(frame, "remove\n", 7));
  unchanged_root(install_root, root);
  Target current[3] = {0}; int actual = removal_targets(install_root, root, current); need(actual == count);
  g_autofree char *after = removal_binding(root, true); need(!strcmp(binding, after));
  for (int i = 0; i < count; i++) {
    need(!strcmp(targets[i].name, current[i].name) && !strcmp(targets[i].text, current[i].text));
    g_free(current[i].relative); g_free(current[i].name); g_free(current[i].text); g_free(current[i].sha);
  }
}
int main(int argc, char **argv) {
  umask(077);
  bool update = argc == 4 && (!strcmp(argv[1], "--inspect-update") || !strcmp(argv[1], "--register-update"));
  bool inspect = (argc == 3 && !strcmp(argv[1], "--inspect")) || (update && !strcmp(argv[1], "--inspect-update"));
  bool registration = (argc == 3 && !strcmp(argv[1], "--register")) || (update && !strcmp(argv[1], "--register-update"));
  bool prepared_removal = argc == 3 && !strcmp(argv[1], "--prepare-removal");
  bool removal = prepared_removal || (argc == 3 && (!strcmp(argv[1], "--inspect-removal") || !strcmp(argv[1], "--unregister")));
  bool unregister = prepared_removal || (removal && !strcmp(argv[1], "--unregister"));
  need(inspect || registration || removal);
  if (update) need(matches(argv[3], "^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$"));
  if (registration || unregister) {
    const char *value = getenv("PKEXEC_UID");
    need(geteuid() == 0 && matches(value, "^[1-9][0-9]{0,9}$"));
    unsigned long parsed = strtoul(value, NULL, 10); need(parsed > 0 && parsed < UINT32_MAX); caller = (uid_t)parsed;
  } else { need(getuid() != 0 && getuid() == geteuid()); caller = getuid(); }
  stage = "root"; int root = root_directory(argv[2], caller); Target targets[3] = {0};
  int count = removal ? removal_targets(argv[2], root, targets) : verify_targets(argv[2], root, targets, update ? argv[3] : NULL);
  if (!removal) { stage = "entries-changed"; unchanged_targets(argv[2], root, targets, count); }
  if (unregister) {
    stage = "system-policy-conflict"; int system = system_directory();
    for (int i = 0; i < count; i++) existing_policy(system, &targets[i]);
    for (int i = 0; i < count; i++) { stage = "system-policy-unused"; no_known_policy_user(&targets[i], argv[2]); }
    if (prepared_removal) confirm_removal(argv[2], root, targets, count);
    for (int i = 0; i < count; i++) existing_policy(system, &targets[i]);
    for (int i = 0; i < count; i++) remove_policy(system, &targets[i], argv[2]);
    close(system);
  } else if (registration) {
    stage = "system-policy-conflict"; int system = system_directory();
    for (int i = 0; i < count; i++) existing_policy(system, &targets[i]);
    for (int i = 0; i < count; i++) { stage = "entries-changed"; unchanged_targets(argv[2], root, targets, count);
      stage = "system-policy-publish"; publish_policy(system, &targets[i]); stage = "system-policy-load"; parse_policy(&targets[i], false); }
    close(system);
  } else {
    for (int i = 0; i < count; i++) { printf("%s\n%s", targets[i].name, targets[i].text); }
  }
  close(root);
  for (int i = 0; i < count; i++) { g_free(targets[i].relative); g_free(targets[i].name); g_free(targets[i].text); g_free(targets[i].sha); }
  puts("CRABOT_SANDBOX_VERIFIED"); return 0;
}
