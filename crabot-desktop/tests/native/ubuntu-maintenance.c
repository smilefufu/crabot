#define main maintenance_product_main
#include "../../native/ubuntu/maintenance.c"
#undef main

static Maintenance state(void) {
  Maintenance s = {0};
  s.window = GTK_WINDOW(gtk_window_new()); g_object_ref_sink(s.window);
  GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4); gtk_window_set_child(s.window, box);
  s.status = GTK_LABEL(gtk_label_new("initial")); s.spinner = GTK_SPINNER(gtk_spinner_new());
  s.cancel = gtk_button_new_with_label("取消"); gtk_widget_set_sensitive(s.cancel, FALSE);
  gtk_box_append(GTK_BOX(box), GTK_WIDGET(s.status)); gtk_box_append(GTK_BOX(box), GTK_WIDGET(s.spinner)); gtk_box_append(GTK_BOX(box), s.cancel);
  s.pending = g_byte_array_new();
  return s;
}
static void clear(Maintenance *s) { gtk_window_destroy(s->window); g_object_unref(s->window); g_byte_array_unref(s->pending); }
static gboolean accept(Maintenance *s, const char *text) { return consume(s, text, strlen(text)); }
static void progress(void) {
  Maintenance s = state();
  g_assert_true(accept(&s, "{\"type\":\"progress\",\"message\":\"正在核验 <程序>\",\"cancellable\":false}\n"));
  g_assert_cmpstr(gtk_label_get_text(s.status), ==, "正在核验 <程序>");
  g_assert_false(gtk_widget_get_sensitive(s.cancel)); g_assert_false(s.cancellable);
  g_assert_true(close_requested(s.window, &s)); g_assert_false(s.cancel_sent);
  g_assert_true(accept(&s, "{\"type\":\"progress\",\"message\":\"ready\",\"cancellable\":true}\n"));
  g_assert_true(gtk_widget_get_sensitive(s.cancel));
  clear(&s);
}
static void cancellation(void) {
  Maintenance s = state(); int pipes[2]; g_assert_cmpint(pipe(pipes), ==, 0);
  g_assert_cmpint(fflush(stdout), ==, 0);
  int original = dup(STDOUT_FILENO); g_assert_cmpint(original, >=, 0);
  g_assert_cmpint(dup2(pipes[1], STDOUT_FILENO), >=, 0); close(pipes[1]);
  g_assert_true(accept(&s, "{\"type\":\"progress\",\"message\":\"ready\",\"cancellable\":true}\n"));
  g_assert_true(close_requested(s.window, &s)); cancel_requested(&s);
  g_assert_true(s.cancel_sent); g_assert_false(s.cancellable); g_assert_false(gtk_widget_get_sensitive(s.cancel));
  g_assert_true(accept(&s, "{\"type\":\"progress\",\"message\":\"late\",\"cancellable\":true}\n"));
  g_assert_false(s.cancellable); g_assert_false(gtk_widget_get_sensitive(s.cancel));
  g_assert_cmpstr(gtk_label_get_text(s.status), !=, "late");
  g_assert_cmpint(dup2(original, STDOUT_FILENO), >=, 0); close(original);
  char result[128] = {0}; g_assert_cmpint(read(pipes[0], result, sizeof result - 1), ==, 20); close(pipes[0]);
  g_assert_cmpstr(result, ==, "{\"action\":\"cancel\"}\n");
  clear(&s);
}
static void readiness(void) {
  Maintenance s = state(); int pipes[2]; g_assert_cmpint(pipe(pipes), ==, 0); g_assert_cmpint(fflush(stdout), ==, 0);
  int original = dup(STDOUT_FILENO); g_assert_cmpint(original, >=, 0); g_assert_cmpint(dup2(pipes[1], STDOUT_FILENO), >=, 0); close(pipes[1]);
  mapped(GTK_WIDGET(s.window), &s); mapped(GTK_WIDGET(s.window), &s);
  g_assert_true(s.ready_sent); g_assert_false(s.cancellable);
  g_assert_cmpint(dup2(original, STDOUT_FILENO), >=, 0); close(original);
  const char *expected = "{\"event\":\"ready\"}\n"; char result[64] = {0};
  g_assert_cmpint(read(pipes[0], result, sizeof result - 1), ==, (ssize_t)strlen(expected)); close(pipes[0]);
  g_assert_cmpstr(result, ==, expected); clear(&s);
}
static void invalid(void) {
  const char *frames[] = { "[]\n", "{}\n", "\n", "{broken}\n",
    "{\"type\":\"progress\",\"message\":\"\",\"cancellable\":true}\n",
    "{\"type\":\"progress\",\"message\":5,\"cancellable\":true}\n",
    "{\"type\":\"progress\",\"message\":\"ready\",\"cancellable\":1}\n",
    "{\"type\":\"progress\",\"message\":\"ready\",\"cancellable\":true,\"path\":\"/tmp\"}\n",
    "{\"type\":\"close\",\"path\":\"/tmp\"}\n", "{\"type\":\"launch\"}\n", NULL };
  for (size_t i = 0; frames[i]; i++) {
    Maintenance s = state(); g_assert_false(accept(&s, frames[i])); g_assert_true(s.failed);
    g_assert_false(s.cancellable); cancel_requested(&s); g_assert_false(s.cancel_sent);
    g_assert_false(accept(&s, "{\"type\":\"progress\",\"message\":\"ready\",\"cancellable\":true}\n"));
    g_assert_false(s.cancellable); g_assert_false(close_requested(s.window, &s));
    g_assert_nonnull(strstr(gtk_label_get_text(s.status), "无法确认操作结果")); clear(&s);
  }
}
static void limits(void) {
  g_autofree char *ascii = g_strnfill(512, 'x'); g_assert_true(message_valid(ascii));
  g_autofree char *long_ascii = g_strnfill(513, 'x'); g_assert_false(message_valid(long_ascii));
  GString *emoji = g_string_new(NULL); for (size_t i = 0; i < 256; i++) g_string_append(emoji, "🦀");
  g_assert_true(message_valid(emoji->str)); g_string_append(emoji, "🦀"); g_assert_false(message_valid(emoji->str)); g_string_free(emoji, TRUE);
  Maintenance s = state(); g_autofree char *large = g_strnfill(4097, 'x');
  g_assert_false(consume(&s, large, 4097)); g_assert_true(s.failed); g_assert_cmpuint(s.pending->len, ==, 4096); clear(&s);
  s = state(); char nul[] = {'{', 0, '}'}; g_assert_false(consume(&s, nul, sizeof nul)); g_assert_true(s.failed); clear(&s);
}
static void fragmented(void) {
  Maintenance s = state(); const char *line = "{\"type\":\"progress\",\"message\":\"核验🦀\",\"cancellable\":false}\n";
  for (size_t i = 0; i < strlen(line); i++) g_assert_true(consume(&s, line + i, 1));
  g_assert_cmpstr(gtk_label_get_text(s.status), ==, "核验🦀"); g_assert_cmpuint(s.pending->len, ==, 0);
  g_assert_true(accept(&s, "{\"type\":\"progress\",\"message\":\"first\",\"cancellable\":true}\n{\"type\":\"progress\",\"message\":\"last\",\"cancellable\":false}\n"));
  g_assert_cmpstr(gtk_label_get_text(s.status), ==, "last"); g_assert_false(s.cancellable); clear(&s);
}
static void disconnected(void) {
  Maintenance s = state(); int pipes[2]; g_assert_cmpint(pipe(pipes), ==, 0); close(pipes[1]);
  g_assert_true(accept(&s, "{\"type\":\"progress\",\"message\":\"ready\",\"cancellable\":true}\n"));
  g_assert_cmpint(read_input(pipes[0], G_IO_HUP, &s), ==, G_SOURCE_REMOVE); close(pipes[0]);
  g_assert_true(s.failed); g_assert_true(s.disconnected); g_assert_false(s.cancellable);
  cancel_requested(&s); g_assert_false(s.cancel_sent);
  g_assert_nonnull(strstr(gtk_label_get_text(s.status), "连接已中断")); g_assert_false(close_requested(s.window, &s)); clear(&s);
}
static void closed(void) {
  Maintenance s = state(); g_assert_false(accept(&s, "{\"type\":\"close\"}\n"));
  g_assert_true(s.closing); g_assert_false(s.failed); g_assert_false(s.cancel_sent); clear(&s);
}
int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL); gtk_init();
  g_test_add_func("/maintenance/progress", progress); g_test_add_func("/maintenance/cancellation", cancellation);
  g_test_add_func("/maintenance/invalid", invalid); g_test_add_func("/maintenance/limits", limits);
  g_test_add_func("/maintenance/fragmented", fragmented); g_test_add_func("/maintenance/disconnected", disconnected);
  g_test_add_func("/maintenance/close", closed); g_test_add_func("/maintenance/readiness", readiness);
  return g_test_run();
}
