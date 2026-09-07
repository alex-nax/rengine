#include "app.h"
#include "ui/ui.h"
#include <time.h>

/* The desktop's half of the project token (spec 095). The ledger lives in the workspace worker; this
   file holds nothing but the worker's last word about the window's primary root, draws it as one
   status-bar segment, and sends the four gestures the person at the desktop is never gated on. */

#ifdef _WIN32
#include <windows.h>
#define re_timegm _mkgmtime
#else
#include <errno.h>
#include <signal.h>
#define re_timegm timegm
#endif

/* `2026-09-07T10:11:12.500Z` and `2026-09-07T10:11:12Z` both parse; anything else is 0, which reads
   as "no deadline" rather than as an instant in 1970. */
static long long parse_iso(const char *text) {
  struct tm parts;
  int year, month, day, hour, minute, second, millis = 0, consumed = 0;
  if (!text || sscanf(text, "%4d-%2d-%2dT%2d:%2d:%2d%n", &year, &month, &day, &hour, &minute, &second, &consumed) != 6) return 0;
  if (text[consumed] == '.') { if (sscanf(text + consumed + 1, "%3d", &millis) != 1) millis = 0; }
  memset(&parts, 0, sizeof(parts));
  parts.tm_year = year - 1900; parts.tm_mon = month - 1; parts.tm_mday = day;
  parts.tm_hour = hour; parts.tm_min = minute; parts.tm_sec = second; parts.tm_isdst = 0;
  time_t seconds = re_timegm(&parts);
  if (seconds == (time_t)-1) return 0;
  return (long long)seconds * 1000 + millis;
}
static long long now_ms(void) { return (long long)time(NULL) * 1000; }

/* Identity is the window's primary root, the same rule the chrome's name follows (spec 084
   decision 3), so the segment cannot start describing whichever tab was last focused. */
static const char *primary(const ReApp *a) { return *a->primary_root ? a->primary_root : a->root; }

/* Whole seconds still to run, floored. The desktop's wall clock has one-second resolution, so
   rounding up would show a 60-second window opening at 61s; flooring shows the window's own number
   and reads 0 for the last part-second before the deadline. */
int re_token_seconds_left(const ReProjectToken *t) {
  if (!t->contested || !t->deadline_ms) return 0;
  long long left = t->deadline_ms - now_ms();
  if (left <= 0) return 0;
  return (int)(left / 1000);
}

/* The identity IS the conversation (spec 095), so a Sessions-tab row that knows its conversation
   knows whether the ledger's holder is it. An unknown ledger and a nameless row both hold nothing:
   comparing two empty strings would mark every agent that names its own conversations. */
bool re_token_holds(const ReApp *a, const char *agent_id) {
  const ReProjectToken *t = &a->token;
  return t->known && t->held && agent_id && *agent_id && !strcmp(t->holder_agent, agent_id);
}

/* Liveness on the ledger's own terms (`gone()` in runtime/token.mjs): a pid it does not know is not
   a dead pid, and a process this desktop may not signal is still a process. Both halves run on the
   machine the ledger runs on, which is the only place a loopback workspace puts them. */
bool re_token_holder_alive(const ReApp *a) {
  const ReProjectToken *t = &a->token;
  if (!t->known || !t->held) return false;
  if (t->holder_pid <= 0) return true;
#ifdef _WIN32
  HANDLE handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)t->holder_pid);
  if (handle) { CloseHandle(handle); return true; }
  return GetLastError() == ERROR_ACCESS_DENIED;
#else
  return kill((pid_t)t->holder_pid, 0) == 0 || errno == EPERM;
#endif
}

void re_token_clear(ReApp *a) {
  mu_Rect rect = a->token.rect;
  memset(&a->token, 0, sizeof(a->token));
  a->token.rect = rect;      /* geometry is redrawn every frame; the ledger's word is what is gone */
}

