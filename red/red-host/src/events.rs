//! The `/events` socket, served by the door (F189, spec 129).
//!
//! This is the workspace's one live channel to a person's screen: a pane's output arrives on it,
//! `attach` answers with the scrollback so a reconnecting desktop rebuilds rather than resumes
//! (specs 059/060), and the native desktop registers itself on it so the workspace can ask it to
//! reload. Every message shape here is the JS host's, because the desktop on the other end is not
//! changing: `hello`, `attached`, `session`, `output`, `error`, and the desktop frames.
//!
//! What a viewer never gets is a service's answer verbatim. The pane is composed into the host's
//! own snapshot first — the scrollback written from UTF-16, absence meaning absence — so a client
//! cannot tell which host is answering.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Message, Role};
use tokio_tungstenite::WebSocketStream;

use crate::{pane_answer, pane_snapshot, Front};

/// One viewer's end of the socket, from the outside: what it is attached to, and a queue that is
/// allowed to fall behind only so far.
pub struct Viewer {
    out: UnboundedSender<Message>,
    /// Bytes handed to the writer and not yet written. The JS host reads `bufferedAmount` for this
    /// and closes at four megabytes; a queue that grows without bound is a host holding a dead
    /// client's scrollback forever.
    queued: Arc<AtomicUsize>,
    attached: Mutex<HashSet<String>>,
}

impl Viewer {
    pub fn say(&self, text: String) {
        self.queued.fetch_add(text.len(), Ordering::SeqCst);
        let _ = self.out.send(Message::Text(text.into()));
    }

    fn behind(&self) -> bool {
        self.queued.load(Ordering::SeqCst) > 4 * 1024 * 1024
    }

    fn close(&self, code: CloseCode, reason: &str) {
        let _ = self.out.send(Message::Close(Some(CloseFrame { code, reason: reason.into() })));
    }
}

/// Every viewer on this door, and the one thing they all want: what happened to a pane.
pub struct Hub {
    viewers: Mutex<HashMap<u64, Arc<Viewer>>>,
    next: AtomicU64,
}

impl Hub {
    pub fn new() -> Hub {
        Hub { viewers: Mutex::new(HashMap::new()), next: AtomicU64::new(0) }
    }

    /// One line to everyone, the way the JS host fans out: a client too far behind is closed with
    /// 1013 and told to reconnect, because the scrollback it lost is in the attach snapshot.
    pub fn broadcast(&self, text: &str) {
        let viewers: Vec<Arc<Viewer>> = self.viewers.lock().expect("viewers lock").values().cloned().collect();
        for viewer in viewers {
            if viewer.behind() {
                viewer.close(CloseCode::Again, "Reconnect to recover retained output");
            } else {
                viewer.say(text.to_string());
            }
        }
    }

    /// A pane changed: everyone hears it in the host's own snapshot shape.
    pub fn pane(&self, session: &Value) {
        self.broadcast(&json!({ "type": "session", "session": pane_snapshot(session) }).to_string());
    }

    fn join(&self, viewer: Arc<Viewer>) -> u64 {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        self.viewers.lock().expect("viewers lock").insert(id, viewer);
        id
    }

    fn leave(&self, id: u64) {
        self.viewers.lock().expect("viewers lock").remove(&id);
    }

    /// Which connection this viewer is, for the desktop registry: two registrations from one socket
    /// are one desktop, and a socket that has gone is a desktop that has gone with it.
    pub fn identify(&self, viewer: &Arc<Viewer>) -> Option<u64> {
        self.viewers
            .lock()
            .expect("viewers lock")
            .iter()
            .find(|(_, known)| same(known, viewer))
            .map(|(id, _)| *id)
    }
}

/// The 101 the JS host would have written, from the key the client sent. Everything after it is
/// frames, and tungstenite takes the socket over as it stands.
pub fn accepted(key: &str) -> String {
    format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
        tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes())
    )
}

pub async fn serve<S>(front: Arc<Front>, stream: S)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let socket = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
    let (mut writing, mut reading) = socket.split();
    let (out, mut queue) = unbounded_channel::<Message>();
    let queued = Arc::new(AtomicUsize::new(0));
    let viewer = Arc::new(Viewer { out, queued: queued.clone(), attached: Mutex::new(HashSet::new()) });
    let id = front.hub.join(viewer.clone());
    let writer = tokio::spawn(async move {
        while let Some(message) = queue.recv().await {
            let size = message.len();
            let closing = matches!(message, Message::Close(_));
            if writing.send(message).await.is_err() {
                break;
            }
            queued.fetch_sub(size.min(queued.load(Ordering::SeqCst)), Ordering::SeqCst);
            if closing {
                break;
            }
        }
        let _ = writing.close().await;
    });
    /* The JS host greets a connection before it is asked anything, and the desktop waits for it. */
    viewer.say(json!({ "type": "hello", "instance": front.instance }).to_string());
    while let Some(Ok(message)) = reading.next().await {
        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Binary(_) => continue,
            Message::Close(_) => break,
            _ => continue,
        };
        if let Err(refusal) = handle(&front, &viewer, &text).await {
            viewer.say(json!({ "type": "error", "error": refusal }).to_string());
        }
    }
    front.hub.leave(id);
    front.desktops.disconnected(id);
    let _ = viewer.out.send(Message::Close(None));
    let _ = writer.await;
}

/// One message from a viewer. The error half of the result is the JS host's `{type: 'error'}`,
/// which is how every refusal on this socket reaches a person.
async fn handle(front: &Arc<Front>, viewer: &Arc<Viewer>, text: &str) -> Result<(), String> {
    let message: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    let kind = message.get("type").and_then(Value::as_str).unwrap_or_default();
    let id = message.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    match kind {
        "attach" => {
            let session = crate::ask_pty(front, "snapshot", json!([id])).await.map_err(crate::plain)?;
            /* The scrollback goes out as text this process wrote itself: a lone surrogate at a
               chunk boundary is a legal JS string and not a legal Rust one. */
            viewer.say(format!("{{\"type\":\"attached\",\"session\":{}}}", pane_answer(&session, true)));
            viewer.attached.lock().expect("attached lock").insert(id);
            Ok(())
        }
        "presented" => {
            if !viewer.attached.lock().expect("attached lock").contains(&id) {
                return Err("Attach the session before presenting it.".to_string());
            }
            crate::present(front, &id).await
        }
        "desktop-register" => front.desktops.register(front, viewer.clone(), &message).await,
        "desktop-action-result" => front.desktops.acknowledge(viewer, &message),
        "input" => crate::deliver_input(front, &message).await.map_err(crate::plain),
        "resize" => crate::deliver_resize(front, &message).await.map_err(crate::plain),
        _ => Err("Unknown session message.".to_string()),
    }
}

/// The viewer this hub knows by identity, for the desktop registry: two registrations from one
/// socket are one desktop.
pub fn same(left: &Arc<Viewer>, right: &Arc<Viewer>) -> bool {
    Arc::ptr_eq(left, right)
}

/// A socket with bytes already read off it. Reading a request head can take the first frame with it
/// — a client is not supposed to send one before the handshake answer, but a door that dropped it
/// if it did would lose a message with no trace, which is not a thing to leave to convention.
pub struct Prefixed<S> {
    pub buffered: Vec<u8>,
    pub inner: S,
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if !self.buffered.is_empty() {
            let take = self.buffered.len().min(out.remaining());
            let head: Vec<u8> = self.buffered.drain(..take).collect();
            out.put_slice(&head);
            return std::task::Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut self.inner).poll_read(context, out)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        bytes: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.inner).poll_write(context, bytes)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(context)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(context)
    }
}
