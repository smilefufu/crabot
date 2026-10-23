#define _GNU_SOURCE
#include <gtk/gtk.h>
#include <json-glib/json-glib.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>

typedef struct {
  GtkApplication *app;
  GtkWindow *window;
  GtkEntry *destination;
  GtkLabel *status;
  GtkSpinner *spinner;
  GtkWidget *choose, *install, *cancel, *open;
  GSubprocess *backend, *authorization;
  GDataInputStream *output;
  char *bundle, *selected, *executable;
  gboolean busy, failed, complete, cancelling, finalizing, smoke;
} Installer;
static void status(Installer *s, const char *text) { gtk_label_set_text(s->status, text); }
static void busy(Installer *s, gboolean value) {
  s->busy = value;
  gtk_widget_set_sensitive(GTK_WIDGET(s->destination), !value && !s->complete);
  gtk_widget_set_sensitive(s->choose, !value && !s->complete);
  gtk_widget_set_sensitive(s->install, !value && !s->complete);
  gtk_widget_set_sensitive(s->cancel, TRUE);
  gtk_button_set_label(GTK_BUTTON(s->cancel), value ? "取消安装" : "关闭");
  if (value) gtk_spinner_start(s->spinner); else gtk_spinner_stop(s->spinner);
}
static void action(Installer *s, const char *value) {
  if (!s->backend) return;
  GOutputStream *input = g_subprocess_get_stdin_pipe(s->backend);
  g_autofree char *frame = g_strdup_printf("{\"action\":\"%s\"}\n", value);
  if (!g_output_stream_write_all(input, frame, strlen(frame), NULL, NULL, NULL)) s->failed = TRUE;
}
static GSubprocessLauncher *launcher(GSubprocessFlags flags) {
  GSubprocessLauncher *launch = g_subprocess_launcher_new(flags);
  const char *names[] = { "HOME", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "LANG", "LC_ALL", "LC_CTYPE",
    "GTK_IM_MODULE", "QT_IM_MODULE", "XMODIFIERS", "SSH_AUTH_SOCK", NULL };
  char *empty[] = { NULL }; g_subprocess_launcher_set_environ(launch, empty);
  for (size_t i = 0; names[i]; i++) { const char *value = g_getenv(names[i]); if (value) g_subprocess_launcher_setenv(launch, names[i], value, TRUE); }
  g_subprocess_launcher_setenv(launch, "PATH", "/usr/bin:/bin", TRUE);
  g_subprocess_launcher_setenv(launch, "PYTHONNOUSERSITE", "1", TRUE);
  return launch;
}
static void authorization_finished(GObject *source, GAsyncResult *result, gpointer data) {
  Installer *s = data;
  gboolean accepted = g_subprocess_wait_check_finish(G_SUBPROCESS(source), result, NULL);
  g_clear_object(&s->authorization);
  if (s->backend) {
    if (accepted && !s->cancelling) { status(s, "系统授权已完成，正在重新核验实际沙箱与网络…"); action(s, "authorized"); }
    else { status(s, "系统授权未完成，安装尚未就绪。准备记录和原数据已保留，可再次尝试。"); action(s, "denied"); }
  }
}
static void permission_chosen(GObject *source, GAsyncResult *result, gpointer data) {
  Installer *s = data;
  int choice = gtk_alert_dialog_choose_finish(GTK_ALERT_DIALOG(source), result, NULL);
  if (choice != 1 || s->cancelling || !s->backend) { action(s, "denied"); return; }
  char *root = realpath(s->selected, NULL);
  if (!root) { action(s, "denied"); return; }
  g_autofree char *helper = g_build_filename(s->bundle, "crabot-sandbox-helper", NULL);
  g_autoptr(GSubprocessLauncher) launch = launcher(G_SUBPROCESS_FLAGS_STDOUT_SILENCE | G_SUBPROCESS_FLAGS_STDERR_SILENCE);
  s->authorization = g_subprocess_launcher_spawn(launch, NULL, "/usr/bin/pkexec", helper, "--register", root, NULL);
  free(root);
  if (!s->authorization) { action(s, "denied"); return; }
  status(s, "请在 Ubuntu 系统窗口中完成管理员授权。拒绝授权可保留进度后重试。");
  g_subprocess_wait_check_async(s->authorization, NULL, authorization_finished, s);
}
static const char *failure_text(const char *code) {
  if (!g_strcmp0(code, "CANCELLED")) return "安装已取消，准备记录已保留。可以使用同一安装包与位置继续。";
  if (!g_strcmp0(code, "ENOSPC") || !g_strcmp0(code, "CRABOT_UPDATE_SPACE")) return "磁盘空间不足。原目录已保留，请释放空间或选择其它安装位置。";
  if (!g_strcmp0(code, "CRABOT_CORE_INTEGRITY")) return "离线安装包不完整或已改变，请重新获取完整安装包。";
  if (!g_strcmp0(code, "CRABOT_INSTALL_FILESYSTEM")) return "请选择支持私有文件权限的本机持久卷；当前文件夹不适合安装。";
  if (!g_strcmp0(code, "CRABOT_INSTALL_SYSTEM_MODE")) return "此机器由管理员统一部署，请通过浏览器或渠道使用 Crabot。现有实例未改变。";
  if (!g_strcmp0(code, "CRABOT_DESKTOP_TAKEOVER_REQUIRED")) return "检测到已有 Crabot 部署，需要沿用原位置接管。原数据保留，未创建新实例。";
  if (!g_strcmp0(code, "CRABOT_INSTALL_REGISTRATION")) return "系统应用入口与已有文件冲突。原文件已保留，请核对原安装后重试。";
  if (!g_strcmp0(code, "CRABOT_INSTALL_PROGRAM_IDENTITY")) return "安装程序或内置浏览器未通过身份校验。原文件已保留，请重新获取完整安装包。";
  if (!g_strcmp0(code, "CRABOT_INSTALL_GUI_SANDBOX")) return "应用沙箱验证未通过。请检查 Ubuntu 系统授权和桌面组件，再使用此安装包重试。";
  if (!g_strcmp0(code, "CRABOT_INSTALL_BROWSER_SANDBOX")) return "内置浏览器的沙箱或网络检查未通过。准备记录已保留，请检查系统限制后重试。";
  if (!g_strcmp0(code, "CRABOT_INSTALL_SYSTEM_AUTHORIZATION")) return "系统授权或 Crabot 专属沙箱规则登记尚未完成。原规则和准备记录已保留，可以重试。";
  return "安装尚未就绪。请核对安装包、位置、系统授权和沙箱条件后重试；原数据及准备记录已保留。";
}
static const char *progress_text(const char *phase) {
  if (!g_strcmp0(phase, "verifying")) return "正在核验离线安装组件…";
  if (!g_strcmp0(phase, "copying")) return "正在安装 Crabot 与内置运行环境…";
  if (!g_strcmp0(phase, "prepared")) return "程序已准备，正在核验安装结果…";
  if (!g_strcmp0(phase, "sandbox")) return "正在检查应用、内置浏览器的真实沙箱与网络…";
  if (!g_strcmp0(phase, "registering")) return "正在登记系统应用入口并完成安装…";
  return NULL;
}
static const char *field(JsonObject *object, const char *name) {
  JsonNode *node = json_object_get_member(object, name);
  return node && JSON_NODE_HOLDS_VALUE(node) && json_node_get_value_type(node) == G_TYPE_STRING ? json_node_get_string(node) : NULL;
}
static gboolean frame(Installer *s, const char *line, gsize size) {
  if (!size || size > 65536) return FALSE;
  g_autoptr(JsonParser) parser = json_parser_new();
  if (!json_parser_load_from_data(parser, line, (gssize)size, NULL)) return FALSE;
  JsonNode *node = json_parser_get_root(parser); if (!node || !JSON_NODE_HOLDS_OBJECT(node)) return FALSE;
  JsonObject *object = json_node_get_object(node); const char *type = field(object, "type");
  if (!g_strcmp0(type, "progress")) {
    const char *text = progress_text(field(object, "phase")); if (!text || s->complete) return FALSE;
    if (!s->cancelling) status(s, text);
    if (!g_strcmp0(field(object, "phase"), "registering")) { s->finalizing = TRUE; gtk_widget_set_sensitive(s->cancel, FALSE); }
  } else if (!g_strcmp0(type, "authorization_required")) {
    if (s->authorization || s->complete || s->cancelling) { action(s, "denied"); return TRUE; }
    GtkAlertDialog *dialog = gtk_alert_dialog_new("Ubuntu 需要为 Crabot 登记专属沙箱权限");
    gtk_alert_dialog_set_detail(dialog, "仅为本安装的应用和内置浏览器开启必要权限，保留系统保护。不安装常驻管理员服务。接下来由 Ubuntu 验证管理员身份。");
    const char *buttons[] = { "暂不授权", "授权并继续", NULL };
    gtk_alert_dialog_set_buttons(dialog, buttons); gtk_alert_dialog_set_cancel_button(dialog, 0); gtk_alert_dialog_set_default_button(dialog, 1);
    gtk_alert_dialog_choose(dialog, s->window, NULL, permission_chosen, s); g_object_unref(dialog);
  } else if (!g_strcmp0(type, "failed")) { s->failed = TRUE; status(s, failure_text(field(object, "code"))); }
  else if (!g_strcmp0(type, "complete")) {
    const char *executable = field(object, "executable"); char *root = realpath(s->selected, NULL);
    if (!root || !executable) { free(root); return FALSE; }
    g_autofree char *escaped = g_regex_escape_string(root, -1);
    g_autofree char *pattern = g_strdup_printf("^%s/app/releases/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/crabot-desktop$", escaped);
    free(root); if (!g_regex_match_simple(pattern, executable, 0, 0) || s->failed || s->complete) return FALSE;
    s->executable = g_strdup(executable); s->complete = TRUE;
    status(s, "Crabot 已安装并通过沙箱检查。打开应用后配置模型即可开始使用。");
  } else return FALSE;
  return TRUE;
}
static void backend_finished(GObject *source, GAsyncResult *result, gpointer data) {
  Installer *s = data;
  gboolean ok = g_subprocess_wait_check_finish(G_SUBPROCESS(source), result, NULL);
  if (!ok || !s->complete) { if (!s->failed) status(s, failure_text(NULL)); s->complete = FALSE; }
  g_clear_object(&s->output); g_clear_object(&s->backend); s->cancelling = FALSE;
  busy(s, FALSE); gtk_widget_set_visible(s->open, s->complete);
  if (!s->complete) gtk_button_set_label(GTK_BUTTON(s->install), "重试安装");
}
static void read_frame(GObject *source, GAsyncResult *result, gpointer data) {
  Installer *s = data; gsize size = 0;
  g_autoptr(GError) error = NULL;
  g_autofree char *line = g_data_input_stream_read_line_finish(G_DATA_INPUT_STREAM(source), result, &size, &error);
  if (!line) { if (error) s->failed = TRUE; g_subprocess_wait_check_async(s->backend, NULL, backend_finished, s); return; }
  if (!frame(s, line, size)) { s->failed = TRUE; status(s, failure_text(NULL)); action(s, "cancel"); }
  g_data_input_stream_read_line_async(s->output, G_PRIORITY_DEFAULT, NULL, read_frame, s);
}
static void start_install(Installer *s) {
  if (s->busy || s->complete) return;
  const char *chosen = gtk_editable_get_text(GTK_EDITABLE(s->destination));
  if (!chosen || !g_path_is_absolute(chosen) || strlen(chosen) >= 3000 || strpbrk(chosen, "\r\n")) { status(s, "请选择本机的绝对文件夹位置。"); return; }
  g_clear_pointer(&s->selected, g_free); s->selected = g_canonicalize_filename(chosen, NULL);
  gtk_editable_set_text(GTK_EDITABLE(s->destination), s->selected);
  g_autofree char *node = g_build_filename(s->bundle, "offline/core/.product-runtime/node/bin/node", NULL);
  g_autofree char *backend = g_build_filename(s->bundle, "backend/dist/ubuntu-installer-backend.js", NULL);
  g_autoptr(GSubprocessLauncher) launch = launcher(G_SUBPROCESS_FLAGS_STDIN_PIPE | G_SUBPROCESS_FLAGS_STDOUT_PIPE | G_SUBPROCESS_FLAGS_STDERR_SILENCE);
  s->backend = g_subprocess_launcher_spawn(launch, NULL, node, backend, s->selected, NULL);
  if (!s->backend) { status(s, "无法打开内置安装组件。请重新获取完整离线安装包，无需安装系统 Node。"); return; }
  s->failed = FALSE; s->cancelling = FALSE; s->finalizing = FALSE; busy(s, TRUE); status(s, "正在核验离线安装组件…");
  s->output = g_data_input_stream_new(g_subprocess_get_stdout_pipe(s->backend));
  g_data_input_stream_set_newline_type(s->output, G_DATA_STREAM_NEWLINE_TYPE_LF);
  g_data_input_stream_read_line_async(s->output, G_PRIORITY_DEFAULT, NULL, read_frame, s);
}
static void install_clicked(GtkButton *button, gpointer data) { (void)button; start_install(data); }
static void folder_chosen(GObject *source, GAsyncResult *result, gpointer data) {
  Installer *s = data; g_autoptr(GFile) file = gtk_file_dialog_select_folder_finish(GTK_FILE_DIALOG(source), result, NULL);
  if (!file || s->busy || s->complete) return;
  g_autofree char *path = g_file_get_path(file); if (path) gtk_editable_set_text(GTK_EDITABLE(s->destination), path);
}
static void choose_clicked(GtkButton *button, gpointer data) {
  (void)button; Installer *s = data;
  GtkFileDialog *dialog = gtk_file_dialog_new(); gtk_file_dialog_set_title(dialog, "选择 Crabot 整体安装文件夹");
  gtk_file_dialog_set_accept_label(dialog, "安装到这里");
  g_autoptr(GFile) folder = g_file_new_for_path(gtk_editable_get_text(GTK_EDITABLE(s->destination)));
  gtk_file_dialog_set_initial_folder(dialog, folder); gtk_file_dialog_select_folder(dialog, s->window, NULL, folder_chosen, s); g_object_unref(dialog);
}
static gboolean close_requested(GtkWindow *window, gpointer data) {
  (void)window; Installer *s = data;
  if (!s->busy) return FALSE;
  if (s->finalizing) { status(s, "正在完成安装，完成后即可关闭。请稍候…"); return TRUE; }
  if (!s->cancelling) { s->cancelling = TRUE; action(s, "cancel"); }
  status(s, s->authorization ? "正在取消。请在系统授权窗口中选择取消；原数据与准备记录保留。" : "正在取消安装并保留准备记录，请稍候…");
  return TRUE;
}
static void cancel_clicked(GtkButton *button, gpointer data) { (void)button; Installer *s = data; if (!close_requested(s->window, s)) gtk_window_destroy(s->window); }
static void open_clicked(GtkButton *button, gpointer data) {
  (void)button; Installer *s = data; if (!s->complete || !s->executable) return;
  g_autoptr(GSubprocessLauncher) launch = launcher(G_SUBPROCESS_FLAGS_STDOUT_SILENCE | G_SUBPROCESS_FLAGS_STDERR_SILENCE);
  g_autoptr(GSubprocess) child = g_subprocess_launcher_spawn(launch, NULL, s->executable, NULL);
  if (child) gtk_window_destroy(s->window); else status(s, "Crabot 已安装。暂未打开，可从系统应用入口重试。");
}
static gboolean smoke_finished(gpointer data) { Installer *s = data; puts("CRABOT_NATIVE_INSTALLER_WINDOW_READY"); gtk_window_destroy(s->window); return G_SOURCE_REMOVE; }
static void activate(GtkApplication *app, gpointer data) {
  Installer *s = data;
  if (s->window) { gtk_window_present(s->window); return; }
  s->window = GTK_WINDOW(gtk_application_window_new(app)); gtk_window_set_title(s->window, "安装 Crabot"); gtk_window_set_default_size(s->window, 600, 380);
  GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 16); gtk_widget_set_margin_start(box, 28); gtk_widget_set_margin_end(box, 28);
  gtk_widget_set_margin_top(box, 28); gtk_widget_set_margin_bottom(box, 28); gtk_window_set_child(s->window, box);
  GtkWidget *heading = gtk_label_new("欢迎安装 Crabot"); gtk_widget_add_css_class(heading, "title-1"); gtk_label_set_xalign(GTK_LABEL(heading), 0); gtk_box_append(GTK_BOX(box), heading);
  GtkWidget *detail = gtk_label_new("已包含 Node、Python 和浏览器，无需额外安装。\n程序、运行环境与数据存入所选文件夹；工作区可在安装后调整。");
  gtk_label_set_wrap(GTK_LABEL(detail), TRUE); gtk_label_set_xalign(GTK_LABEL(detail), 0); gtk_box_append(GTK_BOX(box), detail);
  s->destination = GTK_ENTRY(gtk_entry_new()); g_autofree char *initial = g_build_filename(g_get_home_dir(), "Crabot", NULL);
  gtk_editable_set_text(GTK_EDITABLE(s->destination), initial); gtk_box_append(GTK_BOX(box), GTK_WIDGET(s->destination));
  s->choose = gtk_button_new_with_label("选择安装文件夹…"); gtk_widget_set_halign(s->choose, GTK_ALIGN_START); gtk_box_append(GTK_BOX(box), s->choose);
  s->status = GTK_LABEL(gtk_label_new("确认位置后点击安装。取消选址不会停止任何 Crabot 实例。")); gtk_label_set_wrap(s->status, TRUE); gtk_label_set_xalign(s->status, 0); gtk_widget_set_vexpand(GTK_WIDGET(s->status), TRUE); gtk_box_append(GTK_BOX(box), GTK_WIDGET(s->status));
  GtkWidget *row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 12); gtk_box_append(GTK_BOX(box), row);
  s->spinner = GTK_SPINNER(gtk_spinner_new()); gtk_box_append(GTK_BOX(row), GTK_WIDGET(s->spinner));
  s->cancel = gtk_button_new_with_label("关闭"); s->install = gtk_button_new_with_label("安装"); s->open = gtk_button_new_with_label("打开 Crabot");
  gtk_widget_add_css_class(s->install, "suggested-action"); gtk_widget_add_css_class(s->open, "suggested-action");
  gtk_box_append(GTK_BOX(row), s->cancel); gtk_box_append(GTK_BOX(row), s->install); gtk_box_append(GTK_BOX(row), s->open); gtk_widget_set_visible(s->open, FALSE);
  g_signal_connect(s->choose, "clicked", G_CALLBACK(choose_clicked), s); g_signal_connect(s->install, "clicked", G_CALLBACK(install_clicked), s);
  g_signal_connect(s->cancel, "clicked", G_CALLBACK(cancel_clicked), s); g_signal_connect(s->open, "clicked", G_CALLBACK(open_clicked), s);
  g_signal_connect(s->window, "close-request", G_CALLBACK(close_requested), s); gtk_window_present(s->window);
  if (s->smoke) g_timeout_add(800, smoke_finished, s);
}
int main(int argc, char **argv) {
  if (getuid() == 0 || getuid() != geteuid()) { fputs("Crabot installer must run as the desktop user.\n", stderr); return 1; }
  gboolean smoke = argc == 2 && !strcmp(argv[1], "--smoke-test"); if (argc != 1 && !smoke) return 1;
  struct rlimit core = {0, 0}; if (setrlimit(RLIMIT_CORE, &core) != 0) return 1;
  char self[PATH_MAX]; ssize_t count = readlink("/proc/self/exe", self, sizeof self - 1); if (count <= 0 || count >= (ssize_t)sizeof self - 1) return 1; self[count] = 0;
  Installer state = {0}; state.bundle = g_path_get_dirname(self); state.smoke = smoke;
  state.app = gtk_application_new("com.crabot.installer", G_APPLICATION_NON_UNIQUE);
  g_signal_connect(state.app, "activate", G_CALLBACK(activate), &state);
  int result = g_application_run(G_APPLICATION(state.app), 1, argv);
  g_object_unref(state.app); g_free(state.bundle); g_free(state.selected); g_free(state.executable); return result;
}