void re_token_event(ReApp *a, const cJSON *j) {
  const char *root = primary(a);
  if (!*root || strcmp(re_string(j, "rootId"), root)) return;   /* another root's ledger */
  ReProjectToken *t = &a->token;
  int sequence = re_number(j, "sequence");
  if (t->sequence && sequence && sequence < t->sequence) return;   /* the ledger never goes backwards */
  const cJSON *holder = cJSON_GetObjectItemCaseSensitive(j, "holder");
  const cJSON *contest = cJSON_GetObjectItemCaseSensitive(j, "contest");
  const cJSON *contester = cJSON_GetObjectItemCaseSensitive(contest, "contester");
  re_copy(t->root, sizeof(t->root), root);
  t->known = true; t->sequence = sequence; t->window_ms = re_number(j, "windowMs");
  t->held = cJSON_IsObject(holder);
  re_copy(t->holder_agent, sizeof(t->holder_agent), re_string(holder, "agentId"));
  re_copy(t->holder_label, sizeof(t->holder_label), re_string(holder, "label"));
  re_copy(t->holder_since, sizeof(t->holder_since), re_string(holder, "since"));
  t->holder_pid = re_number(holder, "pid");
  t->contested = cJSON_IsObject(contest);
  re_copy(t->contest_id, sizeof(t->contest_id), re_string(contest, "id"));
  re_copy(t->contest_opened, sizeof(t->contest_opened), re_string(contest, "openedAt"));
  re_copy(t->contest_deadline, sizeof(t->contest_deadline), re_string(contest, "deadline"));
  re_copy(t->contest_reason, sizeof(t->contest_reason), re_string(contest, "reason"));
  re_copy(t->contester_agent, sizeof(t->contester_agent), re_string(contester, "agentId"));
  re_copy(t->contester_label, sizeof(t->contester_label), re_string(contester, "label"));
  t->deadline_ms = t->contested ? parse_iso(t->contest_deadline) : 0;
  if (!t->contested) t->reason[0] = 0;    /* a reason belongs to the contest it was typed for */
}

void re_token_segment(const ReApp *a, char *out, size_t size) {
  const ReProjectToken *t = &a->token;
  if (!t->known) { re_copy(out, size, ""); return; }
  if (t->contested) {
    const char *who = *t->contester_label ? t->contester_label : "an agent";
    snprintf(out, size, "Contest · %s · %ds", who, re_token_seconds_left(t));
  } else if (t->held) {
    snprintf(out, size, "Token · %s", *t->holder_label ? t->holder_label : "an agent");
  } else re_copy(out, size, "Token · free");
}

/* The segment sits at the right edge and the facts move left of it, so its rectangle is a function
   of the window width and its own text alone. Both the hit area built during the interface pass and
   the face drawn after the panes derive it here, which is what keeps them on the same pixels. */
mu_Rect re_token_rect(const ReApp *a, ReDraw *draw) {
  char text[256];
  re_token_segment(a, text, sizeof(text));
  if (!*text || !draw) return mu_rect(0, 0, 0, 0);
  int size = RE_METRIC_DESIGN_SIZE_SM, height = RE_METRIC_DESIGN_STATUS_HEIGHT;
  int width = re_draw_text_width(draw, RE_FACE_UI, size, text, -1) + 2 * RE_METRIC_TOKEN_SEGMENT_PAD;
  return mu_rect(re_max(0, a->width - width), a->height - height, width, height);
}

void re_token_status(ReApp *a, ReDraw *draw) {
  char text[256];
  re_token_segment(a, text, sizeof(text));
  mu_Rect rect = re_token_rect(a, draw);
  a->token.rect = rect;
  if (!rect.w) return;
  int size = RE_METRIC_DESIGN_SIZE_SM;
  bool loud = a->token.contested;
  if (loud) re_draw_rect(draw, rect, RE_COLOR_STATUS_ACCENT_BG);
  else re_draw_rect(draw, mu_rect(rect.x, rect.y, 1, rect.h), RE_COLOR_DIVIDER);
  re_draw_text_face(draw, loud ? RE_FACE_UI_SEMIBOLD : RE_FACE_UI, size, text, -1,
                    rect.x + RE_METRIC_TOKEN_SEGMENT_PAD, rect.y + (rect.h - size) / 2 - 1,
                    loud ? RE_COLOR_STATUS_ACCENT_FG : RE_COLOR_STATUS_FG);
}

/* ---- the human's controls ---------------------------------------------------------------------
 * Never gated (decision 6): these four are the person's own acts, and the desktop sends them
 * whatever the ledger says about agents. The answer is the next `token` frame, or an `error`.
 * The popover below and the Sessions tab's own Revoke and Free (spec 103 decision 1) both send
 * here, so the two surfaces cannot drift into two contracts. */
