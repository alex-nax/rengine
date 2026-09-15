//! `/surface`: a viewer's end of a game's pane (F155/F189, spec 142).
//!
//! The door already speaks WebSocket for `/events`; this is the other socket, and it is a different
//! shape. `/events` fans one workspace's news out to every viewer; a surface belongs to ONE pane and
//! carries its frames as binary, so a viewer names the session it wants and gets that game's
//! pictures and nothing else.
//!
//! The messages a viewer sends are JSON input events. They go through `surfaces::from_viewer`,
//! which owns the focus rule — including the part where a viewer that is not the owner is ignored
//! rather than refused, so a pane the person has left learns nothing about the one they are in.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc::unbounded_channel;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Message, Role};
use tokio_tungstenite::WebSocketStream;

use crate::surfaces::ToViewer;
use crate::Front;

/// One viewer, from its upgrade to its close. `session` is the pane it asked for.
pub async fn serve<S>(front: Arc<Front>, stream: S, session: String)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let socket = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
    let (mut writing, mut reading) = socket.split();

    /* A session with no surface behind it is closed with the JS host's own code and sentence: the
       desktop shows that reason, so it is part of the contract rather than a log line. */
    let (Some(surfaces), Some(token)) = (
        front.surfaces.clone(),
        front.surfaces.as_ref().and_then(|surfaces| surfaces.token_of(&session)),
    ) else {
        let _ = writing
            .send(Message::Close(Some(CloseFrame {
                code: CloseCode::Policy,
                reason: "Game session is unavailable".into(),
            })))
            .await;
        let _ = writing.close().await;
        return;
    };

    let (out, mut queue) = unbounded_channel::<ToViewer>();
    let viewer = front.next_viewer();
    surfaces.attach(&token, viewer, out);

    let writer = tokio::spawn(async move {
        while let Some(message) = queue.recv().await {
            let message = match message {
                ToViewer::Text(text) => Message::Text(text.into()),
                ToViewer::Binary(bytes) => Message::Binary(bytes.into()),
            };
            if writing.send(message).await.is_err() {
                break;
            }
        }
        let _ = writing.close().await;
    });

    while let Some(Ok(message)) = reading.next().await {
        /* Input is JSON. Binary from a viewer is the producer's direction, not this one, and the
           JavaScript answers it with the same sentence rather than dropping it silently — a client
           sending frames at the door has misunderstood which end it is. */
        let said = match message {
            Message::Text(text) => text.to_string(),
            Message::Binary(_) => {
                surfaces.tell_viewer(&token, viewer, "Expected game input JSON.");
                continue;
            }
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&said) else {
            surfaces.tell_viewer(&token, viewer, "Unexpected end of JSON input");
            continue;
        };
        let kind = parsed.get("kind").and_then(Value::as_i64).unwrap_or(i64::MIN);
        let values: Vec<i32> = parsed
            .get("values")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_i64).map(|value| value as i32).collect())
            .unwrap_or_default();
        let outside = kind < i32::MIN as i64 || kind > i32::MAX as i64;
        let refusal = if outside {
            Err("Unsupported game input.".to_string())
        } else {
            surfaces.from_viewer(&token, viewer, kind as i32, &values)
        };
        if let Err(message) = refusal {
            surfaces.tell_viewer(&token, viewer, &message);
        }
    }
    surfaces.detach(&token, viewer);
    writer.abort();
}
