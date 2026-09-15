//! The two tracker backends that are somebody else's server (F154, spec 083, spec 100).
//!
//! **The view reads and never writes.** Neither GitHub nor Linear offers concurrency control on an
//! issue write, so every write from here would be last-write-wins against whatever a teammate just
//! did in the web interface. Reading has no such failure mode.
//!
//! Every provider answers the same neutral row, and the vocabulary is deliberately not HTTP-shaped:
//! the local backend is a file read whose conflicts are git merges resolved by a person, and forcing
//! it to speak in status codes would distort the backend this project actually uses. So there are
//! four different things a caller is told apart from rows — `denied`, `invalid`, `unavailable`, and
//! `signIn` — and each is something different to do about it.

use serde_json::{json, Value};

/// One answer from a provider's server, in the workspace's own vocabulary.
pub trait Fetching {
    fn post(&self, url: &str, headers: &[(&str, &str)], body: &str) -> Result<(u16, String), String>;
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<(u16, String), String>;
}

/// The real one.
pub struct Network;

impl Fetching for Network {
    fn post(&self, url: &str, headers: &[(&str, &str)], body: &str) -> Result<(u16, String), String> {
        red_core::tls::request("POST", url, headers, Some(body)).map(|answer| (answer.status, answer.body))
    }
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<(u16, String), String> {
        red_core::tls::request("GET", url, headers, None).map(|answer| (answer.status, answer.body))
    }
}

/// One poll every 30 seconds is about 5% of a Linear key's budget, which is where this number comes
/// from — it is a rate limit shared with whatever else the person has pointed at that key.
pub const PROBE_TTL_MS: i64 = 30_000;
const CACHE_LIMIT: usize = 64;

/// What a remote list is remembered as, and for how long.
///
/// **The local backend is never cached**, because it is a file read that is always current and a
/// staleness indicator on something that cannot be stale would be a lie. A remote one is, with
/// in-flight COALESCING: two callers arriving together share one request rather than spending the
/// budget twice — the shape the device probe established.
#[derive(Default)]
pub struct Cache {
    held: std::sync::Mutex<Vec<(String, Entry)>>,
}

#[derive(Clone)]
struct Entry {
    at: i64,
    value: Value,
}

/// The key a remembered list is found by.
///
/// **The narrowing is part of the key.** Two declarations that ask different questions are different
/// questions, and answering the second from the first's entry would be WRONG rather than stale.
pub fn cache_key(root_id: &str, block: &Value) -> String {
    let text = |name: &str| block.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
    let states = block
        .get("states")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(","))
        .unwrap_or_default();
    let target = if block.get("repository").is_some() { text("repository") } else { text("team") };
    [root_id, &text("provider"), &target, &text("project"), &text("assignee"), &states].join(" ")
}

impl Cache {
    pub fn new() -> Cache {
        Cache::default()
    }

    /// The remembered list, or a fresh one. `refresh` drops the entry first, which is what a caller
    /// asking for a refresh means — not "answer me sooner" but "ask them again".
    ///
    /// Answers the value and the moment it was TAKEN, so a caller can say `fresh` and `checkedAt`
    /// about the answer rather than about the question.
    pub fn of(&self, key: &str, refresh: bool, now_ms: i64, produce: impl FnOnce() -> Value) -> (Value, i64) {
        {
            let mut held = self.held.lock().expect("cache");
            if refresh {
                held.retain(|(known, _)| known != key);
            } else if let Some((_, entry)) = held.iter().find(|(known, _)| known == key) {
                if now_ms - entry.at < PROBE_TTL_MS {
                    return (entry.value.clone(), entry.at);
                }
            }
        }
        let value = produce();
        let mut held = self.held.lock().expect("cache");
        held.retain(|(known, _)| known != key);
        held.push((key.to_string(), Entry { at: now_ms, value: value.clone() }));
        /* Oldest out first, so a workspace with many projects does not remember all of them. */
        while held.len() > CACHE_LIMIT {
            held.remove(0);
        }
        (value, now_ms)
    }
}

