#ifndef RENGINE_TOKEN_H
#define RENGINE_TOKEN_H
#include "common.h"
#include "recording.h"

/* The project token in the chrome (spec 095, stage 3). One status-bar segment per window, reading
   the ledger's `token` frames for the window's primary root, and a popover carrying the controls
   the person at the desktop is never gated on: reject, grant, revoke, free. */

struct ReApp;

typedef struct {
  bool known;                 /* a `token` frame has arrived; before that the segment claims nothing */
  bool held, contested;
  char root[65];
  char holder_agent[65], holder_label[128], holder_since[40];
  int holder_pid;
  char contest_id[65], contester_agent[65], contester_label[128];
  char contest_opened[40], contest_deadline[40], contest_reason[256];
  long long deadline_ms;      /* the deadline as epoch milliseconds, parsed once per frame received */
  int window_ms, sequence;
  char reason[256];           /* the person's own reason, sent with a reject */
  mu_Rect rect;               /* where the segment landed, for the popover's anchor */
} ReProjectToken;

void re_token_event(struct ReApp *app, const cJSON *frame);   /* one `token` frame off /events */
void re_token_clear(struct ReApp *app);                       /* the session connection dropped */
int  re_token_seconds_left(const ReProjectToken *token);             /* against the desktop's own clock */
/* Whether this agent identity is the one the ledger's last word named as holder (spec 103
   decision 1). The identity IS the conversation (spec 095), so a Sessions-tab row asks with the
   conversation it was drawn for; an empty id holds nothing. */
bool re_token_holds(const struct ReApp *app, const char *agent_id);
/* Decision 11: a holder whose process is gone holds nothing, so the row offers Free where it would
   otherwise offer Revoke. The pinned `token` frame carries no liveness, so it is derived from the
   holder pid the frame does carry, on the ledger's own terms. */
bool re_token_holder_alive(const struct ReApp *app);
/* `reject` | `grant` | `revoke` | `free`, as the pinned `token-action` frame. The popover and the
   Sessions tab send through this one function, so there is no second path. */
void re_token_action(struct ReApp *app, const char *action);
/* The Tasks pane's "Hold token for that agent" (spec 103 decision 5): the same sender, naming the
   project whose task is being worked and the identity to hand the token to. A grant answers a
   contest that agent had to open first; this does not need one. */
bool re_token_assign(struct ReApp *app, const char *root, const char *agentId);
void re_token_segment(const struct ReApp *app, char *out, size_t size);   /* the segment's text */
mu_Rect re_token_rect(const struct ReApp *app, ReDraw *draw);  /* zero while no frame has arrived */
void re_token_status(struct ReApp *app, ReDraw *draw);         /* draws the segment */
void re_token_ui(struct ReApp *app, mu_Context *ui);           /* the popover's rows */
void re_token_inspect(const struct ReApp *app, cJSON *out);
/* The recorder's announcement, shaped as the workspace worker's `recording` frame. Matches
   ReRecordAnnounce so the recorder can call it without a cast. */
void re_token_recording(void *app, const ReRecordEvent *event);
#endif
