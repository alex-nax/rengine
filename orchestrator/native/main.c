#include "app.h"
#include "ui/ui.h"
#include "automation.h"

int re_bootstrap(const char *binary);

static void ui_event(mu_Context *ui, const SDL_Event *e) {
  if (e->type == SDL_MOUSEMOTION) mu_input_mousemove(ui, e->motion.x, e->motion.y);
  if (e->type == SDL_MOUSEBUTTONDOWN || e->type == SDL_MOUSEBUTTONUP) {
    int b = e->button.button == SDL_BUTTON_LEFT ? MU_MOUSE_LEFT : e->button.button == SDL_BUTTON_RIGHT ? MU_MOUSE_RIGHT : MU_MOUSE_MIDDLE;
    if (e->type == SDL_MOUSEBUTTONDOWN) mu_input_mousedown(ui, e->button.x, e->button.y, b);
    else mu_input_mouseup(ui, e->button.x, e->button.y, b);
  }
  if (e->type == SDL_MOUSEWHEEL) {
    static float wheel_x, wheel_y;
    mu_input_scroll(ui, re_wheel_steps(&wheel_x, &e->wheel, true, 30), -re_wheel_steps(&wheel_y, &e->wheel, false, 30));
  }
  if (e->type == SDL_TEXTINPUT && strlen(ui->input_text) + strlen(e->text.text) < sizeof(ui->input_text)) mu_input_text(ui, e->text.text);
  if (e->type == SDL_KEYDOWN || e->type == SDL_KEYUP) {
    int key = 0;
    switch (e->key.keysym.sym) {
      case SDLK_LSHIFT: case SDLK_RSHIFT: key = MU_KEY_SHIFT; break;
      case SDLK_LCTRL: case SDLK_RCTRL: key = MU_KEY_CTRL; break;
      case SDLK_LALT: case SDLK_RALT: key = MU_KEY_ALT; break;
      case SDLK_RETURN: key = MU_KEY_RETURN; break;
      case SDLK_BACKSPACE: key = MU_KEY_BACKSPACE; break;
    }
    if (key) { if (e->type == SDL_KEYDOWN) mu_input_keydown(ui, key); else mu_input_keyup(ui, key); }
  }
}
int main(int argc, char **argv) {
  const char *snapshot = NULL, *font = NULL, *connection = NULL, *renderer = NULL; int smoke = 0; bool automation = false, control = false;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--smoke-test")) smoke = 3;
    else if (!strcmp(argv[i], "--automation")) automation = true;
    else if (!strcmp(argv[i], "--control")) control = true;
    else if (!strcmp(argv[i], "--snapshot") && i + 1 < argc) snapshot = argv[++i];
    else if (!strcmp(argv[i], "--font") && i + 1 < argc) font = argv[++i];
    else if (!strcmp(argv[i], "--connection") && i + 1 < argc) connection = argv[++i];
    else if (!strcmp(argv[i], "--renderer") && i + 1 < argc) renderer = argv[++i];
    else if (!strcmp(argv[i], "--help")) { puts("rengine [--connection sidecar.json] [--font FILE] [--renderer opengl|metal|vulkan|sdl|seam-opengl|seam-metal] [--smoke-test --snapshot FILE.bmp] [--automation]\nAutomation accepts local stdin test events only when explicitly enabled."); return 0; }
    else { fprintf(stderr, "Unknown or incomplete option: %s\n", argv[i]); return 2; }
  }
  if (!automation && !smoke && getenv("RENGINE_CAN_RELOAD") && !getenv("RENGINE_LAYERED_CHILD")) {
    if (re_bootstrap(argv[0]) == 0) return 0;
    fprintf(stderr, "Layered bootstrap failed; opening the retained workspace with the legacy launcher.\n");
  }
  const char *backend = re_draw_select(renderer);
  if (!backend) { fprintf(stderr, "Unknown renderer '%s'; use opengl, metal, vulkan, sdl, seam-opengl or seam-metal.\n", renderer ? renderer : ""); return 2; }
  SDL_SetMainReady();
  if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_TIMER) != 0) { fprintf(stderr, "%s\n", SDL_GetError()); return 1; }
  SDL_Window *window = SDL_CreateWindow(automation ? RE_DEFAULT_TITLE " — automated verification" : RE_DEFAULT_TITLE, SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
                                       RE_METRIC_WINDOW_WIDTH, RE_METRIC_WINDOW_HEIGHT, SDL_WINDOW_RESIZABLE | SDL_WINDOW_ALLOW_HIGHDPI | re_draw_window_flags(backend));
  if (!window) { fprintf(stderr, "%s\n", SDL_GetError()); SDL_Quit(); return 1; }
  if (getenv("RENGINE_WINDOW_TITLE")) {
    char title[320]; snprintf(title, sizeof(title), RE_DEFAULT_TITLE " — %s", getenv("RENGINE_WINDOW_TITLE")); SDL_SetWindowTitle(window, title);
  }
  SDL_SetWindowMinimumSize(window, RE_METRIC_WINDOW_MIN_WIDTH, RE_METRIC_WINDOW_MIN_HEIGHT);
  ReDraw *draw = re_draw_open(window, font, backend);
  if (!draw) { fprintf(stderr, "%s\n", SDL_GetError()); SDL_DestroyWindow(window); SDL_Quit(); return 1; }
  cJSON *descriptor = NULL;
  if (connection) {
    size_t size = 0; char *bytes = SDL_LoadFile(connection, &size);
    if (bytes && size <= 4096) descriptor = cJSON_ParseWithLength(bytes, size); SDL_free(bytes);
    if (!descriptor) { fprintf(stderr, "Cannot read workspace connection file.\n"); re_draw_close(draw); SDL_DestroyWindow(window); SDL_Quit(); return 1; }
  }
  ReApp *app = re_app_open(descriptor ? re_string(descriptor, "url") : getenv("RENGINE_WORKSPACE_URL"),
                           descriptor ? re_string(descriptor, "token") : getenv("RENGINE_WORKSPACE_TOKEN"));
  cJSON_Delete(descriptor);
  mu_Context *ui = calloc(1, sizeof(*ui));
  if (!app || !ui) { re_app_close(app); free(ui); re_draw_close(draw); SDL_DestroyWindow(window); SDL_Quit(); return 1; }
  app->file_link_cursor = SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_HAND);
  if (!app->file_link_cursor) fprintf(stderr, "Cannot create link cursor: %s\n", SDL_GetError());
  re_draw_bind(draw, ui);
  if (automation || control) app->controls = cJSON_CreateArray();
  Uint32 automation_event = (automation || control) ? re_automation_start() : 0;
  bool running = true, closing = false, reload = false; int frames = 0, result = 0; cJSON *capture = NULL;
  char window_title[128] = RE_DEFAULT_TITLE;
  SDL_StartTextInput();
  while (running) {
    SDL_Event event; bool redraw = false;
    if (SDL_WaitEventTimeout(&event, smoke ? 1 : re_ui_animating() ? 16 : 250)) do {
      redraw = true;
      if (event.type == SDL_MOUSEMOTION) app->file_link_inactive = false;
      if (event.type == SDL_WINDOWEVENT) {
        if (event.window.event == SDL_WINDOWEVENT_FOCUS_LOST || event.window.event == SDL_WINDOWEVENT_LEAVE) app->file_link_inactive = true;
        if (event.window.event == SDL_WINDOWEVENT_FOCUS_GAINED || event.window.event == SDL_WINDOWEVENT_ENTER) app->file_link_inactive = false;
      }
      if (event.type == SDL_QUIT) closing = true;
      else if (event.type == SDL_KEYDOWN && event.key.keysym.sym == SDLK_r &&
               (event.key.keysym.mod & KMOD_SHIFT) && (event.key.keysym.mod & (KMOD_GUI | KMOD_CTRL))) {
        if (getenv("RENGINE_CAN_RELOAD")) { closing = reload = true; }
        else re_copy(app->status, sizeof(app->status), "Start through npm start to rebuild and reload the desktop.");
        continue;
      }
      else if (automation_event && event.type == automation_event) {
        cJSON *command = event.user.data1;
        const char *op = re_string(command, "op"); int id = re_number(command, "id");
        if (!strcmp(op, "control-snapshot") || (automation && !strcmp(op, "snapshot"))) { cJSON_Delete(capture); capture = command; }
        else {
          if (!strcmp(op, "control-state")) re_automation_reply(id, re_app_inspect(app));
          else if (!strcmp(op, "control-focus")) { SDL_RestoreWindow(window); SDL_RaiseWindow(window); re_automation_reply(id, cJSON_CreateTrue()); }
          else if (!strcmp(op, "control-close")) { closing = true; re_automation_reply(id, cJSON_CreateTrue()); }
          else if (automation) re_automation_command(app, window, command);
          else re_automation_reply(id, cJSON_CreateString("Unsupported window control operation"));
          cJSON_Delete(command);
        }
        continue;
      }
      if (!re_app_event(app, &event, draw)) ui_event(ui, &event);
    } while (SDL_PollEvent(&event));
    re_app_tick(app);
    /* The declaration arrives after the window exists, so the title follows the same rule as the
     * chrome rather than being a second literal: it is the primary root's name (spec 084). */
    if (strcmp(window_title, re_app_title(app))) {
      re_copy(window_title, sizeof(window_title), re_app_title(app));
      const char *suffix = getenv("RENGINE_WINDOW_TITLE");
      char title[320];
      if (automation) snprintf(title, sizeof(title), "%s — automated verification", window_title);
      else if (suffix && *suffix) snprintf(title, sizeof(title), "%s — %s", window_title, suffix);
      else snprintf(title, sizeof(title), "%s", window_title);
      SDL_SetWindowTitle(window, title);
    }
    if (app->reload_requested) { app->reload_requested = false; closing = reload = true; }
    if (!redraw && !re_ui_animating() && frames && !smoke && !closing) continue; /* transitions ask for their own frames */
    int width, height; SDL_GetWindowSize(window, &width, &height);
    /* The owned controls draw into the list while the UI is built, so the frame opens first and
     * microui's replayed commands land above them (spec 076). */
    re_draw_begin(draw, width, height);
    mu_begin(ui); re_app_ui(app, ui, width, height); mu_end(ui);
    if (ui->hover_root != ui->next_hover_root) { SDL_Event settle = {.type = SDL_USEREVENT}; SDL_PushEvent(&settle); }
    re_draw_commands(draw, ui); re_app_draw(app, draw); re_app_file_link_hover(app); re_app_status(app, draw);
    re_ui_overlay_flush(draw); /* the one overlay layer sits above every pane (spec 080) */
    if (capture) {
      bool ok = re_draw_snapshot(draw, re_string(capture, "path")); re_automation_reply(re_number(capture, "id"), cJSON_CreateBool(ok)); cJSON_Delete(capture); capture = NULL;
    }
    frames++;
    if (smoke && frames >= smoke) {
      if (snapshot && !re_draw_snapshot(draw, snapshot)) { fprintf(stderr, "%s\n", SDL_GetError()); result = 1; }
      printf("Native microui frame rendered: %dx%d, renderer=%s, backend=%s\n", width, height, SDL_GetCurrentVideoDriver(), re_draw_backend(draw)); closing = true;
    }
    re_draw_end(draw);
    if (!closing && !(SDL_GetWindowFlags(window) & (SDL_WINDOW_HIDDEN | SDL_WINDOW_MINIMIZED))) {
      for (int i = 0; i < RE_TABS; i++) {
        ReTab *t = &app->tabs[i];
        if (t->terminal && t->rect.w > 0 && t->rect.h > 0) re_terminal_presented(t->terminal);
      }
    }
    if (closing) { running = !re_app_quit(app); if (!app->quitting) closing = reload = false; }
  }
  SDL_SetCursor(SDL_GetDefaultCursor()); SDL_FreeCursor(app->file_link_cursor);
  cJSON_Delete(capture); re_app_close(app); free(ui); re_draw_close(draw); SDL_DestroyWindow(window); SDL_Quit(); return reload ? 75 : result;
}
