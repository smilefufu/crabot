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
static void clear(Maintenance *s) {
  if (s->dialog_cancel) g_cancellable_cancel(s->dialog_cancel);
  gint64 deadline = g_get_monotonic_time() + 5 * G_USEC_PER_SEC;
  while (s->dialog && g_get_monotonic_time() < deadline) { g_main_context_iteration(NULL, FALSE); g_usleep(1000); }
  g_assert_null(s->dialog); g_clear_object(&s->dialog_cancel);
  gtk_window_destroy(s->window); g_object_unref(s->window); g_byte_array_unref(s->pending); }
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
static GtkWidget *find_button(GtkWidget *widget, const char *label) {
  if (GTK_IS_BUTTON(widget) && !g_strcmp0(gtk_button_get_label(GTK_BUTTON(widget)), label)) return widget;
  for (GtkWidget *child = gtk_widget_get_first_child(widget); child; child = gtk_widget_get_next_sibling(child)) {
    GtkWidget *found = find_button(child, label); if (found) return found;
  }
  return NULL;
}
static void dialog_choices(void) {
  for (size_t i = 0; i < G_N_ELEMENTS(dialogs); i++) {
    const MaintenanceDialog *dialog = &dialogs[i];
    for (int choice = 0; choice < dialog->count; choice++) {
      Maintenance s = state(); gtk_window_present(s.window);
      int pipes[2]; g_assert_cmpint(pipe(pipes), ==, 0); g_assert_cmpint(fflush(stdout), ==, 0);
      int original = dup(STDOUT_FILENO); g_assert_cmpint(original, >=, 0); g_assert_cmpint(dup2(pipes[1], STDOUT_FILENO), >=, 0); close(pipes[1]);
      g_autofree char *request = g_strdup_printf("{\"type\":\"dialog\",\"kind\":\"%s\"}\n", dialog->kind);
      g_assert_true(accept(&s, request)); g_assert_nonnull(s.dialog); g_assert_false(s.cancellable);
      gboolean clicked = FALSE; gint64 deadline = g_get_monotonic_time() + 5 * G_USEC_PER_SEC;
      while (s.dialog && g_get_monotonic_time() < deadline) {
        g_main_context_iteration(NULL, FALSE);
        GListModel *windows = gtk_window_get_toplevels();
        for (guint j = 0; !clicked && j < g_list_model_get_n_items(windows); j++) {
          g_autoptr(GtkWindow) window = g_list_model_get_item(windows, j);
          GtkWidget *button = find_button(GTK_WIDGET(window), dialog->buttons[choice]);
          if (button) { clicked = TRUE; g_signal_emit_by_name(button, "clicked"); }
        }
        g_usleep(1000);
      }
      g_assert_true(clicked); g_assert_null(s.dialog);
      g_assert_cmpint(dup2(original, STDOUT_FILENO), >=, 0); close(original);
      char result[4096] = {0}; g_assert_cmpint(read(pipes[0], result, sizeof result - 1), >, 0); close(pipes[0]);
      g_autofree char *expected = g_strdup_printf("{\"choice\":\"%s\"}\n", dialog->choices[choice]);
      g_assert_nonnull(strstr(result, expected)); clear(&s);
    }
  }
}
static void invalid_dialog(void) {
  const char *frames[] = { "{\"type\":\"dialog\",\"kind\":\"run\"}\n", "{\"type\":\"dialog\",\"kind\":5}\n", "{\"type\":\"dialog\",\"kind\":\"completed\",\"path\":\"/tmp\"}\n", NULL };
  for (size_t i = 0; frames[i]; i++) { Maintenance s = state(); g_assert_false(accept(&s, frames[i])); g_assert_true(s.failed); clear(&s); }
  Maintenance s = state(); g_assert_true(accept(&s, "{\"type\":\"dialog\",\"kind\":\"retry-cancel\"}\n"));
  g_assert_false(accept(&s, "{\"type\":\"dialog\",\"kind\":\"completed\"}\n")); g_assert_true(s.failed); clear(&s);
}
#ifdef CRABOT_MAINTENANCE_ACTOR
static gboolean actor_choice(gpointer data) {
  (void)data;
  if (!gtk_is_initialized()) return G_SOURCE_CONTINUE;
  const char *labels[] = { "暂时退出", "关闭维护界面", "知道了", "关闭", NULL };
  GListModel *windows = gtk_window_get_toplevels();
  for (guint i = 0; i < g_list_model_get_n_items(windows); i++) {
    g_autoptr(GtkWindow) window = g_list_model_get_item(windows, i);
    if (!gtk_widget_get_visible(GTK_WIDGET(window))) continue;
    for (size_t j = 0; labels[j]; j++) {
      GtkWidget *button = find_button(GTK_WIDGET(window), labels[j]);
      if (button && !g_object_get_data(G_OBJECT(button), "crabot-actor-clicked")) {
        g_object_set_data(G_OBJECT(button), "crabot-actor-clicked", GINT_TO_POINTER(1));
        g_signal_emit_by_name(button, "clicked"); return G_SOURCE_CONTINUE;
      }
    }
  }
  return G_SOURCE_CONTINUE;
}
#endif
int main(int argc, char **argv) {
#ifdef CRABOT_MAINTENANCE_ACTOR
  if (argc == 1) { g_timeout_add(20, actor_choice, NULL); return maintenance_product_main(argc, argv); }
#endif
  g_test_init(&argc, &argv, NULL); gtk_init();
  g_test_add_func("/maintenance/progress", progress); g_test_add_func("/maintenance/cancellation", cancellation);
  g_test_add_func("/maintenance/invalid", invalid); g_test_add_func("/maintenance/limits", limits);
  g_test_add_func("/maintenance/fragmented", fragmented); g_test_add_func("/maintenance/disconnected", disconnected);
  g_test_add_func("/maintenance/close", closed); g_test_add_func("/maintenance/readiness", readiness);
  g_test_add_func("/maintenance/dialog-choices", dialog_choices); g_test_add_func("/maintenance/invalid-dialog", invalid_dialog);
  return g_test_run();
}