/* One sender for every token-action frame the desktop puts on the wire, so the popover's four
   gestures and the Tasks pane's `assign` (spec 103 decision 5) cannot drift apart in what they
   send. An assign names its own root — the project whose task is being worked, which need not be
   the window's primary one — and the identity to hand the token to. */
static bool send_action(ReApp *a, const char *root, const char *action, const char *agent) {
  if (!*root) { re_copy(a->status, sizeof(a->status), "Add or select a project first."); return false; }
  bool contest = !strcmp(action, "reject") || !strcmp(action, "grant");
  bool assign = !strcmp(action, "assign");
  if (contest && !*a->token.contest_id) { re_copy(a->status, sizeof(a->status), "No contest is open on this project's token."); return false; }
  if (assign && (!agent || !*agent)) { re_copy(a->status, sizeof(a->status), "Name the agent to give this project's token to."); return false; }
  cJSON *j = cJSON_CreateObject();
  cJSON_AddStringToObject(j, "type", "token-action");
  cJSON_AddStringToObject(j, "rootId", root);
  cJSON_AddStringToObject(j, "action", action);
  if (contest) cJSON_AddStringToObject(j, "contestId", a->token.contest_id);
  if (assign) cJSON_AddStringToObject(j, "agentId", agent);
  if (!strcmp(action, "reject") && *a->token.reason) cJSON_AddStringToObject(j, "reason", a->token.reason);
  char *text = cJSON_PrintUnformatted(j);
  bool sent = text && re_socket_send(a->events, text);
  free(text); cJSON_Delete(j);
  if (sent) snprintf(a->status, sizeof(a->status), "Asked the workspace to %s the project token; the ledger answers with the next token frame.", action);
  else re_copy(a->status, sizeof(a->status), "Session connection is down; the token action was not sent.");
  if (sent && !strcmp(action, "reject")) a->token.reason[0] = 0;
  return sent;
}
void re_token_action(ReApp *a, const char *action) { send_action(a, primary(a), action, NULL); }
bool re_token_assign(ReApp *a, const char *root, const char *agent) { return send_action(a, root, "assign", agent); }

void re_token_ui(ReApp *a, mu_Context *ui) {
  ReProjectToken *t = &a->token;
  char line[512];
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_TOKEN_HEADING_HEIGHT);
  re_ui_heading(ui, "Project token");
  mu_layout_row(ui, 2, (int[]){RE_METRIC_TOKEN_LABEL_WIDTH, -1}, RE_METRIC_TOKEN_ROW_HEIGHT);
  re_ui_label_ex(ui, "Holder", RE_UI_MUTED | RE_UI_SMALL);
  if (t->held) snprintf(line, sizeof(line), "%s · pid %d", *t->holder_label ? t->holder_label : "an agent", t->holder_pid);
  else re_copy(line, sizeof(line), t->known ? "Nobody holds this project's token." : "Waiting for the workspace ledger…");
  re_ui_label_ex(ui, line, 0);
  if (t->held) {
    mu_layout_row(ui, 2, (int[]){RE_METRIC_TOKEN_LABEL_WIDTH, -1}, RE_METRIC_TOKEN_ROW_HEIGHT);
    re_ui_label_ex(ui, "Since", RE_UI_MUTED | RE_UI_SMALL);
    re_ui_label_ex(ui, *t->holder_since ? t->holder_since : "unknown", RE_UI_MUTED | RE_UI_SMALL);
  }
  if (t->contested) {
    mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_TOKEN_HEADING_HEIGHT);
    re_ui_heading(ui, "Contest");
    mu_layout_row(ui, 2, (int[]){RE_METRIC_TOKEN_LABEL_WIDTH, -1}, RE_METRIC_TOKEN_ROW_HEIGHT);
    re_ui_label_ex(ui, "Contester", RE_UI_MUTED | RE_UI_SMALL);
    snprintf(line, sizeof(line), "%s · %ds left", *t->contester_label ? t->contester_label : "an agent", re_token_seconds_left(t));
    re_ui_label_ex(ui, line, 0);
    /* A rejection the contester can read is the point of decision 3, so the reason has a field
       rather than being invented by the desktop. */
    mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_TOKEN_ACTION_HEIGHT);
    re_ui_textbox_ex(ui, t->reason, sizeof(t->reason), RE_ICON_FILE, "Why (optional)…", 0);
    re_app_control(a, ui, "token", "reason", -1);
    mu_layout_row(ui, 2, (int[]){RE_METRIC_TOKEN_ACTION_WIDTH, -1}, RE_METRIC_TOKEN_ACTION_HEIGHT);
    if (re_ui_button_ex(ui, "Reject", RE_ICON_CLOSE, 0)) re_token_action(a, "reject");
    re_app_control(a, ui, "token", "reject", -1);
    if (re_ui_button_ex(ui, "Grant", RE_ICON_CHECK, RE_UI_PRIMARY)) re_token_action(a, "grant");
    re_app_control(a, ui, "token", "grant", -1);
  }
  if (t->held) {
    mu_layout_row(ui, 2, (int[]){RE_METRIC_TOKEN_ACTION_WIDTH, -1}, RE_METRIC_TOKEN_ACTION_HEIGHT);
    if (re_ui_button_ex(ui, "Revoke", RE_ICON_CLOSE, 0)) re_token_action(a, "revoke");
    re_app_control(a, ui, "token", "revoke", -1);
    if (re_ui_button_ex(ui, "Free", RE_ICON_HOLLOW, RE_UI_GHOST)) re_token_action(a, "free");
    re_app_control(a, ui, "token", "free", -1);
  }
}

