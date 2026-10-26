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
int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL); gtk_init();
  g_test_add_func("/installer/pending-authorization-blocks-retry", pending_authorization_blocks_retry);
  g_test_add_func("/installer/retained-completion-pending-health", retained_completion_is_not_service_health);
  return g_test_run();
}