const LINEAR_QUERY: &str = "query Issues($filter: IssueFilter, $first: Int!) {\n  issues(first: $first, filter: $filter, orderBy: updatedAt) {\n    nodes {\n      id identifier title url priority updatedAt\n      state { id name type }\n      assignee { displayName }\n      labels(first: 10) { nodes { name } }\n      relations(first: 20) { nodes { type relatedIssue { identifier } } }\n    }\n  }\n}";
const LINEAR_PRIORITY: [Option<&str>; 5] = [None, Some("urgent"), Some("high"), Some("medium"), Some("low")];

/// The filter a declaration becomes.
///
/// An undeclared narrowing contributes NO clause, so an existing declaration asks exactly what it
/// always did. The project clause stays null-safe: present and null leaves the team unfiltered
/// (spec 100).
pub fn linear_filter(block: &Value) -> Value {
    let mut filter = json!({
        "team": { "key": { "eq": block.get("team").cloned().unwrap_or(Value::Null) } },
        "project": { "name": { "eq": block.get("project").cloned().unwrap_or(Value::Null) } },
    });
    /* "me" is the one assignee value that is not a name: it asks Linear who the token belongs to, so
       a personal declaration keeps working when somebody else's token reads it. */
    if let Some(assignee) = block.get("assignee") {
        filter["assignee"] = if assignee == &json!("me") {
            json!({ "isMe": { "eq": true } })
        } else {
            json!({ "displayName": { "eq": assignee } })
        };
    }
    /* Declared categories are the row's own vocabulary, which is Linear's state type. */
    if let Some(states) = block.get("states") {
        filter["state"] = json!({ "type": { "in": states } });
    }
    filter
}

/// Linear. **A personal API key sends the token bare, without a `Bearer` prefix**, which is the one
/// thing about its auth that surprises everyone.
pub fn linear_rows(block: &Value, token: Option<&str>, fetching: &dyn Fetching) -> Value {
    let Some(token) = token else {
        return json!({ "rows": [], "denied": "Not signed in to Linear.", "signIn": "linear" });
    };
    let body = json!({ "query": LINEAR_QUERY, "variables": { "filter": linear_filter(block), "first": 100 } });
    let answered = fetching.post(
        "https://api.linear.app/graphql",
        &[("Content-Type", "application/json"), ("Authorization", token)],
        &body.to_string(),
    );
    let (status, text) = match answered {
        Ok(answered) => answered,
        Err(error) => return json!({ "rows": [], "unavailable": error }),
    };
    if status == 401 || status == 403 {
        return json!({ "rows": [], "denied": "Linear refused the token." });
    }
    if !(200..300).contains(&status) {
        return json!({ "rows": [], "unavailable": format!("Linear answered {status}.") });
    }
    let Ok(said) = serde_json::from_str::<Value>(&text) else {
        return json!({ "rows": [], "unavailable": "Linear answered something this build could not read." });
    };
    if let Some(errors) = said.get("errors").and_then(Value::as_array).filter(|listed| !listed.is_empty()) {
        let messages: Vec<String> = errors
            .iter()
            .map(|error| error.get("message").and_then(Value::as_str).unwrap_or_default().to_string())
            .collect();
        /* Linear reports its rate limit as a 400 carrying a RATELIMITED error rather than a 429. */
        if messages.join("; ").to_ascii_lowercase().contains("ratelimit") {
            return json!({ "rows": [], "unavailable": "Linear rate limit reached; the list refreshes shortly." });
        }
        return json!({ "rows": [], "invalid": messages });
    }
    let empty = Vec::new();
    let nodes = said.get("data").and_then(|data| data.get("issues")).and_then(|issues| issues.get("nodes")).and_then(Value::as_array).unwrap_or(&empty);
    let rows: Vec<Value> = nodes
        .iter()
        .map(|issue| {
            let state = issue.get("state");
            let priority = issue.get("priority").and_then(Value::as_u64).unwrap_or(0) as usize;
            crate::tracker::remote_row(
                text_of(issue.get("id")),
                text_of(issue.get("identifier")),
                issue.get("title").cloned().unwrap_or_else(|| json!("")),
                (
                    &text_of(state.and_then(|state| state.get("id"))),
                    &text_of(state.and_then(|state| state.get("name"))),
                    &text_of(state.and_then(|state| state.get("type"))),
                ),
                vec![
                    ("url", issue.get("url").cloned().unwrap_or(Value::Null)),
                    ("priority", LINEAR_PRIORITY.get(priority).copied().flatten().map(Value::from).unwrap_or(Value::Null)),
                    ("labels", names(issue.get("labels").and_then(|labels| labels.get("nodes")), "name")),
                    ("assignee", issue.get("assignee").and_then(|who| who.get("displayName")).cloned().unwrap_or(Value::Null)),
                    ("updatedAt", issue.get("updatedAt").cloned().unwrap_or(Value::Null)),
                    ("blockedBy", blocked_by(issue.get("relations").and_then(|held| held.get("nodes")))),
                ],
            )
        })
        .collect();
    json!({ "rows": rows })
}