void re_token_inspect(const ReApp *a, cJSON *out) {
  const ReProjectToken *t = &a->token;
  char text[256];
  re_token_segment(a, text, sizeof(text));
  cJSON *j = cJSON_AddObjectToObject(out, "token");
  cJSON_AddBoolToObject(j, "known", t->known);
  cJSON_AddStringToObject(j, "rootId", t->root);
  cJSON_AddStringToObject(j, "segment", text);
  cJSON_AddNumberToObject(j, "windowMs", t->window_ms);
  cJSON_AddNumberToObject(j, "sequence", t->sequence);
  cJSON_AddStringToObject(j, "reason", t->reason);
  if (t->held) {
    cJSON *holder = cJSON_AddObjectToObject(j, "holder");
    cJSON_AddStringToObject(holder, "agentId", t->holder_agent);
    cJSON_AddStringToObject(holder, "label", t->holder_label);
    cJSON_AddNumberToObject(holder, "pid", t->holder_pid);
    cJSON_AddStringToObject(holder, "since", t->holder_since);
  } else cJSON_AddNullToObject(j, "holder");
  if (t->contested) {
    cJSON *contest = cJSON_AddObjectToObject(j, "contest");
    cJSON_AddStringToObject(contest, "id", t->contest_id);
    cJSON_AddStringToObject(contest, "openedAt", t->contest_opened);
    cJSON_AddStringToObject(contest, "deadline", t->contest_deadline);
    cJSON_AddStringToObject(contest, "reason", t->contest_reason);
    cJSON_AddNumberToObject(contest, "secondsLeft", re_token_seconds_left(t));
    cJSON *who = cJSON_AddObjectToObject(contest, "contester");
    cJSON_AddStringToObject(who, "agentId", t->contester_agent);
    cJSON_AddStringToObject(who, "label", t->contester_label);
  } else cJSON_AddNullToObject(j, "contest");
}

/* The recorder announces on the same socket the desktop registers on, because the worker intercepts
   this frame there exactly as it intercepts `desktop-register` (spec 095, "The feed"). */
void re_token_recording(void *user, const ReRecordEvent *event) {
  ReApp *a = user;
  char at[40];
  if (!a || !event) return;
  re_recording_wall_iso(now_ms(), at, sizeof(at));
  cJSON *j = cJSON_CreateObject();
  cJSON_AddStringToObject(j, "type", "recording");
  cJSON_AddStringToObject(j, "rootId", event->root_id ? event->root_id : "");
  cJSON_AddStringToObject(j, "sessionId", event->session_id ? event->session_id : "");
  cJSON_AddStringToObject(j, "gameId", event->game_id ? event->game_id : "");
  cJSON_AddStringToObject(j, "event", event->event);
  cJSON_AddStringToObject(j, "recordingId", event->recording_id);
  cJSON_AddStringToObject(j, "kind", event->kind);
  cJSON_AddStringToObject(j, "at", at);
  char *text = cJSON_PrintUnformatted(j);
  if (text) re_socket_send(a->events, text);
  free(text); cJSON_Delete(j);
}
