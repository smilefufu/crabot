// Exercises the actual GTK callback lifecycle using finite child processes.
#define main crabot_native_installer_main
#include "installer.c"
#undef main

typedef struct { Installer *installer; GMainLoop *loop; } Completion;
static void backend_done(GObject *source, GAsyncResult *result, gpointer data) {
  Completion *completion = data;
  backend_finished(source, result, completion->installer);
  g_main_loop_quit(completion->loop);
}
static void authorization_done(GObject *source, GAsyncResult *result, gpointer data) {
  Completion *completion = data;
  authorization_finished(source, result, completion->installer);
  g_main_loop_quit(completion->loop);
}
static void pending_authorization_blocks_retry(void) {
  Installer s = {0};
  s.destination = GTK_ENTRY(g_object_ref_sink(gtk_entry_new()));
  s.status = GTK_LABEL(g_object_ref_sink(gtk_label_new("")));
  s.spinner = GTK_SPINNER(g_object_ref_sink(gtk_spinner_new()));
  s.choose = g_object_ref_sink(gtk_button_new());
  s.install = g_object_ref_sink(gtk_button_new());
  s.cancel = g_object_ref_sink(gtk_button_new());
  s.open = g_object_ref_sink(gtk_button_new());
  busy(&s, TRUE); s.cancelling = TRUE;
  // cat remains owned and blocked until its pipe closes; no timing assumption.
  s.authorization = g_subprocess_new(G_SUBPROCESS_FLAGS_STDIN_PIPE | G_SUBPROCESS_FLAGS_STDOUT_SILENCE | G_SUBPROCESS_FLAGS_STDERR_SILENCE,
    NULL, "/bin/cat", NULL);
  s.backend = g_subprocess_new(G_SUBPROCESS_FLAGS_STDOUT_SILENCE | G_SUBPROCESS_FLAGS_STDERR_SILENCE, NULL, "/bin/true", NULL);
  g_assert_nonnull(s.authorization); g_assert_nonnull(s.backend);
  GMainLoop *loop = g_main_loop_new(NULL, FALSE); Completion completion = { &s, loop };
  g_subprocess_wait_check_async(s.backend, NULL, backend_done, &completion);
  g_main_loop_run(loop);
  gboolean held_busy = s.busy, held_cancel = s.cancelling;
  gboolean retry_disabled = !gtk_widget_get_sensitive(s.install);
  g_assert_null(s.backend);
  g_subprocess_wait_check_async(s.authorization, NULL, authorization_done, &completion);
  g_assert_true(g_output_stream_close(g_subprocess_get_stdin_pipe(s.authorization), NULL, NULL));
  g_main_loop_run(loop);
  gboolean released = !s.busy && !s.cancelling && gtk_widget_get_sensitive(s.install);
  g_assert_null(s.authorization);
  g_main_loop_unref(loop);
  g_object_unref(s.destination); g_object_unref(s.status); g_object_unref(s.spinner);
  g_object_unref(s.choose); g_object_unref(s.install); g_object_unref(s.cancel); g_object_unref(s.open);
  // Check after both children are reaped, including the failing old-source case.
  g_assert_true(held_busy); g_assert_true(held_cancel); g_assert_true(retry_disabled); g_assert_true(released);
}
static void retained_completion_is_not_service_health(void) {
  const char *flags[] = { "", ",\"verification_pending\":true", ",\"verification_pending\":\"true\"" };
  for (size_t i = 0; i < G_N_ELEMENTS(flags); i++) {
    g_autofree char *root = g_dir_make_tmp("crabot-installer-complete-XXXXXX", NULL);
    g_assert_nonnull(root);
    Installer s = {0}; s.selected = root;
    s.status = GTK_LABEL(g_object_ref_sink(gtk_label_new("")));
    s.open = g_object_ref_sink(gtk_button_new()); s.cancel = g_object_ref_sink(gtk_button_new());
    if (i == 1) {
      const char *progress = "{\"type\":\"progress\",\"phase\":\"handing-off\"}";
      g_assert_true(frame(&s, progress, strlen(progress)));
      g_assert_true(s.finalizing); g_assert_false(gtk_widget_get_sensitive(s.cancel));
    }
    g_autofree char *line = g_strdup_printf("{\"type\":\"complete\",\"executable\":\"%s/app/releases/11111111-1111-4111-8111-111111111111/crabot-desktop\"%s}", root, flags[i]);
    if (i == 2) { g_assert_false(frame(&s, line, strlen(line))); g_assert_false(s.complete); g_assert_null(s.executable); }
    else {
      g_assert_true(frame(&s, line, strlen(line))); g_assert_true(s.complete);
      g_assert_nonnull(strstr(gtk_label_get_text(s.status), i == 1 ? "尚待启动核验" : "通过沙箱检查"));
      if (i == 1) g_assert_cmpstr(gtk_button_get_label(GTK_BUTTON(s.open)), ==, "打开 Crabot 继续核验");
    }
    g_free(s.executable); g_object_unref(s.status); g_object_unref(s.open); g_object_unref(s.cancel);
    g_assert_cmpint(rmdir(root), ==, 0);
  }
}
static GtkWidget *button_named(GtkWidget *widget, const char *label) {
  if (GTK_IS_BUTTON(widget) && !g_strcmp0(gtk_button_get_label(GTK_BUTTON(widget)), label)) return widget;
  for (GtkWidget *child = gtk_widget_get_first_child(widget); child; child = gtk_widget_get_next_sibling(child)) {
    GtkWidget *button = button_named(child, label); if (button) return button;
  }
  return NULL;
}
static void retained_removal_choices(void) {
  const char *labels[] = { "保留数据重新安装", "继续卸载", "取消" };
  const char *actions[] = { "repair", "continue_removal", "cancel" };
  for (size_t choice = 0; choice < G_N_ELEMENTS(labels); choice++) {
    Installer s = {0};
    s.window = GTK_WINDOW(g_object_ref_sink(gtk_window_new()));
    s.destination = GTK_ENTRY(g_object_ref_sink(gtk_entry_new()));
    s.status = GTK_LABEL(g_object_ref_sink(gtk_label_new("")));
    s.spinner = GTK_SPINNER(g_object_ref_sink(gtk_spinner_new()));
    s.choose = g_object_ref_sink(gtk_button_new()); s.install = g_object_ref_sink(gtk_button_new());
    s.cancel = g_object_ref_sink(gtk_button_new()); s.open = g_object_ref_sink(gtk_button_new());
    s.backend = g_subprocess_new(G_SUBPROCESS_FLAGS_STDIN_PIPE | G_SUBPROCESS_FLAGS_STDOUT_PIPE, NULL, "/bin/cat", NULL);
    g_assert_nonnull(s.backend); busy(&s, TRUE);
    const char *request = "{\"type\":\"retained_choice_required\"}";
    g_assert_true(frame(&s, request, strlen(request))); g_assert_true(s.retained_choice_pending);
    g_assert_false(frame(&s, request, strlen(request)));
    GtkWidget *button = NULL; gint64 deadline = g_get_monotonic_time() + 5 * G_TIME_SPAN_SECOND;
    while (!button && g_get_monotonic_time() < deadline) {
      while (g_main_context_iteration(NULL, FALSE)) {}
      GListModel *windows = gtk_window_get_toplevels();
      for (guint i = 0; i < g_list_model_get_n_items(windows) && !button; i++) {
        g_autoptr(GtkWindow) window = g_list_model_get_item(windows, i);
        button = button_named(GTK_WIDGET(window), labels[choice]);
      }
      if (!button) g_usleep(1000);
    }
    g_assert_nonnull(button); g_signal_emit_by_name(button, "clicked");
    while (s.retained_choice_pending && g_get_monotonic_time() < deadline) { g_main_context_iteration(NULL, FALSE); g_usleep(1000); }
    g_assert_false(s.retained_choice_pending);
    g_autoptr(GDataInputStream) output = g_data_input_stream_new(g_subprocess_get_stdout_pipe(s.backend));
    g_autofree char *received = g_data_input_stream_read_line(output, NULL, NULL, NULL);
    g_autofree char *expected = g_strdup_printf("{\"action\":\"%s\"}", actions[choice]);
    g_assert_cmpstr(received, ==, expected);
    g_assert_cmpint(s.removing, ==, choice == 1);
    if (choice == 1) {
      const char *progress = "{\"type\":\"removal_progress\",\"message\":\"正在移除程序，数据保留\"}";
      const char *removed = "{\"type\":\"removed\"}";
      g_assert_true(frame(&s, progress, strlen(progress))); g_assert_false(gtk_widget_get_sensitive(s.cancel));
      g_assert_true(frame(&s, removed, strlen(removed))); g_assert_true(s.removed); g_assert_true(s.complete);
      g_assert_nonnull(strstr(gtk_label_get_text(s.status), "用户数据、工作区和工作依赖均已保留"));
    } else g_assert_true(gtk_widget_get_sensitive(s.cancel));
    GMainLoop *loop = g_main_loop_new(NULL, FALSE); Completion completion = { &s, loop };
    g_subprocess_wait_check_async(s.backend, NULL, backend_done, &completion);
    g_assert_true(g_output_stream_close(g_subprocess_get_stdin_pipe(s.backend), NULL, NULL));
    g_main_loop_run(loop); g_main_loop_unref(loop);
    g_assert_false(s.busy); g_assert_false(gtk_widget_get_visible(s.open));
    if (choice == 1) g_assert_true(s.complete);
    gtk_window_destroy(s.window); g_object_unref(s.window);
    g_object_unref(s.destination); g_object_unref(s.status); g_object_unref(s.spinner);
    g_object_unref(s.choose); g_object_unref(s.install); g_object_unref(s.cancel); g_object_unref(s.open);
  }
}
int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL); gtk_init();
  g_test_add_func("/installer/pending-authorization-blocks-retry", pending_authorization_blocks_retry);
  g_test_add_func("/installer/retained-completion-pending-health", retained_completion_is_not_service_health);
  g_test_add_func("/installer/retained-removal-choices", retained_removal_choices);
  return g_test_run();
}