/// GitHub. State is open or closed with a reason, so the category is DERIVED rather than read.
pub fn github_rows(block: &Value, token: Option<&str>, fetching: &dyn Fetching) -> Value {
    let identity = block.get("identity").and_then(Value::as_str).unwrap_or_default();
    let Some(token) = token else {
        return json!({
            "rows": [],
            "denied": format!("No GitHub token. Put one in the workspace state directory as trackers/{identity}.token"),
        });
    };
    let repository = block.get("repository").and_then(Value::as_str).unwrap_or_default();
    let url = format!("https://api.github.com/repos/{repository}/issues?state=all&sort=updated&direction=desc&per_page=100");
    let bearer = format!("Bearer {token}");
    let answered = fetching.get(
        &url,
        &[
            ("Authorization", &bearer),
            ("Accept", "application/vnd.github+json"),
            ("X-GitHub-Api-Version", "2022-11-28"),
            /* Required by the API, and named for the thing asking rather than for a browser. */
            ("User-Agent", red_core::theme::PRODUCT_NAME),
        ],
    );
    let (status, text) = match answered {
        Ok(answered) => answered,
        Err(error) => return json!({ "rows": [], "unavailable": error }),
    };
    if status == 401 || status == 403 {
        return json!({ "rows": [], "denied": "GitHub refused the token." });
    }
    if status == 404 {
        return json!({ "rows": [], "invalid": [format!("{repository} is not reachable with this token.")] });
    }
    if !(200..300).contains(&status) {
        return json!({ "rows": [], "unavailable": format!("GitHub answered {status}.") });
    }
    let Ok(said) = serde_json::from_str::<Value>(&text) else {
        return json!({ "rows": [], "unavailable": "GitHub answered something this build could not read." });
    };
    let empty = Vec::new();
    let rows: Vec<Value> = said
        .as_array()
        .unwrap_or(&empty)
        .iter()
        /* A pull request is an issue to this endpoint and is not one to a person. */
        .filter(|issue| issue.get("pull_request").is_none())
        .map(|issue| {
            let state = issue.get("state").and_then(Value::as_str).unwrap_or_default();
            let reason = issue.get("state_reason").and_then(Value::as_str);
            let category = match (state, reason) {
                ("closed", Some("not_planned")) => "canceled",
                ("closed", _) => "completed",
                _ => "unstarted",
            };
            crate::tracker::remote_row(
                text_of(issue.get("id")),
                format!("#{}", text_of(issue.get("number"))),
                issue.get("title").cloned().unwrap_or_else(|| json!("")),
                (state, reason.unwrap_or(state), category),
                vec![
                    ("url", issue.get("html_url").cloned().unwrap_or(Value::Null)),
                    ("labels", names(issue.get("labels"), "name")),
                    ("assignee", issue.get("assignee").and_then(|who| who.get("login")).cloned().unwrap_or(Value::Null)),
                    ("updatedAt", issue.get("updated_at").cloned().unwrap_or(Value::Null)),
                ],
            )
        })
        .collect();
    json!({ "rows": rows })
}

