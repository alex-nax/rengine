#!/usr/bin/env bash
# Adapted from the selected wizard template; license/provenance: .claude/skills/wizard/.
re_wizard() {
  RE_WIZARD_TOTAL=$2 RE_WIZARD_STAGE=0
  [[ "$RE_WIZARD_TOTAL" =~ ^[1-9][0-9]*$ ]] || { printf 'Invalid stage count\n' >&2; return 2; }
  printf '\n%s (%s stages)\n' "$1" "$RE_WIZARD_TOTAL" >&2
}
re_stage() {
  RE_WIZARD_STAGE=$((RE_WIZARD_STAGE + 1))
  [[ "$RE_WIZARD_STAGE" -le "$RE_WIZARD_TOTAL" ]] || { printf 'Too many stages\n' >&2; return 2; }
  printf '\n[%s/%s] %s\n' "$RE_WIZARD_STAGE" "$RE_WIZARD_TOTAL" "$1" >&2
}
re_ask() {
  local re_name=$1 re_prompt=$2 re_value='' re_secret=${3:-false}
  [[ "$re_name" =~ ^RE_[A-Z][A-Z0-9_]*$ ]] || { printf 'Use a task-specific RE_ variable\n' >&2; return 2; }
  [[ -t 0 ]] || { printf 'Missing required input: %s. Supply an explicit argument.\n' "$re_prompt" >&2; return 2; }
  printf '%s: ' "$re_prompt" >&2
  if [[ "$re_secret" == true ]]; then IFS= read -r -s re_value || return 130; printf '\n' >&2
  else IFS= read -r re_value || return 130; fi
  [[ -n "$re_value" ]] || { printf 'A value is required\n' >&2; return 2; }
  printf -v "$re_name" '%s' "$re_value"
}
re_confirm() {
  local re_reply=''
  [[ -t 0 ]] || { printf 'Human confirmation required: %s\n' "$1" >&2; return 2; }
  printf '%s [y/N]: ' "$1" >&2
  IFS= read -r re_reply || return 130
  [[ "$re_reply" == y || "$re_reply" == Y || "$re_reply" == yes || "$re_reply" == YES ]]
}
re_run() {
  local re_label=$1 re_status; shift
  printf '%s\n' "$re_label" >&2
  if "$@"; then return 0; else re_status=$?; printf 'Failed (%s): %s\n' "$re_status" "$re_label" >&2; return "$re_status"; fi
}
re_finish() {
  [[ "$RE_WIZARD_STAGE" -eq "$RE_WIZARD_TOTAL" ]] || { printf 'Incomplete procedure (%s/%s)\n' "$RE_WIZARD_STAGE" "$RE_WIZARD_TOTAL" >&2; return 2; }
  printf '\nCompleted %s stages.\n' "$RE_WIZARD_TOTAL" >&2
}
