#ifndef RENGINE_AUTOMATION_H
#define RENGINE_AUTOMATION_H
#include "app.h"
Uint32 re_automation_start(void);
void re_automation_command(ReApp *app, SDL_Window *window, const cJSON *command);
void re_automation_reply(int id, cJSON *result);
#endif
