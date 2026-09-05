#include "app.h"
#include "automation.h"

static void ui_event(mu_Context *ui, const SDL_Event *e) {
  if (e->type == SDL_MOUSEMOTION) mu_input_mousemove(ui, e->motion.x, e->motion.y);
  if (e->type == SDL_MOUSEBUTTONDOWN || e->type == SDL_MOUSEBUTTONUP) {
    int b = e->button.button == SDL_BUTTON_LEFT ? MU_MOUSE_LEFT : e->button.button == SDL_BUTTON_RIGHT ? MU_MOUSE_RIGHT : MU_MOUSE_MIDDLE;
    if (e->type == SDL_MOUSEBUTTONDOWN) mu_input_mousedown(ui, e->button.x, e->button.y, b);
    else mu_input_mouseup(ui, e->button.x, e->button.y, b);
  }
  if (e->type == SDL_MOUSEWHEEL) mu_input_scroll(ui, -e->wheel.x * 30, -e->wheel.y * 30);
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
  const char *snapshot = NULL, *font = NULL, *connection = NULL; int smoke = 0; bool automation = false;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--smoke-test")) smoke = 3;
    else if (!strcmp(argv[i], "--automation")) automation = true;
    else if (!strcmp(argv[i], "--snapshot") && i + 1 < argc) snapshot = argv[++i];
    else if (!strcmp(argv[i], "--font") && i + 1 < argc) font = argv[++i];
    else if (!strcmp(argv[i], "--connection") && i + 1 < argc) connection = argv[++i];
    else if (!strcmp(argv[i], "--help")) { puts("rengine [--connection sidecar.json] [--font FILE] [--smoke-test --snapshot FILE.bmp] [--automation]\nAutomation accepts local stdin test events only when explicitly enabled."); return 0; }
    else { fprintf(stderr, "Unknown or incomplete option: %s\n", argv[i]); return 2; }
  }
  SDL_SetMainReady();
  if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_TIMER) != 0) { fprintf(stderr, "%s\n", SDL_GetError()); return 1; }
  SDL_Window *window = SDL_CreateWindow(automation ? "rEngine — automated verification" : "rEngine", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
                                       1280, 800, SDL_WINDOW_RESIZABLE | SDL_WINDOW_ALLOW_HIGHDPI);
  if (!window) { fprintf(stderr, "%s\n", SDL_GetError()); SDL_Quit(); return 1; }
  SDL_SetWindowMinimumSize(window, 1050, 480);
  ReDraw *draw = re_draw_open(window, font);
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
  re_draw_bind(draw, ui);
  if (automation) app->controls = cJSON_CreateArray();
  Uint32 automation_event = automation ? re_automation_start() : 0;
  bool running = true, closing = false, reload = false; int frames = 0, result = 0; cJSON *capture = NULL;
  SDL_StartTextInput();
  while (running) {
    SDL_Event event; bool redraw = false;
    if (SDL_WaitEventTimeout(&event, smoke ? 1 : 250)) do {
      redraw = true;
      if (event.type == SDL_QUIT) closing = true;
      else if (event.type == SDL_KEYDOWN && event.key.keysym.sym == SDLK_r &&
               (event.key.keysym.mod & KMOD_SHIFT) && (event.key.keysym.mod & (KMOD_GUI | KMOD_CTRL))) {
        if (getenv("RENGINE_CAN_RELOAD")) { closing = reload = true; }
        else re_copy(app->status, sizeof(app->status), "Start through npm start to rebuild and reload the desktop.");
        continue;
      }
      else if (automation_event && event.type == automation_event) {
        cJSON *command = event.user.data1;
        if (!strcmp(re_string(command, "op"), "snapshot")) { cJSON_Delete(capture); capture = command; }
        else { re_automation_command(app, window, command); cJSON_Delete(command); }
        continue;
      }
      if (!re_app_event(app, &event, draw)) ui_event(ui, &event);
    } while (SDL_PollEvent(&event));
    re_app_tick(app);
    if (!redraw && frames && !smoke && !closing) continue;
    int width, height; SDL_GetWindowSize(window, &width, &height);
    mu_begin(ui); re_app_ui(app, ui, width, height); mu_end(ui);
    if (ui->hover_root != ui->next_hover_root) { SDL_Event settle = {.type = SDL_USEREVENT}; SDL_PushEvent(&settle); }
    re_draw_begin(draw, width, height); re_draw_commands(draw, ui); re_app_draw(app, draw);
    re_draw_text(draw, app->status, -1, 8, height - 24, mu_color(146, 167, 178, 255));
    if (capture) {
      bool ok = re_draw_snapshot(draw, re_string(capture, "path")); re_automation_reply(re_number(capture, "id"), cJSON_CreateBool(ok)); cJSON_Delete(capture); capture = NULL;
    }
    frames++;
    if (smoke && frames >= smoke) {
      if (snapshot && !re_draw_snapshot(draw, snapshot)) { fprintf(stderr, "%s\n", SDL_GetError()); result = 1; }
      printf("Native microui frame rendered: %dx%d, renderer=%s\n", width, height, SDL_GetCurrentVideoDriver()); closing = true;
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
  cJSON_Delete(capture); re_app_close(app); free(ui); re_draw_close(draw); SDL_DestroyWindow(window); SDL_Quit(); return reload ? 75 : result;
}
