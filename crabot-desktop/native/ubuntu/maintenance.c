#define _GNU_SOURCE
#include <gtk/gtk.h>
#include <glib-unix.h>
#include <json-glib/json-glib.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>

// Display only. The verified Node owner performs all maintenance operations.
typedef struct {
  const char *kind, *message, *buttons[4], *choices[3];
  int count, cancel;
} MaintenanceDialog;
static const MaintenanceDialog dialogs[] = {
  { "retry-cancel", "Crabot 尚未卸载完成，用户数据已保留。", { "重试", "取消卸载", "暂时退出", NULL }, { "retry", "cancel", "close" }, 3, 2 },
  { "retry-repair", "程序删除已经开始，用户数据已保留。", { "继续卸载", "保留数据修复…", "暂时退出", NULL }, { "retry", "repair", "close" }, 3, 2 },
  { "completed", "应用已卸载，数据已保留。", { "关闭", "查看保留位置", NULL }, { "close", "reveal" }, 2, 0 },
  { "cancelled", "卸载已取消，程序及数据已保留。", { "知道了", NULL }, { "close" }, 1, 0 },
  { "repair", "请打开同版或更高版 Crabot 离线安装器。", { "关闭维护界面", NULL }, { "close" }, 1, 0 },
};
typedef struct {
  GtkApplication *app;
  GtkWindow *window;
  GtkLabel *status;
  GtkSpinner *spinner;
  GtkWidget *cancel;
  GByteArray *pending;
  const MaintenanceDialog *dialog;
  GCancellable *dialog_cancel;
  guint input_watch;
  gboolean cancellable, cancel_sent, failed, disconnected, closing, smoke, ready_sent;
} Maintenance;