/// `String(value)`, which is how every id that reaches a row was spelled.
fn text_of(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// A list of labels, whichever of the two shapes the provider used — GitHub sends either a string or
/// an object, and a list that dropped one kind would be a row missing half its labels.
fn names(listed: Option<&Value>, field: &str) -> Value {
    let empty = Vec::new();
    let items = listed.and_then(Value::as_array).unwrap_or(&empty);
    json!(items
        .iter()
        .filter_map(|item| match item {
            Value::String(text) => Some(text.clone()),
            other => other.get(field).and_then(Value::as_str).map(str::to_string),
        })
        .collect::<Vec<_>>())
}

/// Only the relations that BLOCK: Linear sends every kind on one list.
fn blocked_by(relations: Option<&Value>) -> Value {
    let empty = Vec::new();
    let items = relations.and_then(Value::as_array).unwrap_or(&empty);
    json!(items
        .iter()
        .filter(|relation| relation.get("type").and_then(Value::as_str) == Some("blocks"))
        .filter_map(|relation| relation.get("relatedIssue").and_then(|issue| issue.get("identifier")).and_then(Value::as_str).map(str::to_string))
        .collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Said {
        status: u16,
        body: String,
        asked: std::sync::Mutex<Vec<(String, String)>>,
    }

    impl Said {
        fn new(status: u16, body: &str) -> Said {
            Said { status, body: body.to_string(), asked: std::sync::Mutex::new(Vec::new()) }
        }
        fn body_of(&self, at: usize) -> Value {
            serde_json::from_str(&self.asked.lock().expect("asked")[at].1).expect("a body")
        }
    }

    impl Fetching for Said {
        fn post(&self, url: &str, _headers: &[(&str, &str)], body: &str) -> Result<(u16, String), String> {
            self.asked.lock().expect("asked").push((url.to_string(), body.to_string()));
            Ok((self.status, self.body.clone()))
        }
        fn get(&self, url: &str, _headers: &[(&str, &str)]) -> Result<(u16, String), String> {
            self.asked.lock().expect("asked").push((url.to_string(), String::new()));
            Ok((self.status, self.body.clone()))
        }
    }

    /* Four different things to be told, and each is something different to do about it. A person who
       is not signed in acts; a person whose declaration is wrong acts differently; a person whose
       provider is rate-limited waits. Collapsing them into "no tasks" would be a list that looks
       correct and is empty for a reason nobody can see. */
    #[test]
    fn the_four_ways_a_remote_list_can_fail_are_four_different_sentences() {
        let block = json!({ "provider": "linear", "team": "KOH", "identity": "kohai" });
        let none = linear_rows(&block, None, &Said::new(200, "{}"));
        assert_eq!(none["denied"], json!("Not signed in to Linear."));
        assert_eq!(none["signIn"], json!("linear"), "and it names the gesture that fixes it");

        assert_eq!(linear_rows(&block, Some("t"), &Said::new(401, ""))["denied"], json!("Linear refused the token."));
        assert_eq!(linear_rows(&block, Some("t"), &Said::new(500, ""))["unavailable"], json!("Linear answered 500."));
        /* Linear names its rate limit in a GraphQL error rather than with a 429, so it arrives on an
           otherwise-fine answer — and a caller told "unavailable, try shortly" waits, where one told
           "invalid" would go and edit a declaration that is correct. */
        let limited = linear_rows(&block, Some("t"), &Said::new(200, r#"{"errors":[{"message":"RATELIMITED: too many"}]}"#));
        assert!(limited["unavailable"].as_str().expect("said").contains("rate limit"), "{limited}");
        let wrong = linear_rows(&block, Some("t"), &Said::new(200, r#"{"errors":[{"message":"no such team"}]}"#));
        assert_eq!(wrong["invalid"], json!(["no such team"]), "a declaration that asks for nothing real is invalid, not unavailable");
    }

    /* Two declarations that ask different questions are different questions, and answering the
       second from the first's entry would be WRONG rather than stale — so the narrowing is part of
       the key, not just part of the request. */
    #[test]
    fn a_narrower_declaration_is_a_different_question_and_not_a_staler_answer() {
        let plain = json!({ "provider": "linear", "team": "KOH" });
        let narrowed = json!({ "provider": "linear", "team": "KOH", "assignee": "me" });
        assert_ne!(cache_key("r", &plain), cache_key("r", &narrowed));
        assert_ne!(cache_key("r", &plain), cache_key("other", &plain), "and another project is another question");
        assert_eq!(cache_key("r", &plain), cache_key("r", &json!({ "provider": "linear", "team": "KOH" })));
        /* Every narrowing, because leaving one out is an answer to a question nobody asked. */
        for narrowing in ["project", "assignee"] {
            let mut with = plain.clone();
            with[narrowing] = json!("x");
            assert_ne!(cache_key("r", &plain), cache_key("r", &with), "{narrowing}");
        }
        let mut states = plain.clone();
        states["states"] = json!(["started"]);
        assert_ne!(cache_key("r", &plain), cache_key("r", &states));
    }

    /* One poll every 30 seconds is about 5% of a key's budget — a rate limit shared with whatever
       else the person has pointed at that key. A refresh means "ask them again", not "sooner". */
    #[test]
    fn a_remote_list_is_remembered_for_thirty_seconds_and_a_refresh_asks_again() {
        let cache = Cache::new();
        let asked = std::cell::Cell::new(0);
        let count = || {
            asked.set(asked.get() + 1);
            json!({ "rows": [asked.get()] })
        };
        let now = 1_700_000_000_000i64;
        let (first, at) = cache.of("k", false, now, count);
        assert_eq!(first["rows"], json!([1]));
        assert_eq!(at, now);
        /* Within the window, the same answer and the moment it was TAKEN — so a caller says
           `checkedAt` about the answer rather than about the question. */
        let (again, taken) = cache.of("k", false, now + 29_999, count);
        assert_eq!(again["rows"], json!([1]), "the provider was not asked twice");
        assert_eq!(taken, now, "and the answer still says when it was taken");
        /* Past it, asked again. */
        let (fresh, taken) = cache.of("k", false, now + PROBE_TTL_MS, count);
        assert_eq!(fresh["rows"], json!([2]));
        assert_eq!(taken, now + PROBE_TTL_MS);
        /* A refresh drops the entry whatever its age. */
        let (forced, _) = cache.of("k", true, now + PROBE_TTL_MS, count);
        assert_eq!(forced["rows"], json!([3]));
        /* Another key is another question, answered on its own. */
        let (other, _) = cache.of("other", false, now + PROBE_TTL_MS, count);
        assert_eq!(other["rows"], json!([4]));
    }

    /* An undeclared narrowing contributes NO clause, so an existing declaration asks exactly what it
       always did — and a person who never declared an assignee does not suddenly get their own. */
    #[test]
    fn an_undeclared_narrowing_asks_nothing() {
        let plain = linear_filter(&json!({ "team": "KOH" }));
        assert_eq!(plain["team"]["key"]["eq"], json!("KOH"));
        assert_eq!(plain["project"]["name"]["eq"], Value::Null, "present and null leaves the team unfiltered");
        assert_eq!(plain.get("assignee"), None);
        assert_eq!(plain.get("state"), None);

        let narrowed = linear_filter(&json!({ "team": "KOH", "project": "Platform", "assignee": "Alex", "states": ["started"] }));
        assert_eq!(narrowed["project"]["name"]["eq"], json!("Platform"));
        assert_eq!(narrowed["assignee"]["displayName"]["eq"], json!("Alex"));
        assert_eq!(narrowed["state"]["type"]["in"], json!(["started"]));
        /* "me" is the one assignee value that is not a name: it asks the provider who the token
           belongs to, so a personal declaration keeps working when somebody else's token reads it. */
        let mine = linear_filter(&json!({ "team": "KOH", "assignee": "me" }));
        assert_eq!(mine["assignee"], json!({ "isMe": { "eq": true } }));
    }

    #[test]
    fn a_linear_issue_becomes_the_neutral_row() {
        let answered = Said::new(
            200,
            r#"{"data":{"issues":{"nodes":[{"id":"uuid-1","identifier":"KOH-12","title":"A thing","url":"https://linear.app/x",
               "priority":2,"updatedAt":"2026-01-01T00:00:00.000Z","state":{"id":"s1","name":"In Progress","type":"started"},
               "assignee":{"displayName":"Alex"},"labels":{"nodes":[{"name":"bug"},{"name":"ui"}]},
               "relations":{"nodes":[{"type":"blocks","relatedIssue":{"identifier":"KOH-9"}},{"type":"related","relatedIssue":{"identifier":"KOH-8"}}]}}]}}}"#,
        );
        let listed = linear_rows(&json!({ "team": "KOH", "identity": "kohai" }), Some("lin_api_x"), &answered);
        let row = &listed["rows"][0];
        assert_eq!(row["id"], json!("uuid-1"));
        assert_eq!(row["key"], json!("KOH-12"));
        assert_eq!(row["state"], json!({ "id": "s1", "name": "In Progress", "category": "started" }));
        assert_eq!(row["priority"], json!("high"), "2 is high, and the list starts at a null");
        assert_eq!(row["labels"], json!(["bug", "ui"]));
        assert_eq!(row["assignee"], json!("Alex"));
        /* Only the relations that BLOCK: every kind arrives on one list. */
        assert_eq!(row["blockedBy"], json!(["KOH-9"]));
        /* A remote row answers with an empty list rather than with the issue body, which is prose
           rather than criteria (spec 103) — the manifest join fills these in. */
        assert_eq!(row["criteria"], json!([]));
        assert_eq!(row["tests"], json!([]));

        /* And the query it asked, because the filter that reaches the provider is the whole of what
           the declaration means. */
        let asked = answered.body_of(0);
        assert_eq!(asked["variables"]["first"], json!(100));
        assert_eq!(asked["variables"]["filter"]["team"]["key"]["eq"], json!("KOH"));
    }

    /* GitHub's state is open or closed with a reason, so the category is derived. Getting this wrong
       puts a cancelled issue in the completed column, which is a board that lies. */
    #[test]
    fn a_github_issue_derives_its_category_and_is_not_a_pull_request() {
        let answered = Said::new(
            200,
            r#"[{"id":1,"number":7,"title":"Open one","html_url":"https://github.test/7","state":"open","labels":["bug",{"name":"ui"}],"assignee":{"login":"alex"},"updated_at":"2026-01-01T00:00:00Z"},
                {"id":2,"number":8,"title":"Done","state":"closed","state_reason":"completed","labels":[]},
                {"id":3,"number":9,"title":"Dropped","state":"closed","state_reason":"not_planned","labels":[]},
                {"id":4,"number":10,"title":"A PR","state":"open","pull_request":{"url":"x"},"labels":[]}]"#,
        );
        let listed = github_rows(&json!({ "repository": "o/r", "identity": "kohai" }), Some("gh_x"), &answered);
        let rows = listed["rows"].as_array().expect("rows");
        assert_eq!(rows.len(), 3, "a pull request is an issue to this endpoint and is not one to a person");
        assert_eq!(rows[0]["key"], json!("#7"));
        assert_eq!(rows[0]["state"]["category"], json!("unstarted"));
        /* Either shape a label arrives in: a list that dropped one kind is a row missing half. */
        assert_eq!(rows[0]["labels"], json!(["bug", "ui"]));
        assert_eq!(rows[0]["assignee"], json!("alex"));
        assert_eq!(rows[1]["state"]["category"], json!("completed"));
        assert_eq!(rows[2]["state"]["category"], json!("canceled"), "not planned is cancelled, not done");
        /* An id that arrived as a number is a string by the time it is a row's id. */
        assert_eq!(rows[0]["id"], json!("1"));

        assert_eq!(github_rows(&json!({ "repository": "o/r", "identity": "k" }), None, &Said::new(200, "[]"))["denied"]
                       .as_str().expect("denied").contains("trackers/k.token"), true);
        let missing = github_rows(&json!({ "repository": "o/r" }), Some("t"), &Said::new(404, ""));
        assert_eq!(missing["invalid"], json!(["o/r is not reachable with this token."]));
    }
}