static void failed(Maintenance *s, gboolean disconnected) {
  s->failed = TRUE; s->disconnected = disconnected; s->cancellable = FALSE;
  if (s->dialog_cancel) g_cancellable_cancel(s->dialog_cancel);
  gtk_spinner_stop(s->spinner);
  gtk_label_set_text(s->status, disconnected
    ? "维护连接已中断，无法确认操作结果。用户数据保留，请重新打开受信任的维护入口核验。"
    : "维护进度信息无效，无法确认操作结果。用户数据保留，请重新打开受信任的维护入口核验。");
  gtk_button_set_label(GTK_BUTTON(s->cancel), "关闭");
  gtk_widget_set_sensitive(s->cancel, TRUE);
}
static void cancel_requested(Maintenance *s) {
  if (!s->cancellable || s->cancel_sent || s->failed || s->disconnected || s->closing) return;
  s->cancel_sent = TRUE; s->cancellable = FALSE;
  gtk_widget_set_sensitive(s->cancel, FALSE);
  gtk_label_set_text(s->status, "正在取消并等待文件操作结束，请稍候…");
  if (fputs("{\"action\":\"cancel\"}\n", stdout) == EOF || fflush(stdout) != 0) failed(s, TRUE);
}
static gboolean close_requested(GtkWindow *window, gpointer data) {
  (void)window; Maintenance *s = data;
  if (s->failed || s->disconnected) { s->closing = TRUE; return FALSE; }
  cancel_requested(s); return TRUE;
}
static void cancel_clicked(GtkButton *button, gpointer data) {
  (void)button; Maintenance *s = data;
  if (!close_requested(s->window, s)) gtk_window_destroy(s->window);
}
static const char *string_field(JsonObject *object, const char *name) {
  JsonNode *node = json_object_get_member(object, name);
  return node && JSON_NODE_HOLDS_VALUE(node) && json_node_get_value_type(node) == G_TYPE_STRING ? json_node_get_string(node) : NULL;
}
static gboolean message_valid(const char *text) {
  if (!text || !*text || !g_utf8_validate(text, -1, NULL)) return FALSE;
  size_t units = 0;
  for (const char *c = text; *c; c = g_utf8_next_char(c)) {
    units += g_utf8_get_char(c) > 0xffff ? 2 : 1;
    if (units > 512) return FALSE;
  }
  return TRUE;
}
static void dialog_chosen(GObject *source, GAsyncResult *result, gpointer data) {
  Maintenance *s = data;
  int choice = gtk_alert_dialog_choose_finish(GTK_ALERT_DIALOG(source), result, NULL);
  const MaintenanceDialog *dialog = s->dialog; s->dialog = NULL; g_clear_object(&s->dialog_cancel);
  if (!dialog || s->failed || s->disconnected || s->closing) return;
  if (choice < 0) choice = dialog->cancel;
  if (choice >= dialog->count) { failed(s, FALSE); return; }
  if (fprintf(stdout, "{\"choice\":\"%s\"}\n", dialog->choices[choice]) < 0 || fflush(stdout) != 0) failed(s, TRUE);
}
static gboolean show_dialog(Maintenance *s, const char *kind) {
  if (!kind || s->dialog) return FALSE;
  for (size_t i = 0; i < G_N_ELEMENTS(dialogs); i++) {
    const MaintenanceDialog *choice = &dialogs[i];
    if (strcmp(kind, choice->kind)) continue;
    s->cancellable = FALSE; gtk_widget_set_sensitive(s->cancel, FALSE); gtk_spinner_stop(s->spinner);
    s->dialog = choice; s->dialog_cancel = g_cancellable_new();
    GtkAlertDialog *dialog = gtk_alert_dialog_new("%s", choice->message);
    gtk_alert_dialog_set_detail(dialog, gtk_label_get_text(s->status));
    gtk_alert_dialog_set_buttons(dialog, choice->buttons);
    gtk_alert_dialog_set_cancel_button(dialog, choice->cancel); gtk_alert_dialog_set_default_button(dialog, 0);
    gtk_alert_dialog_choose(dialog, s->window, s->dialog_cancel, dialog_chosen, s); g_object_unref(dialog);
    return TRUE;
  }
  return FALSE;
}
static gboolean frame(Maintenance *s, const char *line, gsize size) {
  if (!size || size > 4096 || s->failed || s->closing || memchr(line, '\0', size)) return FALSE;
  g_autoptr(JsonParser) parser = json_parser_new();
  if (!json_parser_load_from_data(parser, line, (gssize)size, NULL)) return FALSE;
  JsonNode *node = json_parser_get_root(parser);
  if (!node || !JSON_NODE_HOLDS_OBJECT(node)) return FALSE;
  JsonObject *object = json_node_get_object(node);
  const char *type = string_field(object, "type");
  if (!g_strcmp0(type, "close") && json_object_get_size(object) == 1) {
    s->closing = TRUE; if (s->dialog_cancel) g_cancellable_cancel(s->dialog_cancel); gtk_window_destroy(s->window); return TRUE;
  }
  if (!g_strcmp0(type, "dialog") && json_object_get_size(object) == 2) return show_dialog(s, string_field(object, "kind"));
  if (s->dialog) return FALSE;
  JsonNode *allow = json_object_get_member(object, "cancellable");
  const char *message = string_field(object, "message");
  if (g_strcmp0(type, "progress") || json_object_get_size(object) != 3 || !message_valid(message)
    || !allow || !JSON_NODE_HOLDS_VALUE(allow) || json_node_get_value_type(allow) != G_TYPE_BOOLEAN) return FALSE;
  // A late progress frame cannot re-enable a cancellation already requested.
  s->cancellable = json_node_get_boolean(allow) && !s->cancel_sent;
  if (!s->cancel_sent) gtk_label_set_text(s->status, message);
  gtk_widget_set_sensitive(s->cancel, s->cancellable);
  return TRUE;
}
static gboolean consume(Maintenance *s, const char *bytes, gsize size) {
  for (gsize i = 0; i < size; i++) {
    if (bytes[i] == '\n') {
      if (!frame(s, (const char *)s->pending->data, s->pending->len)) { failed(s, FALSE); return FALSE; }
      g_byte_array_set_size(s->pending, 0);
      if (s->closing) return FALSE;
    } else {
      if (!bytes[i] || s->pending->len >= 4096) { failed(s, FALSE); return FALSE; }
      g_byte_array_append(s->pending, (const guint8 *)&bytes[i], 1);
    }
  }
  return TRUE;
}
static gboolean read_input(gint fd, GIOCondition condition, gpointer data) {
  Maintenance *s = data; char bytes[512];
  if (condition & (G_IO_ERR | G_IO_NVAL)) { failed(s, TRUE); s->input_watch = 0; return G_SOURCE_REMOVE; }
  ssize_t count = read(fd, bytes, sizeof bytes);
  if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return G_SOURCE_CONTINUE;
  if (count <= 0) { failed(s, TRUE); s->input_watch = 0; return G_SOURCE_REMOVE; }
  if (!consume(s, bytes, (gsize)count)) { s->input_watch = 0; return G_SOURCE_REMOVE; }
  return G_SOURCE_CONTINUE;
}
static void mapped(GtkWidget *widget, gpointer data) {
  (void)widget; Maintenance *s = data;
  if (s->ready_sent || s->failed || s->closing) return;
  s->ready_sent = TRUE;
  if (fputs("{\"event\":\"ready\"}\n", stdout) == EOF || fflush(stdout) != 0) failed(s, TRUE);
}
static gboolean smoke_finished(gpointer data) {
  Maintenance *s = data;
  puts("CRABOT_NATIVE_MAINTENANCE_WINDOW_READY"); fflush(stdout);
  s->closing = TRUE; gtk_window_destroy(s->window); return G_SOURCE_REMOVE;
}
static void activate(GtkApplication *app, gpointer data) {
  Maintenance *s = data;
  if (s->window) { gtk_window_present(s->window); return; }
  s->window = GTK_WINDOW(gtk_application_window_new(app));
  gtk_window_set_title(s->window, "卸载 Crabot"); gtk_window_set_default_size(s->window, 560, 300);
  gtk_window_set_resizable(s->window, FALSE);
  GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 18);
  gtk_widget_set_margin_start(box, 28); gtk_widget_set_margin_end(box, 28);
  gtk_widget_set_margin_top(box, 28); gtk_widget_set_margin_bottom(box, 28);
  gtk_window_set_child(s->window, box);
  GtkWidget *heading = gtk_label_new("正在卸载 Crabot"); gtk_widget_add_css_class(heading, "title-1");
  gtk_label_set_xalign(GTK_LABEL(heading), 0); gtk_box_append(GTK_BOX(box), heading);
  s->status = GTK_LABEL(gtk_label_new("正在核验原安装，用户数据将保留…"));
  gtk_label_set_wrap(s->status, TRUE); gtk_label_set_xalign(s->status, 0);
  gtk_widget_set_vexpand(GTK_WIDGET(s->status), TRUE); gtk_box_append(GTK_BOX(box), GTK_WIDGET(s->status));
  GtkWidget *row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 12); gtk_box_append(GTK_BOX(box), row);
  s->spinner = GTK_SPINNER(gtk_spinner_new()); gtk_spinner_start(s->spinner); gtk_box_append(GTK_BOX(row), GTK_WIDGET(s->spinner));
  s->cancel = gtk_button_new_with_label("取消"); gtk_widget_set_sensitive(s->cancel, FALSE);
  gtk_box_append(GTK_BOX(row), s->cancel);
  g_signal_connect(s->cancel, "clicked", G_CALLBACK(cancel_clicked), s);
  g_signal_connect(s->window, "close-request", G_CALLBACK(close_requested), s);
  g_signal_connect(s->window, "map", G_CALLBACK(mapped), s);
  gtk_window_present(s->window);
  if (s->smoke) g_timeout_add(800, smoke_finished, s);
  else s->input_watch = g_unix_fd_add(STDIN_FILENO, G_IO_IN | G_IO_HUP | G_IO_ERR | G_IO_NVAL, read_input, s);
}
int main(int argc, char **argv) {
  if (getuid() == 0 || getuid() != geteuid()) { fputs("Crabot maintenance must run as the desktop user.\n", stderr); return 1; }
  gboolean smoke = argc == 2 && !strcmp(argv[1], "--smoke-test");
  if (argc != 1 && !smoke) return 1;
  struct rlimit core = {0, 0}; if (setrlimit(RLIMIT_CORE, &core) != 0) return 1;
  signal(SIGPIPE, SIG_IGN);
  int flags = fcntl(STDIN_FILENO, F_GETFL);
  if (!smoke && (flags < 0 || fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) < 0)) return 1;
  Maintenance s = {0}; s.pending = g_byte_array_new(); s.smoke = smoke;
  s.app = gtk_application_new("com.crabot.maintenance", G_APPLICATION_NON_UNIQUE);
  g_signal_connect(s.app, "activate", G_CALLBACK(activate), &s);
  int result = g_application_run(G_APPLICATION(s.app), 1, argv);
  if (s.input_watch) g_source_remove(s.input_watch);
  g_clear_object(&s.dialog_cancel); g_object_unref(s.app); g_byte_array_unref(s.pending);
  return s.failed ? 1 : result;
}
